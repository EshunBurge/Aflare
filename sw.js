/* Aflare service worker
   - Caches the app shell so Aflare opens instantly and works offline
   - Caches map tiles you've already viewed
   - Shows notifications and (on Android/Chrome) checks for fires in the background
   Live fire/weather data is never cached here; the app keeps its own "last known" copy. */
const VERSION = 'aflare-v2.3.6';
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = 'aflare-tiles';
const FONT_CACHE = 'aflare-fonts';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'lib/leaflet.js', 'lib/leaflet.css',
  'lib/firebase/firebase-app-compat.js', 'lib/firebase/firebase-auth-compat.js', 'lib/firebase/firebase-firestore-compat.js',
  'img/mark.png', 'img/wordmark.png', 'img/learn/featured.jpg',
  ...['defensible-space', 'home-hardening', 'how-fires-spread', 'evac-plan', 'red-flag', 'smoke-health', 'satellite'].map((n) => `img/learn/${n}-thumb.jpg`),
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-48.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('aflare-v') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(req, cacheName, ms) {
  const cache = await caches.open(cacheName);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

async function tileFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone());
      cache.keys().then((keys) => { if (keys.length > 600) cache.delete(keys[0]); });   // keep storage small
    }
    return res;
  } catch (err) { return Response.error(); }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (req.mode === 'navigate') return e.respondWith(networkFirst(req, SHELL_CACHE, 3500));
    if (url.pathname.endsWith('/config.js')) return e.respondWith(networkFirst(req, SHELL_CACHE, 2500));
    return e.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
  if (/(basemaps\.cartocdn\.com|tile\.openstreetmap\.org)$/.test(url.hostname) || (url.hostname === 'server.arcgisonline.com' && url.pathname.includes('/tile/'))) return e.respondWith(tileFirst(req));
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return e.respondWith(staleWhileRevalidate(req, FONT_CACHE));
  /* everything else (data APIs, YouTube) goes straight to the network */
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.postMessage({ type: 'open', url: target }); return; }
    await self.clients.openWindow(target);
  })());
});

/* ---------- background fire check (Chrome/Android installed app only) ---------- */
function idbGet(key) {
  return new Promise((res) => {
    const r = indexedDB.open('aflare', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(null);
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get(key); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); };
  });
}
function idbPut(key, val) {
  return new Promise((res) => {
    const r = indexedDB.open('aflare', 1);
    r.onerror = () => res(); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = res; };
  });
}
const rad = (d) => (d * Math.PI) / 180;
function dist(a, b, c, d) { const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2; return 3958.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }

/* Checks each saved place (up to 6) for new satellite heat within the alert radius.
   Only runs when the browser grants periodic background sync (installed Chrome / Android). */
async function checkFires() {
  const s = await idbGet('settings');
  if (!s || !s.signedIn || !s.push) return;
  const places = (s.places && s.places.length ? s.places : s.home ? [s.home] : []).slice(0, 6);
  const R = s.radius || 25;
  const seen = (await idbGet('seen')) || {};
  let sent = 0;
  for (const pl of places) {
    const { lat, lng } = pl;
    const dLat = R / 69, dLng = R / (69 * Math.max(0.1, Math.cos(rad(lat))));
    const p = new URLSearchParams({
      where: 'hours_old<=12', geometry: `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`, geometryType: 'esriGeometryEnvelope', inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', outFields: 'latitude,longitude,frp,confidence,esritimeutc', resultRecordCount: 2000, f: 'json',
    });
    let feats;
    try { feats = (await (await fetch('https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query?' + p)).json()).features || []; } catch (e) { continue; }
    const cells = new Map();
    for (const f of feats) {
      const a = f.attributes; if (s.highConfOnly && String(a.confidence).toLowerCase().startsWith('l')) continue;
      const k = Math.floor(a.latitude / 0.05) + ':' + Math.floor(a.longitude / 0.05);
      const c = cells.get(k) || { sLat: 0, sLng: 0, n: 0, max: 0, t: 0 };
      c.sLat += a.latitude; c.sLng += a.longitude; c.n++; c.max = Math.max(c.max, a.frp || 0); c.t = Math.max(c.t, a.esritimeutc || 0); cells.set(k, c);
    }
    for (const c of [...cells.values()].map((c) => ({ lat: c.sLat / c.n, lng: c.sLng / c.n, n: c.n, max: c.max, t: c.t })).sort((a, b) => dist(lat, lng, a.lat, a.lng) - dist(lat, lng, b.lat, b.lng))) {
      const d = dist(lat, lng, c.lat, c.lng); if (d > R || sent >= 3) continue;
      const id = `hs:${c.lat.toFixed(2)},${c.lng.toFixed(2)}:${new Date(c.t || Date.now()).toISOString().slice(0, 10)}`;
      if (seen[id]) continue;
      seen[id] = Date.now(); sent++;
      await self.registration.showNotification(`Satellite heat detected ${d.toFixed(1)} mi from ${pl.label}`, {
        body: `Unconfirmed · ${c.n} detection${c.n > 1 ? 's' : ''}. Tap to see the map.`, tag: id, icon: 'icons/icon-192.png', badge: 'icons/favicon-48.png', data: { url: './?screen=map' },
      });
    }
  }
  if (sent) await idbPut('seen', seen);
}
self.addEventListener('periodicsync', (e) => { if (e.tag === 'aflare-check') e.waitUntil(checkFires()); });
