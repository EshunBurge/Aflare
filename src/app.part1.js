'use strict';
/* =========================================================================
   Aflare — satellite fire alerts (web app / PWA)
   Sections: 1 Helpers · 2 Storage · 3 Accounts · 4 Location · 5 Live data
             6 Derived info & alerts · 7 Learn content
   (UI, map and screens continue below in the second half of this file.)
   ========================================================================= */

const VERSION = '2.3.6';
const CFG = Object.assign({ firebase: null }, window.AFLARE_CONFIG || {});

/* ---------------------------------------------------------------- 1 Helpers */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Great-circle distance in miles (haversine formula). */
function distMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compass direction (N, NE, …) from point 1 toward point 2. */
function compass(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function ago(ts) {
  if (!ts) return 'unknown time';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function fmtMi(mi) { return (mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()) + ' mi'; }

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** fetch + JSON with a timeout so a slow service can't freeze the UI. */
async function getJSON(url, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* --------------------------------------------------------------- 2 Storage */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('aflare.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    const val = JSON.stringify(v);
    try { localStorage.setItem('aflare.' + k, val); }
    catch (e) {
      // Storage full: drop saved satellite points for other places (they are re-downloaded when needed) and try once more.
      try { Object.keys(localStorage).filter((x) => x.startsWith('aflare.cache.nearby.') && x !== 'aflare.' + k).forEach((x) => localStorage.removeItem(x)); localStorage.setItem('aflare.' + k, val); }
      catch (e2) { /* private mode or still full — the app keeps working from memory */ }
    }
  },
  del(k) { try { localStorage.removeItem('aflare.' + k); } catch (e) { /* ignore */ } },
};

/* The service worker can't read localStorage, so the few settings it needs
   for background checks are mirrored into IndexedDB. */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('aflare', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) { /* IndexedDB unavailable — background checks just won't run */ }
}

/** The per-user data object that is saved locally and (optionally) to Firestore. */
function defaultData() {
  return {
    profile: { name: '' },
    locations: [],          // {id,label,place,lat,lng,country,default}
    contacts: [],           // {id,name,phone}
    settings: { push: false, wxAlerts: true, highConfOnly: false, radius: 25 },
    checklist: {},          // {itemId: timestamp done}
  };
}

/* Older versions stored the checklist as a 5-item true/false array. */
const OLD_CHECKLIST_IDS = ['zone0', 'alarms', 'gobag', 'nonemerg', 'routes'];
function normalizeData(d) {
  const out = Object.assign(defaultData(), d || {});
  out.settings = Object.assign(defaultData().settings, out.settings);
  if (Array.isArray(out.checklist)) {
    const m = {}; out.checklist.forEach((v, i) => { if (v && OLD_CHECKLIST_IDS[i]) m[OLD_CHECKLIST_IDS[i]] = Date.now(); });
    out.checklist = m;
  } else if (!out.checklist || typeof out.checklist !== 'object') out.checklist = {};
  if (!Array.isArray(out.locations)) out.locations = [];
  if (!Array.isArray(out.contacts)) out.contacts = [];
  return out;
}

let me = null;              // {id, email, name, mode:'local'|'cloud'}
let data = defaultData();
let feed = [];              // notification feed (device-local)
let seen = {};              // ids already announced, so we never alert twice

const userKey = () => (me ? me.id : '_');

function saveData() {
  if (!me) return;
  LS.set('data.' + userKey(), data);
  mirrorForServiceWorker();
  if (me.mode === 'cloud') cloudSaveSoon();
}

function mirrorForServiceWorker() {
  const h = homeLoc();
  const places = data.locations.slice(0, 6).map((l) => ({ lat: l.lat, lng: l.lng, label: placeName(l) }));
  idbSet('settings', { home: h ? { lat: h.lat, lng: h.lng, label: placeName(h) } : null, places, ...data.settings, signedIn: !!me });
}

function saveFeed() { LS.set('feed.' + userKey(), feed.slice(0, 40)); LS.set('seen.' + userKey(), seen); idbSet('seen', seen); }

function homeLoc() { return data.locations.find((l) => l.default) || data.locations[0] || null; }
/** Human-friendly name for a saved place ("Pasadena, California" rather than the label "Home"). */
const placeName = (l) => (l ? l.place || l.label : '');

/* -------------------------------------------------------------- 3 Accounts */
/* Two modes:
     • cloud  — Firebase Auth + Firestore (when config.js has a firebase config)
     • local  — account stored on this device (password salted + SHA-256)    */
let fbAuth = null, fbDb = null, fbReady = false, signingUp = false;
const fbConfigured = () => !!(CFG.firebase && CFG.firebase.apiKey && !/REPLACE|YOUR_/i.test(CFG.firebase.apiKey));

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
}

async function initFirebase() {
  if (!fbConfigured()) return false;
  try {
    // The SDK files ship inside the app (lib/firebase) so sign-in screens work offline too.
    await loadScript('lib/firebase/firebase-app-compat.js');
    await loadScript('lib/firebase/firebase-auth-compat.js');
    await loadScript('lib/firebase/firebase-firestore-compat.js');
    firebase.initializeApp(CFG.firebase);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    fbReady = true;
    $('fbBanner').style.display = 'none';
    document.querySelectorAll('.googleonly').forEach((el) => (el.style.display = ''));
    return true;
  } catch (e) {
    console.error('Firebase failed to start; falling back to on-device accounts', e);
    return false;
  }
}

function friendlyAuthError(err) {
  const map = {
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/requires-recent-login': 'For security, log out and back in, then try again.',
  };
  return map[err && err.code] || (err && err.message) || 'Something went wrong. Please try again.';
}

function showAuthErr(id, msg) { const el = $(id); el.textContent = msg; el.classList.toggle('show', !!msg); }
function markField(id, bad) { const f = $(id) && $(id).closest('.field'); if (f) f.classList.toggle('err', !!bad); }

async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; // very weak fallback (insecure contexts only)
  return 'x' + h.toString(16);
}
const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

function loadLocalData(key) {
  data = normalizeData(LS.get('data.' + key, {}));
  feed = LS.get('feed.' + key, []);
  seen = LS.get('seen.' + key, {});
}

/* Cloud sync status, shown honestly on the profile screen. */
const sync = { state: 'idle', at: 0 };   // idle | saving | saved | error | offline-copy
function setSync(st) { sync.state = st; if (st === 'saved') sync.at = Date.now(); if (typeof renderSyncLine === 'function') renderSyncLine(); }

async function loadCloudData(user) {
  data = defaultData();
  data.profile.name = user.displayName || '';
  try {
    const snap = await fbDb.collection('users').doc(user.uid).get();
    if (snap.exists && snap.data().data) data = normalizeData(snap.data().data);
    setSync('saved');
  } catch (e) {
    console.error('Could not read cloud profile', e);
    toast('Could not reach your synced profile — using this device\'s copy');
    const cached = LS.get('data.' + user.uid); if (cached) data = normalizeData(cached);
    setSync('offline-copy');
  }
  if (!data.profile.name) data.profile.name = user.displayName || user.email.split('@')[0];
  feed = LS.get('feed.' + user.uid, []);
  seen = LS.get('seen.' + user.uid, {});
}

const cloudSaveNow = async () => {
  if (!me || me.mode !== 'cloud' || !fbDb) return;
  setSync('saving');
  // A full set (not merge) so removed items — an unticked checklist item, a deleted photo — are removed in the cloud too.
  try { await fbDb.collection('users').doc(me.id).set({ data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); setSync('saved'); }
  catch (e) { console.error('Cloud save failed', e); setSync('error'); toast('Saved on this device only — sync failed. Aflare will try again.', 3600); }
};
const cloudSaveSoon = debounce(cloudSaveNow, 800);

/** Resolves once we know whether someone is already signed in. */
function restoreSession() {
  if (fbReady) {
    return new Promise((resolve) => {
      let first = true;
      fbAuth.onAuthStateChanged(async (user) => {
        if (user && signingUp) { if (first) { first = false; resolve(); } return; }   // submitSignup sets everything up itself
        if (user) {
          me = { id: user.uid, email: user.email, name: user.displayName || '', mode: 'cloud' };
          await loadCloudData(user);
          me.name = data.profile.name;
          LS.set('data.' + me.id, data);
          if (!first) enterApp(true);
        } else if (!first && me) { me = null; data = defaultData(); feed = []; seen = {}; setSync('idle'); routeToAuth(); }
        if (first) { first = false; resolve(); }
      });
    });
  }
  const key = LS.get('session');
  const accounts = LS.get('accounts', {});
  if (key && accounts[key]) {
    me = { id: key, email: key, name: accounts[key].name, mode: 'local' };
    loadLocalData(key);
  }
  return Promise.resolve();
}

async function submitLogin(btn) {
  const email = $('loginEmail').value.trim().toLowerCase();
  const password = $('loginPassword').value;
  showAuthErr('loginErr', '');
  markField('loginEmail', !email); markField('loginPassword', !password);
  if (!email || !password) return showAuthErr('loginErr', 'Enter your email and password.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { markField('loginEmail', true); return showAuthErr('loginErr', "That email address doesn't look right."); }
  if (btn.classList.contains('loading')) return;   // already signing in
  btn.classList.add('loading');
  try {
    if (fbReady) {
      await fbAuth.signInWithEmailAndPassword(email, password);  // onAuthStateChanged does the rest
    } else {
      const acc = LS.get('accounts', {})[email];
      if (!acc || (await sha256(acc.salt + password)) !== acc.hash) throw { message: 'Incorrect email or password.' };
      me = { id: email, email, name: acc.name, mode: 'local' };
      LS.set('session', email);
      loadLocalData(email);
      enterApp(true);
    }
  } catch (err) { showAuthErr('loginErr', friendlyAuthError(err)); }
  btn.classList.remove('loading');
}

async function submitSignup(btn) {
  const name = $('signupName').value.trim();
  const email = $('signupEmail').value.trim().toLowerCase();
  const password = $('signupPassword').value;
  const place = $('signupLocation').value.trim();
  const wantAlerts = $('signupAlerts').classList.contains('on');
  showAuthErr('signupErr', '');
  markField('signupName', !name); markField('signupEmail', !email); markField('signupPassword', password.length < 6);
  if (!name || !email || !password) return showAuthErr('signupErr', 'Fill in your name, email and password.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showAuthErr('signupErr', "That email address doesn't look right.");
  if (password.length < 6) return showAuthErr('signupErr', 'Password should be at least 6 characters.');
  if (btn.classList.contains('loading')) return;   // already creating the account
  btn.classList.add('loading');

  // Ask for notification permission now, while the tap still counts as a user gesture.
  let granted = false;
  if (wantAlerts && 'Notification' in window && Notification.permission === 'default' && (!isIOS || isStandalone())) {
    try { granted = (await Notification.requestPermission()) === 'granted'; } catch (e) { /* ignore */ }
  } else if (wantAlerts && 'Notification' in window) { granted = Notification.permission === 'granted'; }

  try {
    if (fbReady) {
      signingUp = true;
      const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: name });
      cred.user.sendEmailVerification().catch(() => {});
      me = { id: cred.user.uid, email, name, mode: 'cloud' };
      data = defaultData();
    } else {
      const accounts = LS.get('accounts', {});
      if (accounts[email]) throw { message: 'An account with that email already exists.' };
      const salt = randomSalt();
      accounts[email] = { name, salt, hash: await sha256(salt + password), created: Date.now() };
      LS.set('accounts', accounts); LS.set('session', email);
      me = { id: email, email, name, mode: 'local' };
      data = defaultData(); feed = []; seen = {};
    }
    data.profile.name = name;
    data.settings.push = granted;
    if (place) {
      const g = await geocode(place).catch(() => null);
      if (g) data.locations = [{ id: 'loc' + Date.now(), label: 'Home', place: g.label, lat: g.lat, lng: g.lng, country: g.country, county: g.county || '', state: g.state || '', default: true }];
      else toast("Couldn't find that address — you can set your location from Home.");
    }
    saveData();
    enterApp(true);
  } catch (err) { showAuthErr('signupErr', friendlyAuthError(err)); }
  signingUp = false;
  btn.classList.remove('loading');
}

async function googleSignIn() {
  if (!fbReady) return;
  try { await fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (err) { if (err.code !== 'auth/popup-closed-by-user') toast(friendlyAuthError(err)); }
}

async function forgotPassword() {
  const email = $('loginEmail').value.trim();
  if (!fbReady) return toast('Password reset needs a synced (Firebase) account. On-device accounts can\'t be reset by email.', 4200);
  if (!email) return toast('Type your email above first');
  try { await fbAuth.sendPasswordResetEmail(email); toast('Password reset email sent'); } catch (e) { toast(friendlyAuthError(e)); }
}

async function logOut() {
  closeSheets();
  if (me && me.mode === 'cloud' && fbReady) { await fbAuth.signOut(); /* listener routes to auth */ return; }
  LS.del('session'); me = null; data = defaultData(); feed = []; seen = {};
  routeToAuth();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), account: { email: me.email, name: data.profile.name }, ...data, notifications: feed }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'aflare-my-data.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Your data was downloaded');
}

async function deleteAccount() {
  if (!(await confirmSheet('Delete your account?', '<p>This permanently deletes your Aflare account, saved locations, contacts and settings. <b>This cannot be undone.</b></p><p>Tip: use <b>Export my data</b> first if you want a copy.</p>', 'Delete forever', true))) return;
  try {
    if (me.mode === 'cloud') {
      await fbDb.collection('users').doc(me.id).delete();
      await fbAuth.currentUser.delete();
    } else {
      const accounts = LS.get('accounts', {}); delete accounts[me.id]; LS.set('accounts', accounts); LS.del('session');
    }
    ['data.', 'feed.', 'seen.'].forEach((p) => LS.del(p + me.id));
    me = null; data = defaultData(); feed = []; seen = {};
    toast('Account deleted'); routeToAuth();
  } catch (e) {
    if (e && e.code === 'auth/requires-recent-login') showInfo('Please sign in again', '<p>For security, Firebase needs a recent sign-in before an account can be deleted. Log out, log back in, then delete your account from Privacy, Data &amp; About.</p>', '<button class="btn secondary" onclick="closeSheets()"><span class="label">Cancel</span></button><button class="btn" onclick="logOut()"><span class="label">Log out now</span></button>');
    else toast(friendlyAuthError(e), 4000);
  }
}

/* ------------------------------------------------------------- 4 Location */
function getPosition(opts) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('This device can\'t share its location.'));
    navigator.geolocation.getCurrentPosition(res, rej, Object.assign({ enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }, opts));
  });
}

function placeLabel(a) {
  const town = a.city || a.town || a.village || a.suburb || a.hamlet || a.county || '';
  const region = a.state || a.region || a.country || '';
  return [town, region].filter(Boolean).join(', ') || 'Pinned location';
}

/** Address → coordinates (OpenStreetMap Nominatim). Only called from a user action. */
async function geocode(q) {
  const key = 'geo.' + q.toLowerCase();
  const hit = LS.get(key); if (hit) return hit;
  const res = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=' + encodeURIComponent(q));
  if (!res.length) return null;
  const r = res[0];
  const a = r.address || {};
  const out = { lat: +r.lat, lng: +r.lon, label: placeLabel(a), country: (a.country_code || '').toLowerCase(), county: a.county || '', state: a.state || '' };
  LS.set(key, out); return out;
}

/** Coordinates → address. */
async function reverseGeocode(lat, lng) {
  const key = 'rev.' + lat.toFixed(3) + ',' + lng.toFixed(3);
  const hit = LS.get(key); if (hit) return hit;
  const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&addressdetails=1&lat=${lat}&lon=${lng}`);
  const a = r.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const out = { label: placeLabel(a), street, full: r.display_name || '', country: (a.country_code || '').toLowerCase(), county: a.county || '', state: a.state || '' };
  LS.set(key, out); return out;
}

/* --------------------------------------------------------- 5 Live data */
/* NASA FIRMS VIIRS 375 m hotspots, republished by Esri (CORS-enabled; NASA's
   own CSV feeds can't be fetched directly from a web page). */
const HOTSPOT_URL = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query';
/* NIFC (National Interagency Fire Center) current incidents & perimeters — US only. */
const INCIDENT_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';
const PERIMETER_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';

function bboxAround(lat, lng, miles) {
  const dLat = miles / 69, dLng = miles / (69 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { w: clamp(lng - dLng, -180, 180), s: clamp(lat - dLat, -90, 90), e: clamp(lng + dLng, -180, 180), n: clamp(lat + dLat, -90, 90) };
}

/* Optional: pull hotspots straight from NASA's FIRMS Area API through your own
   tiny proxy (see nasa-proxy/worker.js). Set `nasa.proxyUrl` in config.js. */
function nasaProxyUrl() { const n = (window.AFLARE_CONFIG || {}).nasa; return n && n.proxyUrl && !/REPLACE|YOUR_/i.test(n.proxyUrl) ? n.proxyUrl.replace(/\/+$/, '') : null; }

function parseFirmsCsv(text, maxAgeHours, limit) {
  const lines = text.trim().split(/\r?\n/); if (lines.length < 2) return [];
  const head = lines[0].split(','), ix = (k) => head.indexOf(k), now = Date.now(), out = [];
  const iLat = ix('latitude'), iLng = ix('longitude'), iFrp = ix('frp'), iConf = ix('confidence'), iDate = ix('acq_date'), iTime = ix('acq_time'), iSat = ix('satellite'), iDn = ix('daynight');
  if (iLat < 0 || iLng < 0) throw new Error('unexpected NASA response');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < head.length) continue;
    const hhmm = (c[iTime] || '0000').padStart(4, '0');
    const t = Date.parse(c[iDate] + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2) + ':00Z');
    const age = (now - t) / 36e5; if (!(age <= maxAgeHours)) continue;
    const cf = String(c[iConf] || '').toLowerCase();
    out.push({ lat: +c[iLat], lng: +c[iLng], frp: +c[iFrp] || 0, conf: cf.startsWith('h') ? 'high' : cf.startsWith('l') ? 'low' : 'nominal', t, age: Math.max(0, Math.round(age)), sat: c[iSat], dn: c[iDn] });
  }
  return out.sort((a, b) => b.frp - a.frp).slice(0, limit);
}

async function fetchHotspotsNasa(proxy, b, maxAgeHours, limit) {
  // FIRMS day ranges are UTC calendar days, so ask for one extra day and filter by age below.
  const days = Math.min(5, Math.max(1, Math.ceil(maxAgeHours / 24) + 1));
  const r = await fetch(`${proxy}/area?west=${b.w}&south=${b.s}&east=${b.e}&north=${b.n}&days=${days}`, { signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
  if (!r.ok) throw new Error('NASA proxy error ' + r.status);
  return parseFirmsCsv(await r.text(), maxAgeHours, limit);
}

async function fetchHotspots(b, maxAgeHours, limit = 8000) {
  const proxy = nasaProxyUrl();
  if (proxy) { try { return await fetchHotspotsNasa(proxy, b, maxAgeHours, limit); } catch (e) { /* fall back to the Esri-republished NASA layer */ } }
  const p = new URLSearchParams({
    where: `hours_old<=${maxAgeHours}`, geometry: `${b.w},${b.s},${b.e},${b.n}`, geometryType: 'esriGeometryEnvelope',
    inSR: 4326, spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'false', orderByFields: 'frp DESC',
    outFields: 'latitude,longitude,frp,confidence,esritimeutc,hours_old,satellite,daynight', resultRecordCount: limit, f: 'json',
  });
  const r = await getJSON(HOTSPOT_URL + '?' + p);
  if (r.error) throw new Error(r.error.message || 'hotspot service error');
  return (r.features || []).map((f) => {
    const a = f.attributes;
    const c = String(a.confidence || '').toLowerCase();
    return { lat: a.latitude, lng: a.longitude, frp: a.frp || 0, conf: c.startsWith('h') ? 'high' : c.startsWith('l') ? 'low' : 'nominal', t: a.esritimeutc, age: a.hours_old, sat: a.satellite, dn: a.daynight };
  });
}

const AGENCY_NAMES = { USFS: 'US Forest Service', BLM: 'Bureau of Land Management', NPS: 'National Park Service', BIA: 'Bureau of Indian Affairs', FWS: 'US Fish & Wildlife Service', DOD: 'Dept. of Defense', DOE: 'Dept. of Energy', ST: 'State agency', 'ST/C&L': 'State / local agencies', 'C&L': 'County / local agency', DNR: 'State Dept. of Natural Resources', TRIBE: 'Tribal agency', OTHR: 'Other agency' };

/** Incident names arrive as typed by dispatchers ("BEAR", "Bear Creek", "LAC-123456"). Make them readable. */
function incidentTitle(raw) {
  const n = String(raw || '').trim();
  if (!n) return 'Unnamed wildfire incident';
  if (/^[A-Z]{2,4}[- ]?\d{3,}$/i.test(n) || /^\d+$/.test(n)) return 'Incident ' + n.toUpperCase();   // a dispatch number, not a name
  const pretty = n === n.toUpperCase()
    ? n.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/(?!^)\b(Of|The|And|On|At|In)\b/g, (m) => m.toLowerCase()).replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase())
    : n;
  if (/\b(smoke|report|investigat|unknown|reported)\b/i.test(pretty)) return pretty.charAt(0).toUpperCase() + pretty.slice(1).toLowerCase();   // "Report of smoke"
  return /\b(fire|fires|complex|incident)$/i.test(pretty) ? pretty : pretty + ' Fire';
}

async function fetchIncidents() {
  const p = new URLSearchParams({
    where: "IncidentTypeCategory='WF'",
    outFields: 'IncidentName,IncidentSize,PercentContained,POOState,POOCounty,FireDiscoveryDateTime,ModifiedOnDateTime_dt,UniqueFireIdentifier,IrwinID,POOProtectingAgency,CpxName',
    returnGeometry: 'true', outSR: 4326, resultRecordCount: 3000, f: 'json',
  });
  const r = await getJSON(INCIDENT_URL + '?' + p, 20000);
  if (r.error) throw new Error('incident service error');
  return (r.features || []).filter((f) => f.geometry && isFinite(f.geometry.x) && isFinite(f.geometry.y)).map((f) => {
    const a = f.attributes, acres = a.IncidentSize;
    const id = a.IrwinID || a.UniqueFireIdentifier || ((a.IncidentName || 'fire') + '@' + f.geometry.y.toFixed(3) + ',' + f.geometry.x.toFixed(3));
    return {
      id: String(id).replace(/[{}]/g, ''), name: incidentTitle(a.IncidentName), rawName: a.IncidentName || '', ufid: a.UniqueFireIdentifier || '',
      acres: acres == null ? null : (acres < 10 ? Math.round(acres * 10) / 10 : Math.round(acres)),
      contained: a.PercentContained == null ? null : Math.round(a.PercentContained), state: (a.POOState || '').replace('US-', ''), county: a.POOCounty || '',
      agency: a.POOProtectingAgency || '', complex: a.CpxName || '',
      lat: f.geometry.y, lng: f.geometry.x, discovered: a.FireDiscoveryDateTime, updated: a.ModifiedOnDateTime_dt,
    };
  });
}
const incActive = (f) => f.contained == null || f.contained < 100;
const incSize = (f) => (f.acres == null ? 'Size not reported' : f.acres.toLocaleString() + ' acres');
const incContain = (f) => (f.contained == null ? 'containment not reported' : f.contained === 100 ? 'fully contained' : f.contained + '% contained');
const shortDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }) : '—');

async function fetchPerimeters(b, zoom) {
  const p = new URLSearchParams({
    where: '1=1', geometry: `${b.w},${b.s},${b.e},${b.n}`, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
    outFields: 'poly_IncidentName,poly_GISAcres', returnGeometry: 'true', outSR: 4326, resultRecordCount: 300,
    maxAllowableOffset: (0.5 / Math.pow(2, zoom)).toFixed(6), f: 'geojson',
  });
  return getJSON(PERIMETER_URL + '?' + p, 20000);
}

async function fetchWeather(lat, lng) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lng.toFixed(3),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,dew_point_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,precipitation',
    hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset',
    forecast_days: 10, past_days: 2, timezone: 'auto', wind_speed_unit: 'mph', temperature_unit: 'fahrenheit', precipitation_unit: 'inch',
  });
  return getJSON('https://api.open-meteo.com/v1/forecast?' + p);
}

/** Air quality incl. wildfire smoke (Open-Meteo / CAMS, US AQI). */
async function fetchAir(lat, lng) {
  const p = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lng.toFixed(3), current: 'us_aqi,pm2_5', hourly: 'us_aqi,pm2_5', forecast_days: 2, timezone: 'auto' });
  return getJSON('https://air-quality-api.open-meteo.com/v1/air-quality?' + p);
}
const AQI_CATS = [[50, 'Good', 'good'], [100, 'Moderate', 'moderate'], [150, 'Unhealthy for sensitive groups', 'usg'], [200, 'Unhealthy', 'unhealthy'], [300, 'Very unhealthy', 'vunhealthy'], [Infinity, 'Hazardous', 'hazardous']];
const aqiCat = (v) => AQI_CATS.find((c) => v <= c[0]);
function analyseAir(a) {
  const now = a.current || {};
  const aqi = Math.round(now.us_aqi || 0);
  const t0 = (now.time || '').slice(0, 13);
  const hi = (a.hourly && a.hourly.time) ? a.hourly.time.map((t, i) => (t.slice(0, 13) >= t0 ? a.hourly.us_aqi[i] : null)).filter((v) => v != null).slice(0, 24) : [];
  const peak = hi.length ? Math.round(Math.max(...hi)) : aqi;
  return { aqi, pm25: Math.round((now.pm2_5 || 0) * 10) / 10, cat: aqiCat(aqi)[1], key: aqiCat(aqi)[2], peak, peakCat: aqiCat(peak)[1] };
}

/* Official warnings from the US National Weather Service, most important first. */
const SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
const FIRE_EVENT = /fire|red flag|smoke|evacuat|air quality|extreme heat|excessive heat/i;
async function fetchAlerts(lat, lng) {
  const r = await getJSON(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}`);
  return (r.features || []).map((f) => {
    const a = f.properties || {};
    return {
      id: a.id || f.id, event: a.event || 'Weather alert', headline: a.headline || a.event, area: a.areaDesc || '', severity: a.severity || 'Unknown', urgency: a.urgency || '',
      sender: a.senderName || 'National Weather Service', sent: Date.parse(a.sent || a.effective) || null, onset: Date.parse(a.onset || a.effective) || null,
      ends: Date.parse(a.ends || a.expires) || null, desc: a.description || '', instr: a.instruction || '', fire: FIRE_EVENT.test(a.event || ''),
    };
  }).sort((x, y) => (y.fire - x.fire) || ((SEV_RANK[y.severity] || 0) - (SEV_RANK[x.severity] || 0)) || ((y.sent || 0) - (x.sent || 0)));
}
const untilText = (ts) => (ts ? 'until ' + new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/** Headlines come from GDELT. Browsers can't read GDELT's answer when it is busy (its error replies carry no CORS
    headers), so the app asks the Aflare Worker first (/news — shared cache + retry) and only falls back to GDELT
    directly if there is no Worker, or it is an older Worker that doesn't know /news yet. */
async function fetchNews(region) {
  const clean = region ? region.replace(/"/g, '') : '';
  let r = null;
  const proxy = nasaProxyUrl();
  if (proxy) {
    try { r = await getJSON(proxy + '/news' + (clean ? '?region=' + encodeURIComponent(clean) : ''), 35000); }
    catch (e) { if (/HTTP 502/.test(e.message)) throw e; r = null; }   // 502 = the Worker reached GDELT and it is busy — asking GDELT ourselves would only fail too
    if (r && !Array.isArray(r.articles)) r = null;
  }
  if (!r) {
    const q = '("wildfire" OR "forest fire" OR "brush fire")' + (clean ? ' "' + clean + '"' : '') + ' sourcelang:english';
    r = await getJSON('https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&maxrecords=40&timespan=2d&sort=datedesc&query=' + encodeURIComponent(q), 20000);
  }
  const seenTitles = new Set();
  return (r.articles || []).filter((a) => {
    const t = (a.title || '').toLowerCase();
    if (!/fire|blaze|burn|evacuat|smoke|firefight/.test(t) || seenTitles.has(t)) return false;
    seenTitles.add(t); return true;
  }).slice(0, 20).map((a) => ({
    title: a.title.replace(/\s+/g, ' ').trim(), url: a.url, domain: a.domain, img: /^https:\/\//.test(a.socialimage || '') ? a.socialimage : '',
    t: Date.parse(a.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) || null,
  }));
}

/* ------------------------------------------- 6 Derived info & alerts */
/** Heat intensity bucket from fire radiative power (megawatts). */
const heatClass = (frp) => (frp >= 50 ? 'high' : frp >= 10 ? 'med' : 'low');
/** Hours since a detection — worked out from its timestamp, so saved copies age correctly. */
const ptAge = (p) => (p.t ? Math.max(0, (Date.now() - p.t) / 36e5) : p.age);
const HEAT_COLOR = { low: '#E8912D', med: '#C2461F', high: '#86231E' };

/** Group nearby detections into one "event" so one fire isn't 40 alerts. */
function clusterPoints(points, cellDeg) {
  if (!cellDeg) return points.map((p) => ({ lat: p.lat, lng: p.lng, n: 1, maxFrp: p.frp, t: p.t, age: p.age, conf: p.conf, pts: [p] }));
  const cells = new Map();
  for (const p of points) {
    const k = Math.floor(p.lat / cellDeg) + ':' + Math.floor(p.lng / cellDeg);
    let c = cells.get(k);
    if (!c) { c = { sLat: 0, sLng: 0, n: 0, maxFrp: 0, t: 0, age: 1e9, conf: 'low', pts: [] }; cells.set(k, c); }
    c.sLat += p.lat; c.sLng += p.lng; c.n++; c.maxFrp = Math.max(c.maxFrp, p.frp); c.t = Math.max(c.t, p.t || 0); c.age = Math.min(c.age, p.age);
    if (p.conf === 'high' || (p.conf === 'nominal' && c.conf === 'low')) c.conf = p.conf;
    c.pts.push(p);
  }
  return [...cells.values()].map((c) => ({ lat: c.sLat / c.n, lng: c.sLng / c.n, n: c.n, maxFrp: c.maxFrp, t: c.t, age: c.age, conf: c.conf, pts: c.pts }));
}

/**
 * Fire-weather score 0–10 — Aflare's own simple estimate (NOT an official
 * rating). Dry air and strong wind matter most, then heat, then a dry spell.
 */
function fireWeatherScore({ rh, wind, tempF, rain3d }) {
  let s = 0;
  s += clamp((60 - rh) / 45, 0, 1) * 4.5;     // humidity 60% → 0 pts, 15% or lower → 4.5 pts
  s += clamp((wind - 5) / 25, 0, 1) * 3;      // wind 5 mph → 0 pts, 30 mph → 3 pts
  s += clamp((tempF - 50) / 50, 0, 1) * 1.5;  // 50 °F → 0 pts, 100 °F → 1.5 pts
  s += rain3d < 0.1 ? 1 : 0;                  // no meaningful rain in the last 3 days
  return Math.round(s * 10) / 10;
}
/** The same formula split into its pieces, for the "why" breakdown. */
function scoreParts({ rh, wind, tempF, rain3d }) {
  return [
    ['Dry air', clamp((60 - rh) / 45, 0, 1) * 4.5, 4.5, rh + '% humidity'],
    ['Wind', clamp((wind - 5) / 25, 0, 1) * 3, 3, wind + ' mph'],
    ['Heat', clamp((tempF - 50) / 50, 0, 1) * 1.5, 1.5, tempF + '°F'],
    ['Dry spell', rain3d < 0.1 ? 1 : 0, 1, rain3d < 0.1 ? 'no rain in 3 days' : rain3d + ' in rain in 3 days'],
  ];
}
const scoreLabel = (s) => (s < 2 ? 'Low' : s < 4 ? 'Moderate' : s < 6 ? 'High' : s < 8 ? 'Very High' : 'Extreme');
const scoreRisk = (s) => (s < 3 ? 'low' : s < 5.5 ? 'med' : 'high');

/** Five-step fire-weather scale, coloured like the US fire-danger signs. */
const riskKey = (s) => (s < 2 ? 'low' : s < 4 ? 'mod' : s < 6 ? 'high' : s < 8 ? 'vhigh' : 'ext');

/** WMO weather codes (Open-Meteo) → words + icon name. */
function wmo(code, isDay) {
  const day = isDay !== 0 && isDay !== false;
  const c = +code;
  if (c === 0) return { t: day ? 'Sunny' : 'Clear', i: day ? 'w-sun' : 'w-moon' };
  if (c === 1) return { t: day ? 'Mostly sunny' : 'Mostly clear', i: day ? 'w-sun' : 'w-moon' };
  if (c === 2) return { t: 'Partly cloudy', i: day ? 'w-pcloud' : 'w-pcloud-n' };
  if (c === 3) return { t: 'Cloudy', i: 'w-cloud' };
  if (c === 45 || c === 48) return { t: 'Fog', i: 'w-fog' };
  if (c >= 51 && c <= 57) return { t: 'Drizzle', i: 'w-drizzle' };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { t: c >= 80 ? 'Showers' : c >= 65 ? 'Heavy rain' : 'Rain', i: 'w-rain' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { t: 'Snow', i: 'w-snow' };
  if (c >= 95) return { t: 'Thunderstorms', i: 'w-storm' };
  return { t: 'Fair', i: day ? 'w-sun' : 'w-moon' };
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (deg) => COMPASS[Math.round((deg % 360) / 22.5) % 16];
/** "2026-10-20T13:00" → "1 PM" (keeps the place's own local time). */
function hourLabel(iso) { const h = +iso.slice(11, 13); return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }
function clockLabel(iso) { if (!iso) return '—'; const h = +iso.slice(11, 13), m = iso.slice(14, 16); return (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM'); }

/** Turn Open-Meteo output into "now", 24 hours and 10 days, each with a fire-weather score. */
function analyseWeather(w) {
  const c = w.current, H = w.hourly, D = w.daily;
  const dayRain = {}; D.time.forEach((d, i) => (dayRain[d] = D.precipitation_sum[i] || 0));
  const days = D.time, todayStr = (c.time || '').slice(0, 10);
  const idx0 = Math.max(0, days.indexOf(todayStr));
  const rain3dFor = (d) => { const k = days.indexOf(d); return (dayRain[d] || 0) + (dayRain[days[k - 1]] || 0) + (dayRain[days[k - 2]] || 0); };
  const hourScore = (i) => fireWeatherScore({ rh: H.relative_humidity_2m[i], wind: H.wind_speed_10m[i], tempF: H.temperature_2m[i], rain3d: rain3dFor(H.time[i].slice(0, 10)) });

  const week = [];
  for (let di = idx0; di < Math.min(days.length, idx0 + 10); di++) {
    const d = days[di];
    let sum = 0, cnt = 0, rhMin = 101, windMax = 0, tempMax = -999;
    for (let i = 0; i < H.time.length; i++) {
      if (H.time[i].slice(0, 10) !== d) continue;
      rhMin = Math.min(rhMin, H.relative_humidity_2m[i]); windMax = Math.max(windMax, H.wind_speed_10m[i]); tempMax = Math.max(tempMax, H.temperature_2m[i]);
      const hr = +H.time[i].slice(11, 13);
      if (hr >= 12 && hr <= 18) { sum += hourScore(i); cnt++; }
    }
    if (!cnt) continue;
    const score = sum / cnt, dt = new Date(d + 'T12:00:00');
    week.push({
      day: dt.toLocaleDateString(undefined, { weekday: 'short' }), dayLong: dt.toLocaleDateString(undefined, { weekday: 'long' }), date: d, isToday: di === idx0,
      code: D.weather_code[di], max: Math.round(D.temperature_2m_max[di]), min: Math.round(D.temperature_2m_min[di]),
      pop: D.precipitation_probability_max[di] == null ? null : Math.round(D.precipitation_probability_max[di]),
      gustMax: Math.round(D.wind_gusts_10m_max[di] || 0), uvMax: Math.round(D.uv_index_max[di] || 0), sunrise: D.sunrise[di], sunset: D.sunset[di],
      score, risk: scoreRisk(score), key: riskKey(score), label: scoreLabel(score),
      rhMin: Math.round(rhMin), windMax: Math.round(windMax), tempMax: Math.round(tempMax), rain: Math.round((dayRain[d] || 0) * 100) / 100,
    });
  }

  const nowHour = (c.time || '').slice(0, 13);
  let h0 = H.time.findIndex((t) => t.slice(0, 13) >= nowHour); if (h0 < 0) h0 = 0;
  const hours = [];
  for (let i = h0; i < Math.min(H.time.length, h0 + 25); i++) {
    const sc = hourScore(i);
    hours.push({ iso: H.time[i], tl: i === h0 ? 'Now' : hourLabel(H.time[i]), tempF: Math.round(H.temperature_2m[i]), code: H.weather_code[i], isDay: H.is_day[i],
      rh: Math.round(H.relative_humidity_2m[i]), wind: Math.round(H.wind_speed_10m[i]), gust: Math.round(H.wind_gusts_10m[i] || 0), dirDeg: H.wind_direction_10m[i],
      pop: H.precipitation_probability[i] == null ? null : Math.round(H.precipitation_probability[i]), score: sc, key: riskKey(sc), label: scoreLabel(sc) });
  }
  // the next 24 hours' worst fire-weather hour, for the summary sentence
  const peak = hours.slice(0, 24).reduce((a, b) => (b.score > a.score ? b : a), hours[0] || { score: 0 });

  const rain3d = rain3dFor(todayStr);
  const nowScore = fireWeatherScore({ rh: c.relative_humidity_2m, wind: c.wind_speed_10m, tempF: c.temperature_2m, rain3d });
  const t = week[0] || {};
  return {
    v: 2, tz: w.timezone,
    now: { score: nowScore, label: scoreLabel(nowScore), key: riskKey(nowScore), tempF: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), rh: Math.round(c.relative_humidity_2m), dew: Math.round(c.dew_point_2m),
      wind: Math.round(c.wind_speed_10m), gust: Math.round(c.wind_gusts_10m || 0), dirDeg: c.wind_direction_10m, dir: dirName(c.wind_direction_10m), code: c.weather_code, isDay: c.is_day,
      uv: Math.round((c.uv_index || 0) * 10) / 10, rain3d: Math.round(rain3d * 100) / 100, time: c.time },
    today: { max: t.max, min: t.min, sunrise: t.sunrise, sunset: t.sunset, uvMax: t.uvMax, pop: t.pop },
    hours, peak, week,
  };
}

/** Local notification via the service worker (works when installed, incl. Android). */
async function osNotify(title, body, tag, goto) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !data.settings.push) return;
  try {
    // serviceWorker.ready never settles if the worker failed to install, so don't wait on it forever.
    const reg = 'serviceWorker' in navigator ? await Promise.race([navigator.serviceWorker.ready, sleep(2500).then(() => null)]) : null;
    if (!reg) throw new Error('no service worker');
    await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/favicon-48.png', data: { url: goto || './' }, renotify: false });
  } catch (e) { try { new Notification(title, { body, tag }); } catch (e2) { /* unsupported */ } }
}

function addFeed(item, silent) {
  if (seen[item.id]) return false;
  seen[item.id] = Date.now();
  feed.unshift(Object.assign({ unread: !silent, t: Date.now() }, item));
  feed = feed.slice(0, 40);
  // forget old ids after a week so a returning fire can alert again
  for (const k in seen) if (Date.now() - seen[k] > 7 * 864e5) delete seen[k];
  const g = item.goto || {};
  if (!silent) osNotify(item.h, item.sub || '', item.id, g.kind === 'nws' ? './?screen=news' : g.lat != null ? './?screen=map' : './?screen=notif');
  return true;
}

/**
 * Everything Aflare knows about fire activity around one place, kept split by
 * source: official warnings (NWS), official incidents (NIFC) and unconfirmed
 * satellite heat detections (NASA FIRMS). Used by Home, the alert feed and the
 * places sheet so they always agree.
 */
function situation(loc, pts, incs, alertList) {
  const R = data.settings.radius, now = Date.now();
  alertList = (alertList || []).filter((a) => !a.ends || a.ends > now);   // a saved copy may hold warnings that have since expired
  const p24 = (pts || []).filter((p) => ptAge(p) <= 24 && (!data.settings.highConfOnly || p.conf !== 'low'));
  const clusters = clusterPoints(p24, 0.05).map((c) => Object.assign(c, { d: distMiles(loc.lat, loc.lng, c.lat, c.lng) })).sort((a, b) => a.d - b.d);
  const inc = (incs || []).map((f) => Object.assign({}, f, { d: distMiles(loc.lat, loc.lng, f.lat, f.lng) })).sort((a, b) => a.d - b.d);
  const clustersIn = clusters.filter((c) => c.d <= R), incIn = inc.filter((f) => f.d <= R);
  return {
    R, clusters, clustersIn,
    detIn: clustersIn.reduce((s, c) => s + c.n, 0),
    incActiveIn: incIn.filter(incActive), incContainedIn: incIn.filter((f) => !incActive(f)),
    nearestActiveInc: inc.find(incActive) || null,
    warnings: (alertList || []).filter((a) => a.fire),
    otherAlerts: (alertList || []).filter((a) => !a.fire),
  };
}

const hsFeedId = (c) => `hs:${c.lat.toFixed(2)},${c.lng.toFixed(2)}:${new Date(c.t || Date.now()).toISOString().slice(0, 10)}`;

/** Look at fresh data for one saved place and add new events to the feed (and OS notifications). */
function evaluateAlerts(loc, pts, incs, alertList) {
  if (!loc || loc.id === 'gps' || !data.locations.some((l) => l.id === loc.id)) return;
  const initKey = 'alertsInit.' + userKey() + '.' + loc.id;
  // The first look at a place fills the list quietly, so adding a place never sets off a burst of notifications.
  const firstRun = !LS.get(initKey);
  const s = situation(loc, pts, incs, alertList), name = placeName(loc);
  for (const c of s.clustersIn.slice(0, 5)) {
    addFeed({
      id: hsFeedId(c), icon: 'i-warn', kind: 'hs',
      h: `Satellite heat detected ${fmtMi(c.d)} ${compass(loc.lat, loc.lng, c.lat, c.lng)} of ${name}`,
      sub: `${c.n} detection${c.n > 1 ? 's' : ''} · seen ${ago(c.t)}`,
      goto: { kind: 'hs', lat: c.lat, lng: c.lng, n: c.n, maxFrp: c.maxFrp, t: c.t, conf: c.conf, place: loc.id },
    }, firstRun);
  }
  for (const f of s.incActiveIn.slice(0, 5)) {
    addFeed({ id: 'inc:' + f.id, icon: 'i-flame', kind: 'inc', h: `${f.name}: ${fmtMi(f.d)} ${compass(loc.lat, loc.lng, f.lat, f.lng)} of ${name}`,
      sub: `${incSize(f)} · ${incContain(f)}`, goto: { kind: 'inc', id: f.id, lat: f.lat, lng: f.lng, place: loc.id } }, firstRun);
  }
  if (data.settings.wxAlerts) {
    for (const a of s.warnings) addFeed({ id: 'nws:' + a.id, icon: 'i-shield', kind: 'nws', h: `${a.event} — ${name}`, sub: `${a.sender}${a.ends ? ' · ' + untilText(a.ends) : ''}`, goto: { kind: 'nws', alert: a.id, place: loc.id } }, firstRun);
  }
  LS.set(initKey, true);
  saveFeed();
}

/* ------------------------------------------------------- 7 Learn content */
const ARTICLES = [
  { id: 'defensible-space', cat: 'Prevention', title: 'Creating Defensible Space Around Your Home', meta: '6 min read · Aflare Safety', body: [
    'Defensible space is the buffer between your home and the vegetation around it. It slows a fire, gives firefighters room to work, and keeps flames and heat away from the structure.',
    '<b>Zone 0 — the first 5 feet.</b> This is the most important zone because wind-blown embers collect here. Use bare soil, gravel or pavers; remove dead leaves and plants, wood mulch and anything flammable stacked against walls, including firewood, doormats and furniture cushions.',
    '<b>Zone 1 — 5 to 30 feet.</b> Keep it "lean, clean and green." Space shrubs and trees so fire can\'t jump between them, keep grass mowed short, and prune tree branches up to 6–10 feet off the ground.',
    '<b>Zone 2 — 30 to 100 feet.</b> Thin dense brush and remove "ladder fuels," the small plants that let flames climb into tree canopies.',
    'Requirements vary by state, county and insurer, so check with your local fire department for the rules where you live.'] },
  { id: 'home-hardening', cat: 'Prevention', title: 'Hardening Your Home Against Embers', meta: '5 min read · Aflare Safety', body: [
    'Most homes that burn in wildfires are ignited by embers (burning pieces carried by wind, sometimes more than a mile ahead of the flames), not by the main fire front.',
    'Small upgrades make a big difference: cover vents with 1/8-inch metal mesh, keep gutters and the roof clear of needles and leaves, choose a Class A fire-rated roof when replacing, and use noncombustible fencing where it touches the house.',
    'Dual-pane tempered-glass windows resist heat better than single-pane windows, and a metal or ember-resistant garage door seal stops embers from drifting inside.'] },
  { id: 'how-fires-spread', cat: 'Fire Science', title: 'How Wildfires Start and Spread', meta: '6 min read · Aflare Safety', body: [
    'Most wildfires start from a spark — lightning, power lines, unattended campfires or equipment — meeting dry fuel. Once burning, three things decide how fast a fire grows: fuel, weather and terrain.',
    'Dry grass, brush and timber are the fuel. Wind pushes flames forward and carries embers ahead of the fire, starting new "spot fires." Slope matters too: fire runs faster uphill because it pre-heats the fuel above it.',
    'This is why containment numbers can change quickly — a wind shift or a spot fire can change a fire\'s path within minutes.'] },
  { id: 'evac-plan', cat: 'Preparedness', title: 'Building Your Family Evacuation Plan', meta: '5 min read · Aflare Safety', body: [
    'Follow the "Ready, Set, Go" idea used by many fire departments: be <b>Ready</b> before fire season, <b>Set</b> when a fire threatens, and <b>Go</b> early when told to.',
    '<b>Ready:</b> sign up for your county\'s emergency alerts, know two routes out of your neighborhood, choose a meeting place, and keep a go-bag with documents, medications, chargers, water, a change of clothes and pet supplies.',
    '<b>Set:</b> park facing out, keep windows closed, and move flammable items away from the house. Keep your gas tank at least half full during fire season.',
    '<b>Go:</b> when officials say leave, leave. Waiting for a "better look" is how people get trapped on blocked roads.'] },
  { id: 'red-flag', cat: 'Weather', title: 'Understanding Red Flag Warnings', meta: '4 min read · Aflare Safety', body: [
    'The National Weather Service issues a <b>Red Flag Warning</b> when critical fire weather conditions are happening or about to — typically a mix of very low humidity, strong winds and dry fuels. A <b>Fire Weather Watch</b> means those conditions may develop in the next 1–3 days.',
    'Exact thresholds vary by region. During a warning, avoid outdoor burning, don\'t drive onto dry grass, don\'t drag trailer chains, and be careful with anything that can throw sparks.',
    'Aflare shows active NWS warnings for the place you are viewing at the top of Home and on the Alerts &amp; news page. While Aflare is open it also adds new fire-weather warnings for your saved places to your notifications. Evacuation orders come from your county or sheriff, so sign up for their alerts too.'] },
  { id: 'smoke-health', cat: 'Health', title: 'Protecting Yourself From Wildfire Smoke', meta: '4 min read · Aflare Safety', body: [
    'Wildfire smoke contains fine particles that can irritate eyes and lungs and can travel hundreds of miles. Children, older adults, pregnant people and anyone with asthma, heart or lung conditions are most at risk.',
    'Check the Air Quality Index at AirNow.gov. On smoky days stay indoors with windows closed, run air conditioning on recirculate, and use a HEPA air cleaner if you have one. A properly fitted N95 or similar respirator helps outdoors; cloth and surgical masks do not filter smoke well.',
    'If you have trouble breathing, chest pain or severe coughing, seek medical care.'] },
  { id: 'satellite', cat: 'Fire Science', title: 'How Satellites Spot Fires From Space', meta: '5 min read · Aflare Safety', body: [
    'The heat detections on Aflare\'s map come from the <b>VIIRS</b> instrument flying on three polar-orbiting weather satellites: Suomi NPP, NOAA-20 and NOAA-21. Each one passes over most places at least twice a day, once in daylight and once at night.',
    'VIIRS looks at the Earth in thermal infrared. When part of a 375-meter square of ground is much hotter than its surroundings, NASA\'s algorithm flags it as an <b>active fire detection</b>. A fire can be far smaller than the square and still be seen if it is hot enough.',
    'NASA\'s <b>FIRMS</b> system publishes these detections within about three hours of the satellite passing overhead. Each one includes its <b>fire radiative power</b> (how much heat it gives off, in megawatts) and a <b>confidence</b> level of low, nominal or high.',
    'Satellites have limits. Thick cloud and heavy smoke can hide a fire, a fire can start between passes, and some detections are not wildfires at all: prescribed burns, farm burning, gas flares and hot industrial sites can all show up. That is why Aflare also shows official incident reports and why you should always follow local emergency officials.'] },
];

/* Bundled photos (img/learn/<id>.jpg + <id>-thumb.jpg) — public domain or CC BY, see Privacy & About. */
const PHOTO_CREDITS = [{"slot": "defensible-space","title": "A picture is worth a 1,000 words fuel treatments at work (18431459800).jpg","author": "USDA Forest Service, Pacific Southwest Region 5","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-USDA","source_url": "https://commons.wikimedia.org/wiki/File:A_picture_is_worth_a_1,000_words_fuel_treatments_at_work_(18431459800).jpg","description": "Aerial view of cabins in a patch of green, fuel-treated forest that survived while the surrounding forest burned."},{"slot": "home-hardening","title": "Wildland Urban Interface (16295125334).jpg","author": "Bureau of Land Management Oregon and Washington","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-BLM","source_url": "https://commons.wikimedia.org/wiki/File:Wildland_Urban_Interface_(16295125334).jpg","description": "A house at the edge of a forest in the wildland-urban interface, with smoke rising from a nearby prescribed burn."},{"slot": "how-fires-spread","title": "Hayes Fire Flames and Smoke, Olympic - 2016 (32275dd6-5c88-4fa0-b4d3-54b769754792).jpg","author": "National Park Service","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-NPS","source_url": "https://commons.wikimedia.org/wiki/File:Hayes_Fire_Flames_and_Smoke,_Olympic_-_2016_(32275dd6-5c88-4fa0-b4d3-54b769754792).jpg","description": "Aerial view of red flames and dark smoke rising from a burning forested hillside in Olympic National Park."},{"slot": "evac-plan","title": "FEMA - 7518 - Photograph by Bryan Dahlberg taken on 06-08-2002 in Colorado.jpg","author": "Bryan Dahlberg, FEMA","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-FEMA","source_url": "https://commons.wikimedia.org/wiki/File:FEMA_-_7518_-_Photograph_by_Bryan_Dahlberg_taken_on_06-08-2002_in_Colorado.jpg","description": "Cars with headlights on drive out of town under a smoky orange sky as residents evacuate from a wildfire."},{"slot": "red-flag","title": "Extreme Fire Danger (18592101956).jpg","author": "USDA Forest Service, Pacific Southwest Region 5","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-USDA-FS","source_url": "https://commons.wikimedia.org/wiki/File:Extreme_Fire_Danger_(18592101956).jpg","description": "A Smokey Bear fire danger sign set to Extreme, with a large wildfire smoke plume rising behind it."},{"slot": "smoke-health","title": "North Complex smoke in San Francisco - Bay Bridge and Financial District.jpg","author": "Christopher Michel","license": "CC BY 2.0","license_url": "https://creativecommons.org/licenses/by/2.0","source_url": "https://commons.wikimedia.org/wiki/File:North_Complex_smoke_in_San_Francisco_-_Bay_Bridge_and_Financial_District.jpg","description": "Wildfire smoke turns the midday sky dark orange over the San Francisco skyline and Bay Bridge."},{"slot": "featured","title": "Pioneer Fire - Night - Flames fury burn trees.jpg","author": "USDA Forest Service","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-USDA","source_url": "https://commons.wikimedia.org/wiki/File:Pioneer_Fire_-_Night_-_Flames_fury_burn_trees.jpg","description": "Tall flames engulf pine trees at night during the Pioneer Fire in Idaho's Boise National Forest."},{"slot": "satellite","title": "Smoke Streams from Palisades and Eaton Fires (153813 - amo 20250111 lrg).jpg","author": "NASA Earth Observatory","license": "Public domain (US Government work)","license_url": "https://commons.wikimedia.org/wiki/Template:PD-USGov-NASA","source_url": "https://commons.wikimedia.org/wiki/File:Smoke_Streams_from_Palisades_and_Eaton_Fires_(153813_-_amo_20250111_lrg).jpg","description": "Satellite view of smoke plumes from the Palisades and Eaton fires streaming from Los Angeles out over the Pacific Ocean."}];
const photoFor = (id) => PHOTO_CREDITS.find((c) => c.slot === id);
const FEATURED_ID = 'how-fires-spread';

const VIDEOS = [
  { id: 'kkSoDOmzdGQ', cat: 'Prevention', title: 'Cal Fire shares tips to protect your home', channel: 'Action News Now', body: ['A local news report where CAL FIRE explains simple steps for protecting a home during Wildfire Preparedness Week.'] },
  { id: 'sG4qXcTQij0', cat: 'Prevention', title: 'How defensible space could save your home from fire', channel: 'KCRA 3', body: ['A walkthrough of defensible space and how clearing vegetation around a house can make the difference in a wildfire.'] },
  { id: '-twZRaQu4Ig', cat: 'Prevention', title: 'How to harden a home for wildfire: vents, gutter guards and gaps', channel: 'RCD of the Santa Monica Mountains', body: ['A practical look at the small openings where embers get into a house, and the vent covers, gutter guards and sealing that keep them out.'] },
  { id: 'QOJJdmdv--0', cat: 'Preparedness', title: 'Ready, Set, Go: wildfire evacuation preparedness and planning', channel: 'Santa Clara County Fire Department', body: ['A fire department walks through the Ready, Set, Go! program: preparing your home, getting set when a fire threatens, and leaving early.'] },
  { id: 'gPCbordr50w', cat: 'Preparedness', title: 'How to prepare a go-bag for a wildfire evacuation', channel: '9NEWS', body: ['What to pack in a go-bag so you can leave in minutes: documents, medications, chargers, water, clothes and pet supplies.'] },
  { id: 'xyoYlz995k0', cat: 'Fire Science', title: 'Ember attack: how homes catch fire', channel: 'CFA (Country Fire Authority)', body: ["Australia's Country Fire Authority shows how wind-blown embers, not just the flame front, ignite homes during a bushfire."] },
  { id: 'Dg1ZmvSCMvk', cat: 'Fire Science', title: 'The science behind wildfires: how they start and spread', channel: 'CBC Kids News', body: ['A clear, short explainer on the fire triangle, and how fuel, weather and terrain decide how fast a wildfire spreads.'] },
  { id: 'mSqYnjYVfyU', cat: 'Health', title: 'How to protect yourself from wildfire smoke', channel: 'PBS NewsHour', body: ['Health experts explain why wildfire smoke is harmful and how to reduce exposure with filtered air and well-fitted respirators.'] },
];

const RESOURCES = [
  { t: 'Ready.gov — Wildfires', s: 'Official preparedness checklists', u: 'https://www.ready.gov/wildfires' },
  { t: 'CAL FIRE — Ready for Wildfire', s: 'Defensible space & evacuation guides', u: 'https://www.readyforwildfire.org/' },
  { t: 'NFPA — Firewise USA', s: 'Community wildfire preparedness', u: 'https://www.nfpa.org/education-and-research/wildfire/firewise-usa' },
  { t: 'Smokey Bear', s: 'Prevent wildfires', u: 'https://smokeybear.com/' },
  { t: 'NWS — Wildfire safety', s: 'Fire weather & Red Flag Warnings', u: 'https://www.weather.gov/safety/wildfire' },
  { t: 'InciWeb', s: 'Official US incident information', u: 'https://inciweb.wildfire.gov/' },
  { t: 'AirNow', s: 'Live air quality & smoke', u: 'https://www.airnow.gov/' },
  { t: 'NASA FIRMS', s: 'Global satellite fire map', u: 'https://firms.modaps.eosdis.nasa.gov/map/' },
];

const TIPS = [
  'Clear dry leaves and debris from your roof and gutters.',
  'Keep firewood at least 30 feet from your home.',
  'Check that your address numbers are visible from the road.',
  'Test smoke alarms monthly and replace batteries yearly.',
  'Never leave a campfire unattended — drown it, stir it, feel it.',
  'Keep a go-bag by the door during fire season.',
  'Sign up for your county\'s emergency alert system.',
  'Park vehicles facing out of the driveway during red flag days.',
  'Mow dry grass early in the day, never when it is windy and hot.',
  'Cover attic and crawl-space vents with 1/8-inch metal mesh.',
  'Agree on a family meeting place outside your neighborhood.',
  'Keep your gas tank at least half full during fire season.',
  'Use a N95 respirator on smoky days — cloth masks don\'t stop smoke.',
  'Store important documents in a grab-and-go folder or scan them to the cloud.',
];

/* Preparedness checklist. `a` = the Learn article that explains how; `u` = an official page. */
const CHECKLIST = [
  { g: 'Stay informed', items: [
    { id: 'county', t: "Sign up for your county's emergency alerts", s: 'Evacuation orders come from local officials, not from Aflare.', u: 'https://www.ready.gov/alerts', ul: 'How alerts work (Ready.gov)' },
    { id: 'nonemerg', t: "Save your fire department's non-emergency number", s: 'Look it up on your city or county website.', act: 'findStations', ul: 'Find nearby fire stations' },
    { id: 'places', t: 'Add the places you care about to Aflare', s: 'Home, work, school, family.', act: 'openPlaces', ul: 'Open your places' },
  ] },
  { g: 'Plan to leave', items: [
    { id: 'routes', t: 'Know two ways out of your neighborhood', a: 'evac-plan' },
    { id: 'meet', t: 'Pick a meeting place and an out-of-area contact', a: 'evac-plan' },
    { id: 'gobag', t: 'Pack a go-bag for each person and pet', s: 'Water, medications, documents, chargers, clothes, N95 masks.', a: 'evac-plan' },
  ] },
  { g: 'Prepare your home', items: [
    { id: 'zone0', t: 'Clear leaves and flammable items within 5 ft of the house', a: 'defensible-space' },
    { id: 'gutters', t: 'Clean dry needles and leaves off the roof and gutters', a: 'home-hardening' },
    { id: 'vents', t: 'Cover vents with 1/8-inch metal mesh', a: 'home-hardening' },
    { id: 'alarms', t: 'Test smoke alarms', s: 'Monthly; replace batteries yearly.' },
  ] },
  { g: 'Smoke', items: [
    { id: 'hepa', t: 'Get a HEPA air cleaner or a high-MERV filter ready', a: 'smoke-health' },
  ] },
];
const CHECK_ITEMS = CHECKLIST.flatMap((g) => g.items);
