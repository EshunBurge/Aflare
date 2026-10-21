'use strict';
/* =========================================================================
   Aflare — satellite fire alerts (web app / PWA)
   Sections: 1 Helpers · 2 Storage · 3 Accounts · 4 Location · 5 Live data
             6 Derived info & alerts · 7 Learn content
   (UI, map and screens continue below in the second half of this file.)
   ========================================================================= */

const VERSION = '2.3.3';
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

/* =========================================================================
   Second half — screens, map, emergency tools, PWA plumbing, boot
   ========================================================================= */

/* ------------------------------------------------------------ screen state */
/* Map filters are remembered between visits. */
const MAP_PREFS = LS.get('mapPrefs', {});
const state = { tab: 'home', returnTo: 'learn', age: MAP_PREFS.age === 72 ? 72 : 24, layers: Object.assign({ sat: true, inc: true, per: false }, MAP_PREFS.layers || {}), at: {} };
function saveMapPrefs() { LS.set('mapPrefs', { age: state.age, layers: state.layers }); }
const MAIN_TABS = ['home', 'map', 'learn', 'emergency'];
const BACK_SCREENS = ['profile', 'notif', 'news', 'article', 'privacy'];
const SCREEN_TITLES = { home: 'Home', map: 'Fire map', learn: 'Learn', news: 'Alerts & news', article: 'Article', profile: 'Profile & settings', privacy: 'Privacy & about', notif: 'Notifications', emergency: 'Call & report', auth: 'Log in', splash: '' };
const TOP_TITLES = { article: 'Learn' };   // sub-screens with their own big heading show only the back button
let lastFocus = null;
let currentScreen = 'splash';

let nearby = [], incidents = [], alerts = [], alertsNote = '', wx = null, air = null, newsItems = [], newsAt = 0, lastRefresh = 0, refreshing = false;

function show(id, opts) {
  const push = !opts || opts.push !== false;
  if (!me && id !== 'auth' && id !== 'splash') id = 'auth';
  closeSheets();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('screen-' + id);
  el.classList.add('active');
  el.querySelectorAll('.content').forEach((c) => (c.scrollTop = 0));
  $('topbar').classList.remove('solid'); $('topbar').classList.toggle('onmaroon', id === 'emergency');
  currentScreen = id;

  const chrome = id !== 'splash' && id !== 'auth';
  const sub = BACK_SCREENS.includes(id);
  $('topbar').classList.toggle('show', chrome);
  $('bottomnav').classList.toggle('show', chrome);
  $('topleft-back').style.display = sub ? 'inline-flex' : 'none';
  $('topleft-mark').style.display = sub ? 'none' : 'inline-flex';
  document.title = (SCREEN_TITLES[id] ? SCREEN_TITLES[id] + ' — ' : '') + 'Aflare';
  document.querySelectorAll('.navitem[data-tab]').forEach((n) => {
    const on = n.dataset.tab === state.tab && !sub;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });

  if (id !== 'article') $('art-video').innerHTML = '';
  if (push && BACK_SCREENS.includes(id)) history.pushState({ s: id }, '');

  if (id === 'map') mapShown();
  if (id === 'home' && miniMap) setTimeout(() => { miniMap.invalidateSize(); renderMini(); }, 60);
  if (id === 'emergency') openEmergency();
  if (id === 'news') { renderAlerts(); loadNews(false); }
  if (id === 'notif') renderFeed();
  if (id === 'profile') renderProfile();
  if (id === 'privacy') renderPrivacy();
  if (id === 'learn') renderLearn();
}

function backFrom() {
  if (currentScreen === 'article') return show(state.returnTo || 'learn', { push: false });
  if (currentScreen === 'privacy') return show('profile', { push: false });
  show(state.tab, { push: false });
}
function topBack() {
  if (BACK_SCREENS.includes(currentScreen) && history.state && history.state.s === currentScreen) history.back();
  else backFrom();
}
window.addEventListener('popstate', () => { if (BACK_SCREENS.includes(currentScreen)) backFrom(); });

function goTab(tab) { if (MAIN_TABS.includes(tab)) state.tab = tab; show(tab); }
function goEmergency() { goTab('emergency'); }
function openProfile() { show('profile'); }
function openNotif() { show('notif'); }
function goProfileLocations() { show('profile'); setTimeout(() => { $('addLocForm').style.display = 'flex'; $('locSection').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('newLocCity').focus(); }, 120); }
function goSettings(cardId) { show('profile'); setTimeout(() => { const c = $(cardId); if (!c) return; c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1400); }, 160); }

let skipResolve; const skipSplashPromise = new Promise((r) => (skipResolve = r));
function skipSplash() { skipResolve(); }

function setAuthMode(mode) {
  $('form-login').classList.toggle('hidden', mode !== 'login');
  $('form-signup').classList.toggle('hidden', mode !== 'signup');
  document.querySelectorAll('#screen-auth .anim').forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
}
function routeToAuth() {
  ['loginEmail', 'loginPassword', 'signupName', 'signupEmail', 'signupPassword', 'signupLocation'].forEach((i) => ($(i).value = ''));
  showAuthErr('loginErr', ''); showAuthErr('signupErr', '');
  setAuthMode('login'); show('auth');
}

/* -------------------------------------------------------------- app entry */
function loadCaches() {
  const inc = LS.get('cache.incidents'); if (inc) incidents = inc.v;
  state.gpsView = null; state.viewId = null;
  loadViewCaches();
  lastRefresh = LS.get('lastRefresh.' + userKey(), 0);
}

function enterApp() {
  loadCaches();
  renderAll();
  mirrorForServiceWorker();
  drawHome();
  { const h = homeLoc(); if (h && !LS.get('mapView')) map.setView([h.lat, h.lng], 9); }
  const want = new URLSearchParams(location.search).get('screen');
  const ok = ['home', 'map', 'learn', 'news', 'notif', 'profile', 'emergency'];
  const target = ok.includes(want) ? want : 'home';
  if (MAIN_TABS.includes(target)) { state.tab = target; show(target); } else { state.tab = 'home'; show('home'); show(target); }
  history.replaceState(null, '', location.pathname);
  refreshAll(false);
  if (data.settings.push) registerPeriodicSync().then(() => { if (currentScreen === 'profile') renderProfile(); });
}

function renderAll() {
  renderIdentity(); renderHome(); renderHomeNews(); renderLearn(); renderFeed(); renderProfile(); renderMini(); renderAlerts(); renderNews();
}

function renderIdentity() {
  const name = (data.profile.name || (me && me.name) || '?');
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const photo = data.profile.photo;
  ['topAvatar', 'profile-av'].forEach((id) => {
    const el = $(id);
    el.textContent = photo ? '' : initials;
    el.style.backgroundImage = photo ? `url("${photo}")` : '';
    el.classList.toggle('hasphoto', !!photo);
  });
}

/* ------------------------------------------------------------ data refresh */
function setRefreshSpin(on) { document.querySelectorAll('.refreshlink').forEach((el) => el.classList.toggle('spin', on)); }

/** Try a request again once after a short pause — mobile networks drop requests now and then. */
async function retryOnce(fn) { try { return await fn(); } catch (e) { await sleep(1500); return fn(); } }

const US_ONLY_NOTE = 'Official weather warnings are shown for US locations only (National Weather Service). Check your national weather service for warnings here.';
const isUSPlace = (l) => !l.country || l.country === 'us';

async function refreshAll(manual, viewChange) {
  if (!me) return;
  if (refreshing) { state.refreshAgain = true; if (manual) state.refreshManual = true; return; }   // run once more when the current refresh finishes
  if (!navigator.onLine) { if (manual) toast("You're offline — showing the last saved data"); renderHome(); return; }
  refreshing = true; setRefreshSpin(true);
  const v = viewLoc(), k = viewKey();
  state.fail = state.fail || {};
  const jobs = [], stamp = (key) => { state.at[key] = Date.now(); state.fail[key] = false; return state.at[key]; };
  const failed = (key) => (e) => { if (viewKey() === k || key === 'incidents') state.fail[key] = true; throw e; };
  // Incidents cover the whole US in one request, so a change of place doesn't need a new copy.
  if (!viewChange || Date.now() - (state.incAt || 0) > 5 * 60e3) {
    jobs.push(fetchIncidents().then((r) => { incidents = r; state.incAt = Date.now(); state.fail.incidents = false; LS.set('cache.incidents', { t: state.incAt, v: r }); drawIncidents(); }).catch(failed('incidents')));
  }
  if (v) {
    jobs.push(fetchHotspots(bboxAround(v.lat, v.lng, Math.max(50, data.settings.radius)), 24, 4000).then((r) => { if (viewKey() !== k) return; nearby = r; LS.set('cache.nearby.' + k, { t: stamp('nearby'), v: r }); }).catch(failed('nearby')));
    jobs.push(retryOnce(() => fetchWeather(v.lat, v.lng)).then((r) => { if (viewKey() !== k) return; wx = analyseWeather(r); state.wxFailed = false; LS.set('cache.wx.' + k, { t: stamp('wx'), v: wx }); })
      .catch((e) => { if (viewKey() === k) state.wxFailed = true; throw e; }));
    jobs.push(retryOnce(() => fetchAir(v.lat, v.lng)).then((r) => { if (viewKey() !== k) return; air = analyseAir(r); LS.set('cache.air.' + k, { t: stamp('air'), v: air }); }));
    if (isUSPlace(v)) {
      jobs.push(fetchAlerts(v.lat, v.lng).then((r) => { if (viewKey() !== k) return; alerts = r; alertsNote = ''; LS.set('cache.alerts.' + k, { t: stamp('alerts'), v: r }); })
        .catch((e) => {
          if (viewKey() !== k) return;
          if (/HTTP 40[04]/.test(e.message)) { alerts = []; alertsNote = US_ONLY_NOTE; LS.set('cache.alerts.' + k, { t: stamp('alerts'), v: [], note: alertsNote }); }
          else { state.fail.alerts = true; if (!state.at.alerts) alertsNote = "Couldn't load official weather warnings right now."; }
          throw e;
        }));
    } else { alerts = []; alertsNote = US_ONLY_NOTE; }
  }
  const res = await Promise.allSettled(jobs);
  const rejected = res.filter((r) => r.status === 'rejected');
  if (rejected.length < jobs.length) { lastRefresh = Date.now(); LS.set('lastRefresh.' + userKey(), lastRefresh); }
  manual = manual || state.refreshManual; state.refreshManual = false;
  if (rejected.length && manual) toast(rejected.length === jobs.length ? "Can't reach the data services — showing saved info" : 'Some data could not be updated — showing saved info for those', 3600);
  else if (manual) toast('Updated');
  if (v && v.id !== 'gps') evaluateAlerts(v, nearby, incidents, alerts);
  renderHome(); renderMini(); renderFeed(); renderAlerts(); renderHomeNews();
  refreshing = false; setRefreshSpin(false);
  if (state.refreshAgain) { state.refreshAgain = false; refreshAll(state.refreshManual); }
  else if (state.wxFailed && !wx && !state.wxRetryTimer) state.wxRetryTimer = setTimeout(() => { state.wxRetryTimer = null; refreshAll(false); }, 30000);
  if (!newsItems.length && Date.now() - newsAt > 60e3) loadNews(false);
  setTimeout(refreshPlaces, 1500);
}

/* Check the saved places you're not looking at, so alerts cover all of them (while Aflare is open). */
let placesBusy = false;
async function refreshPlaces() {
  if (!me || placesBusy || !navigator.onLine) return;
  const v = viewLoc();
  const others = data.locations.filter((l) => !v || l.id !== v.id).slice(0, 5);
  if (!others.length) return;
  placesBusy = true;
  for (const l of others) {
    const k = userKey() + '.' + l.id, c = LS.get('cache.nearby.' + k);
    if (c && Date.now() - c.t < 20 * 60e3) continue;   // checked recently
    try {
      const pts = await fetchHotspots(bboxAround(l.lat, l.lng, Math.max(50, data.settings.radius)), 24, 1500);
      LS.set('cache.nearby.' + k, { t: Date.now(), v: pts });
      let al = [];
      if (isUSPlace(l)) { try { al = await fetchAlerts(l.lat, l.lng); LS.set('cache.alerts.' + k, { t: Date.now(), v: al }); } catch (e) { /* warnings for this place will be retried next time */ } }
      evaluateAlerts(l, pts, incidents, al);
    } catch (e) { /* network hiccup — try again on the next refresh */ }
    if (!me) break;
  }
  placesBusy = false;
  renderFeed();
}

/* ------------------------------------------------------------------- home */
const firstName = () => ((data.profile.name || '').trim().split(/\s+/)[0] || '');

function rememberFocus() {
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest('.sheet')) lastFocus = a;
}
function focusSheet(id) { setTimeout(() => { const h = $(id).querySelector('h2'); if (h) h.focus({ preventScroll: true }); }, 60); }
function showInfo(title, html, actions) {
  rememberFocus();
  if (!LS.get('hint.tap')) dismissTapHint();   // they found out detail sheets exist
  $('info-title').textContent = title; $('info-body').innerHTML = html;
  $('info-actions').innerHTML = actions || '<button class="btn" onclick="closeSheets()"><span class="label">Got it</span></button>';
  $('fireSheet').classList.remove('open');
  $('fireBackdrop').classList.add('open'); $('infoSheet').classList.add('open'); $('infoSheet').scrollTop = 0;
  focusSheet('infoSheet');
}
function closeSheets() {
  const wasOpen = $('fireSheet').classList.contains('open') || $('infoSheet').classList.contains('open');
  $('fireBackdrop').classList.remove('open'); $('fireSheet').classList.remove('open'); $('infoSheet').classList.remove('open');
  if (wasOpen && lastFocus && document.contains(lastFocus) && lastFocus.offsetParent !== null) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  if (wasOpen) lastFocus = null;
  if (confirmResolve) { const f = confirmResolve; confirmResolve = null; f(false); }
}
/** In-app confirm dialog (a bottom sheet) — resolves true / false. */
let confirmResolve = null;
function confirmSheet(title, html, okLabel, danger) {
  return new Promise((res) => {
    showInfo(title, html, `<button class="btn secondary" onclick="closeSheets()"><span class="label">Cancel</span></button><button class="btn ${danger ? 'danger' : ''}" id="confirmOk" onclick="confirmYes()"><span class="label">${esc(okLabel || 'OK')}</span></button>`);
    confirmResolve = res;
  });
}
function confirmYes() { const f = confirmResolve; confirmResolve = null; closeSheets(); if (f) f(true); }

function explainIndex() {
  let html = '';
  if (wx && wx.now) {
    const pk = wx.peak;
    html += `<p><b>Now: ${esc(RISK_NAME[wx.now.key])} (${wx.now.score.toFixed(1)} / 10)</b>${pk && pk.score > wx.now.score + 0.4 ? ` · next 24 h peak: <b>${esc(RISK_NAME[pk.key])}</b> around ${esc(pk.tl)}` : ''}</p>`;
    html += partsTable(scoreParts({ rh: wx.now.rh, wind: wx.now.wind, tempF: wx.now.tempF, rain3d: wx.now.rain3d == null ? 1 : wx.now.rain3d }));
  } else html += '<p><b>No forecast loaded yet.</b> It appears once the weather forecast for this place has loaded.</p>';
  html += '<p><b>What it is:</b> Aflare\'s own 0–10 estimate of how much the <b>weather</b> favors fire spreading, from the Open-Meteo forecast: dry air and strong wind count most, then heat and days without rain.</p>'
    + '<p><b>What it is not:</b> an official fire danger rating, a prediction that a fire will start, or a sign that a fire is burning. It knows nothing about local vegetation or fire activity.</p>'
    + '<p>Fires themselves are shown separately: <b>official incidents</b> (reported by fire agencies) and <b>satellite heat detections</b> (unconfirmed). Official warnings such as Red Flag Warnings come from the National Weather Service.</p>';
  showInfo('Fire weather (Aflare estimate)', html, '<button class="btn secondary" onclick="openNews()"><span class="label">Official warnings</span></button><button class="btn" onclick="closeSheets()"><span class="label">Got it</span></button>');
}

/* -------------------------------------------------------------------- map */
let map, miniMap, miniLayer, satLayer, incLayer, perLayer, placeLayer, youMarker, searchMarker, sheetCtx = null;

function flameIcon(color, size) {
  return L.divIcon({
    className: 'flame-divicon',
    html: `<div style="width:${size}px;height:${size}px;color:${color};"><svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M12 23c-4.97 0-9-3.58-9-8 0-3.5 2-6 3-9 .5 2 1 3 2 3 0-3 1-5 3-7 0 3 .5 5 2 6 1-1 1-2.5 1-4 3 2 6 5.5 6 11 0 4.42-4.03 8-9 8z" fill="currentColor" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size],
  });
}
/** Round place marker; `big` adds a halo for the place currently shown on Home. */
const dotIcon = (c, big) => { const s = big ? 20 : 16; return L.divIcon({ className: '', html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${c};border:${big ? 3 : 2.5}px solid #fff;box-shadow:0 0 0 1.5px #2A1C17,${big ? '0 0 0 6px ' + c + '55,' : ''}0 2px 6px rgba(0,0,0,.35)"></div>`, iconSize: [s, s], iconAnchor: [s / 2, s / 2] }); };
const BASEMAPS = {
  map: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' } },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' } },
  labels: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19 } },
};
let baseLayer, labelLayer;
const OSM = BASEMAPS.map.url;
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

function initMap() {
  const h = homeLoc(), saved = LS.get('mapView');
  map = L.map('leafletMap', { zoomControl: false, attributionControl: false, preferCanvas: true, worldCopyJump: true, minZoom: 3, tap: true })
    .setView(saved ? [saved.lat, saved.lng] : h ? [h.lat, h.lng] : [39, -98], saved ? saved.z : h ? 9 : 4);
  L.control.attribution({ position: 'bottomleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(map);
  setBasemap(LS.get('basemap', 'map'));
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map);
  satLayer = L.layerGroup(); incLayer = L.layerGroup(); perLayer = L.layerGroup(); placeLayer = L.layerGroup().addTo(map);
  if (state.layers.sat) satLayer.addTo(map);
  if (state.layers.inc) incLayer.addTo(map);
  if (state.layers.per) perLayer.addTo(map);
  syncMapChips();
  map.on('moveend', () => { const c = map.getCenter(); LS.set('mapView', { lat: c.lat, lng: c.lng, z: map.getZoom() }); loadViewportSoon(); });
  map.on('zoomend', drawIncidents);
  drawIncidents(); drawPlaces();
}

function syncMapChips() {
  [['chip-sat', state.layers.sat], ['chip-inc', state.layers.inc], ['chip-per', state.layers.per], ['chip-24', state.age === 24], ['chip-72', state.age === 72]]
    .forEach(([id, on]) => { const el = $(id); if (el) { el.classList.toggle('active', !!on); el.setAttribute('aria-pressed', String(!!on)); } });
}

function setBasemap(kind) {
  kind = kind === 'sat' ? 'sat' : 'map';
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
  baseLayer = L.tileLayer(BASEMAPS[kind].url, BASEMAPS[kind].opt).addTo(map);
  baseLayer.bringToBack();
  if (kind === 'sat') labelLayer = L.tileLayer(BASEMAPS.labels.url, BASEMAPS.labels.opt).addTo(map);
  state.basemap = kind; LS.set('basemap', kind);
  $('basemapLbl').textContent = kind === 'sat' ? 'Street map' : 'Satellite';
  $('basemapBtn').setAttribute('aria-label', kind === 'sat' ? 'Switch to street map' : 'Switch to satellite imagery');
  $('leafletMap').classList.toggle('satview', kind === 'sat');
}
function toggleBasemap() { setBasemap(state.basemap === 'sat' ? 'map' : 'sat'); toast(state.basemap === 'sat' ? 'Satellite imagery' : 'Street map'); }

function initMiniMap() {
  miniMap = L.map('homeMiniMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, touchZoom: false, keyboard: false, tap: false }).setView([39, -98], 3);
  L.tileLayer(BASEMAPS.map.url, Object.assign({}, BASEMAPS.map.opt, { attribution: '' })).addTo(miniMap);
  miniLayer = L.layerGroup().addTo(miniMap);
}

/** Saved places (green), the place shown on Home (ringed) and "current location" (blue) on the big map. */
function drawPlaces() {
  if (!map || !placeLayer) return;
  placeLayer.clearLayers();
  const v = viewLoc();
  for (const l of data.locations) {
    const cur = v && v.id === l.id;
    L.marker([l.lat, l.lng], { icon: dotIcon('#1E7A3C', cur), keyboard: false, alt: l.label + ': ' + placeName(l), zIndexOffset: cur ? 2000 : 1500 })
      .bindTooltip(esc(l.label) + (cur ? ' (shown on Home)' : '')).on('click', () => openPlaceOnMap(l)).addTo(placeLayer);
  }
  if (state.gpsView) L.marker([state.gpsView.lat, state.gpsView.lng], { icon: dotIcon('#1565C0', true), keyboard: false, alt: 'Current location' }).bindTooltip('Current location').addTo(placeLayer);
}
const drawHome = drawPlaces;   // older name, still used in a few places

function openPlaceOnMap(l) {
  const s = situation(l, viewKeyFor(l) === viewKey() ? nearby : cachedNearby(l), incidents, viewKeyFor(l) === viewKey() ? alerts : cachedAlerts(l));
  showInfo(l.label, `<p class="muted">${esc(placeName(l))}</p>${placeStatusHtml(l, s)}`,
    `<button class="btn secondary" onclick="closeSheets(); setView(data.locations.find((x) => x.id === '${l.id}')); goTab('home')"><span class="label">Show on Home</span></button><button class="btn" onclick="closeSheets()"><span class="label">Close</span></button>`);
}

function renderMini() {
  if (!miniMap) return;
  miniLayer.clearLayers();
  const h = viewLoc();
  if (!h) { miniMap.setView([39, -98], 3); return; }
  miniMap.invalidateSize();   // the card may have just become visible
  const R = data.settings.radius;
  miniMap.fitBounds(L.latLng(h.lat, h.lng).toBounds(R * 1609.34 * 2.3), { animate: false });
  L.circle([h.lat, h.lng], { radius: R * 1609.34, color: '#86231E', weight: 1.5, opacity: .7, fill: false, dashArray: '5 5', interactive: false }).addTo(miniLayer);
  L.marker([h.lat, h.lng], { icon: dotIcon(state.gpsView ? '#1565C0' : '#1E7A3C'), interactive: false, keyboard: false }).addTo(miniLayer);
  nearby.filter((p) => ptAge(p) <= 24 && (!data.settings.highConfOnly || p.conf !== 'low')).slice(0, 400)
    .forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 4, color: '#2A1C17', weight: 1, opacity: .8, fillColor: HEAT_COLOR[heatClass(p.frp)], fillOpacity: .95, interactive: false }).addTo(miniLayer));
  incidents.filter((f) => distMiles(h.lat, h.lng, f.lat, f.lng) <= R * 2.5)
    .forEach((f) => L.marker([f.lat, f.lng], { icon: flameIcon(incColor(f), 18), interactive: false, keyboard: false }).addTo(miniLayer));
}

function mapShown() { setTimeout(() => { map.invalidateSize(); drawPlaces(); loadViewport(); }, 80); }

function setStatus(msg, err) { const el = $('mapStatus'); el.textContent = msg; el.classList.toggle('err', !!err); el.style.display = msg ? '' : 'none'; }

const loadViewportSoon = debounce(() => { if (currentScreen === 'map') loadViewport(); }, 450);
let viewSeq = 0, viewPoints = [], viewPointsAt = 0;

/* Detections for the visible area are cached for 5 minutes on a coarse grid,
   so small pans and zooms don't download the same data again. */
const hsCache = new Map();
function gridBox(bb, z) {
  const step = z >= 10 ? 0.25 : z >= 8 ? 0.5 : z >= 6 ? 1 : 2;
  const f = (v, up) => (up ? Math.ceil(v / step) : Math.floor(v / step)) * step;
  return { w: Math.max(-180, f(bb.getWest(), 0)), s: Math.max(-90, f(bb.getSouth(), 0)), e: Math.min(180, f(bb.getEast(), 1)), n: Math.min(90, f(bb.getNorth(), 1)) };
}
async function hotspotsFor(box, hours) {
  const key = [box.w, box.s, box.e, box.n, hours].join(',');
  const hit = hsCache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60e3) return hit;
  const v = await fetchHotspots(box, hours);
  const entry = { t: Date.now(), v };
  hsCache.set(key, entry);
  if (hsCache.size > 30) hsCache.delete(hsCache.keys().next().value);
  return entry;
}

async function loadViewport() {
  if (!map) return;
  const seq = ++viewSeq, z = map.getZoom(), bb = map.getBounds();
  let msg = '', err = false;
  if (state.layers.sat) {
    if (z < 5) { satLayer.clearLayers(); viewPoints = []; msg = 'Zoom in to see satellite heat detections'; }
    else if (!navigator.onLine) { msg = viewPoints.length ? `Offline — showing detections loaded ${ago(viewPointsAt)}` : 'Offline — satellite detections need a connection'; err = true; }
    else {
      setStatus('Loading satellite detections…');
      try {
        const res = await hotspotsFor(gridBox(bb, z), state.age);
        if (seq !== viewSeq) return;
        const all = res.v, hidden = data.settings.highConfOnly ? all.filter((p) => p.conf === 'low').length : 0;
        viewPoints = hidden ? all.filter((p) => p.conf !== 'low') : all; viewPointsAt = res.t; drawHotspots();
        const inView = viewPoints.filter((p) => bb.contains([p.lat, p.lng])).length;
        msg = `${inView.toLocaleString()} heat detection${inView === 1 ? '' : 's'} in view · last ${state.age} h${all.length >= 8000 ? ' (strongest shown)' : ''}${hidden ? ' · low-confidence hidden' : ''}`;
      } catch (e) { if (seq !== viewSeq) return; msg = viewPoints.length ? "Couldn't refresh detections — showing earlier data" : "Couldn't load satellite detections — check your connection"; err = true; }
    }
  } else satLayer.clearLayers();
  if (state.layers.per) {
    if (z >= 6 && navigator.onLine) {
      try { const gj = await fetchPerimeters({ w: bb.getWest(), s: bb.getSouth(), e: bb.getEast(), n: bb.getNorth() }, z); if (seq !== viewSeq) return; drawPerimeters(gj); } catch (e) { if (!msg) { msg = "Couldn't load fire perimeters"; err = true; } }
    } else if (z < 6) { perLayer.clearLayers(); if (!msg) msg = 'Zoom in to see fire perimeters'; }
  }
  if (!msg && state.layers.inc && !state.layers.sat) msg = `${incidents.filter((f) => bb.contains([f.lat, f.lng])).length} official incidents in view`;
  setStatus(msg, err);
}

function drawHotspots() {
  satLayer.clearLayers();
  const z = map.getZoom();
  const cell = z >= 11 ? 0 : 80 / Math.pow(2, z);
  for (const c of clusterPoints(viewPoints, cell)) {
    if (c.n === 1) {
      const p = c.pts[0];
      L.circleMarker([p.lat, p.lng], { radius: clamp(4 + Math.sqrt(p.frp), 5, 14), color: '#2A1C17', weight: 1.2, opacity: .85, fillColor: HEAT_COLOR[heatClass(p.frp)], fillOpacity: p.conf === 'low' ? .55 : .92 })
        .on('click', () => openHotspotSheet(c)).addTo(satLayer);
    } else {
      const size = clamp(20 + Math.log2(c.n) * 5, 22, 46);
      L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: `<div class="hs-count" style="width:${size}px;height:${size}px;background:${HEAT_COLOR[heatClass(c.maxFrp)]}">${c.n > 999 ? Math.round(c.n / 100) / 10 + 'k' : c.n}</div>`, iconSize: [size, size] }), keyboard: false })
        .on('click', () => { const b = L.latLngBounds(c.pts.map((p) => [p.lat, p.lng])); if (c.n > 3 && map.getZoom() < 11) map.fitBounds(b.pad(.3), { maxZoom: 12 }); else openHotspotSheet(c); }).addTo(satLayer);
    }
  }
}

/** Incident colour: deep red = large or barely contained, orange = growing, grey = fully contained. */
function incColor(f) {
  if (!incActive(f)) return '#8A7869';
  const a = f.acres || 0;
  return a >= 5000 || (f.contained != null && f.contained < 25 && a >= 500) ? '#86231E' : a >= 300 ? '#C2461F' : '#E8912D';
}
const INC_CLUSTER_Z = 11;   // from this zoom in, every incident gets its own flame
function drawIncidents() {
  if (!incLayer || !map) return;
  incLayer.clearLayers();
  const z = map.getZoom();
  if (z < INC_CLUSTER_Z) {
    // Group incidents that would sit within ~36 px of each other, so dozens of small reports don't bury the map.
    const cell = 36 * 360 / (256 * Math.pow(2, z)), cells = new Map();
    for (const f of incidents) {
      const k = Math.floor(f.lat / cell) + ':' + Math.floor(f.lng / cell);
      const c = cells.get(k) || { fs: [], sLat: 0, sLng: 0 };
      c.fs.push(f); c.sLat += f.lat; c.sLng += f.lng; cells.set(k, c);
    }
    for (const c of cells.values()) {
      if (c.fs.length === 1) { addIncidentMarker(c.fs[0]); continue; }
      const active = c.fs.filter(incActive).length, lat = c.sLat / c.fs.length, lng = c.sLng / c.fs.length;
      const size = clamp(24 + Math.log2(c.fs.length) * 5, 28, 46);
      L.marker([lat, lng], { icon: L.divIcon({ className: '', html: `<div class="inc-count" style="width:${size}px;height:${size}px"><svg aria-hidden="true"><use href="#i-flame"/></svg>${c.fs.length}</div>`, iconSize: [size, size] }), keyboard: false, alt: `${c.fs.length} incidents, ${active} not fully contained` })
        .bindTooltip(`${c.fs.length} official incidents (${active} not fully contained) — tap to zoom in`)
        .on('click', () => { const bnds = L.latLngBounds(c.fs.map((f) => [f.lat, f.lng])); if (map.getZoom() >= INC_CLUSTER_Z - 1 || bnds.getNorthEast().distanceTo(bnds.getSouthWest()) < 200) openIncidentGroup(c.fs); else map.fitBounds(bnds.pad(.25), { maxZoom: INC_CLUSTER_Z }); }).addTo(incLayer);
    }
  } else incidents.forEach(addIncidentMarker);
}
/** A few incidents at nearly the same spot: list them instead of zooming forever. */
function openIncidentGroup(fs) {
  state.incGroup = fs.slice().sort((a, b) => incActive(b) - incActive(a) || (b.updated || 0) - (a.updated || 0));
  showInfo(`${fs.length} incidents here`, state.incGroup.map((f, i) => `<button class="nearrow k-inc" onclick="closeSheets(); openIncidentSheet(state.incGroup[${i}])"><span class="ic" aria-hidden="true"><svg><use href="#i-flame"/></svg></span><span class="grow"><span class="h">${esc(f.name)}</span><span class="s">${esc(incSize(f))} · ${esc(incContain(f))} · updated ${esc(ago(f.updated))}</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>`).join(''));
}
function addIncidentMarker(f) {
  const a = f.acres || 0, size = a >= 10000 ? 34 : a >= 1000 ? 30 : a >= 100 ? 27 : 24;
  L.marker([f.lat, f.lng], { icon: flameIcon(incColor(f), size), keyboard: false, zIndexOffset: incActive(f) ? 200 : 0 })
    .bindTooltip(esc(f.name)).on('click', () => openIncidentSheet(f)).addTo(incLayer);
}

function drawPerimeters(gj) {
  perLayer.clearLayers();
  L.geoJSON(gj, {
    style: { color: '#86231E', weight: 2.5, fillColor: '#C2461F', fillOpacity: .2, dashArray: '6 4' },
    onEachFeature: (f, l) => { const p = f.properties || {}; l.bindTooltip(`${esc(incidentTitle(p.poly_IncidentName))} · ${Math.round(p.poly_GISAcres || 0).toLocaleString()} acres mapped`); },
  }).addTo(perLayer);
}

function toggleLayer(name) {
  state.layers[name] = !state.layers[name]; saveMapPrefs(); syncMapChips();
  const layer = name === 'sat' ? satLayer : name === 'inc' ? incLayer : perLayer;
  if (state.layers[name]) { layer.addTo(map); loadViewport(); } else { map.removeLayer(layer); loadViewport(); }
}
function setAge(h) { state.age = h === 72 ? 72 : 24; saveMapPrefs(); syncMapChips(); loadViewport(); }

/* ---- search: go to a place, then offer to save it */
async function searchPlace(e) {
  e.preventDefault();
  const q = $('mapSearch').value.trim(); if (!q) return;
  $('mapSearch').blur();
  setStatus('Searching…');
  try {
    const g = await geocode(q);
    if (!g) { setStatus(''); return toast('No place found for “' + q + '”. Try adding a state or country.', 3600); }
    state.searchHit = Object.assign({ q }, g);
    map.setView([g.lat, g.lng], 10);
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([g.lat, g.lng], { icon: dotIcon('#2F4A63', true), keyboard: false, alt: 'Search result: ' + g.label }).bindTooltip(esc(g.label)).addTo(map);
    renderSearchHit();
  } catch (err) { setStatus(''); toast(navigator.onLine ? "Search isn't available right now — try again in a moment" : 'Search needs a connection'); }
}
function renderSearchHit() {
  const el = $('searchHit'), g = state.searchHit;
  if (!g) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const saved = data.locations.find((l) => Math.abs(l.lat - g.lat) < 0.01 && Math.abs(l.lng - g.lng) < 0.01);
  el.style.display = '';
  el.innerHTML = `<span class="grow"><span class="h">${esc(g.label)}</span><span class="s">${saved ? 'Saved as “' + esc(saved.label) + '”' : 'Search result'}</span></span>`
    + (saved ? `<button class="btn small" onclick="setView(data.locations.find((x) => x.id === '${saved.id}')); goTab('home')"><span class="label">Show on Home</span></button>`
      : `<button class="btn small" onclick="saveSearchHit()"><svg class="bi" aria-hidden="true"><use href="#i-plus"/></svg><span class="label">Save place</span></button>`)
    + '<button class="iconbtn" onclick="clearSearchHit()" aria-label="Close search result"><svg aria-hidden="true"><use href="#i-x"/></svg></button>';
}
function saveSearchHit() {
  const g = state.searchHit; if (!g) return;
  const loc = addLocation({ label: g.label.split(',')[0], place: g.label, lat: g.lat, lng: g.lng, country: g.country, county: g.county || '', state: g.state || '' }, { view: true, quiet: true });
  toast('Saved ' + g.label + ' — it now shows on Home');
  renderSearchHit(); return loc;
}
function clearSearchHit() { state.searchHit = null; if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; } $('mapSearch').value = ''; renderSearchHit(); }

async function locateOnMap() {
  setStatus('Finding your location…');
  try {
    const p = await getPosition();
    const ll = [p.coords.latitude, p.coords.longitude];
    if (youMarker) map.removeLayer(youMarker);
    youMarker = L.marker(ll, { icon: dotIcon('#1565C0', true), keyboard: false, alt: 'You are here' }).addTo(map).bindTooltip(`You are here (±${Math.round(p.coords.accuracy)} m)`);
    map.setView(ll, 11);
  } catch (e) { setStatus(''); toast(geoErrorText(e), 4500); }
}

function geoErrorText(e) {
  if (e && e.code === 1) return 'Location permission is off. Allow it in your browser settings, or enter an address instead.';
  if (e && e.code === 3) return 'Finding your location took too long. Try again outdoors or enter an address.';
  return (e && e.message) || "Couldn't get your location.";
}

/* ----------------------------------------------------------- fire sheets */
/** Distance from the place shown on Home, with a short label for it ("From Home", "From Cabin"). */
function distFromView(lat, lng) {
  const v = viewLoc(); if (!v) return ['—', 'Distance'];
  return [fmtMi(distMiles(v.lat, v.lng, lat, lng)) + ' ' + compass(v.lat, v.lng, lat, lng), 'From ' + (state.gpsView ? 'you' : v.label.length > 12 ? 'your place' : v.label)];
}
const SAT_NAMES = { N: 'Suomi NPP', N20: 'NOAA-20', N21: 'NOAA-21', 1: 'NOAA-20', 2: 'NOAA-21' };
const whenLocal = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown');

function fillSheet(kind, title, sub, stats, rows, note, ext) {
  rememberFocus();
  $('fireSheet').dataset.kind = kind;
  $('fs-kind').textContent = kind === 'inc' ? 'Official incident' : 'Satellite heat · unconfirmed';
  $('fs-name').querySelector('span').textContent = title; $('fs-sub').textContent = sub;
  stats.forEach((s, i) => { $('fs-v' + (i + 1)).textContent = s[0]; $('fs-l' + (i + 1)).textContent = s[1]; });
  $('fs-details').innerHTML = rows.filter((r) => r && r[1]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
  $('fs-note').innerHTML = note; $('fs-ext').textContent = ext;
  $('fireBackdrop').classList.add('open'); $('fireSheet').classList.add('open'); $('infoSheet').classList.remove('open');
  $('fireSheet').scrollTop = 0;
  focusSheet('fireSheet');
}

function openIncidentSheet(f) {
  sheetCtx = { kind: 'inc', f };
  const staleDays = f.updated ? Math.floor((Date.now() - f.updated) / 864e5) : null;
  fillSheet('inc', f.name, [f.county ? f.county + ' County' : '', f.state].filter(Boolean).join(', ') || 'United States',
    [[f.contained == null ? 'Not reported' : f.contained + '%', 'Contained'], [f.acres == null ? 'Not reported' : f.acres.toLocaleString(), 'Acres'], distFromView(f.lat, f.lng)],
    [['Reported', f.discovered ? esc(shortDate(f.discovered)) + ' <span class="muted">(' + ago(f.discovered) + ')</span>' : ''],
      ['Last updated', f.updated ? esc(ago(f.updated)) + (staleDays >= 14 ? ` <span class="warnline">— no update in ${staleDays} days; it may be out or inactive</span>` : '') : 'Unknown'],
      ['Lead agency', esc(AGENCY_NAMES[f.agency] || f.agency)], ['Part of', esc(f.complex)], ['Incident ID', esc(f.ufid)]],
    'Reported by fire agencies to the National Interagency Fire Center (NIFC). Size and containment are entered by incident staff and can lag hours or days behind the fire. <b>Evacuation orders come from your county or sheriff</b> — follow them.', 'Search for updates ↗');
}
function openHotspotSheet(c) {
  const p = c.pts && c.pts.length === 1 ? c.pts[0] : null;
  sheetCtx = { kind: 'hs', c };
  const near = incidents.map((f) => ({ f, d: distMiles(c.lat, c.lng, f.lat, f.lng) })).filter((x) => x.d <= 5).sort((a, b) => a.d - b.d)[0];
  fillSheet('hs', c.n > 1 ? `${c.n} heat detections` : 'Heat detection', `Seen ${whenLocal(c.t)} (${ago(c.t)})`,
    [[Math.round(c.maxFrp) + ' MW', c.n > 1 ? 'Peak heat' : 'Heat (FRP)'], [c.conf ? c.conf[0].toUpperCase() + c.conf.slice(1) : '—', 'Confidence'], distFromView(c.lat, c.lng)],
    [['Official incident nearby', near ? `<button class="linkbtn" onclick="openIncidentSheet(incidents.find((x) => x.id === '${esc(near.f.id)}'))">${esc(near.f.name)}</button> · ${fmtMi(near.d)} away` : 'None reported within 5 mi'],
      ['Satellite', p ? 'VIIRS · ' + esc(SAT_NAMES[p.sat] || p.sat || '') + (p.dn ? (p.dn === 'D' ? ' · daytime pass' : ' · nighttime pass') : '') : 'VIIRS (NASA FIRMS)']],
    'A spot that looked much hotter than its surroundings to a satellite. It <b>may or may not be a wildfire</b>: prescribed burns, farm fires and industrial heat also show up, and clouds or smoke can hide real fires. <b>If you can see flames or smoke that may be unreported, call emergency services.</b>', 'View on NASA FIRMS ↗');
}
function openFireExternal() {
  if (!sheetCtx) return;
  const f = sheetCtx.f;
  const url = sheetCtx.kind === 'inc' ? 'https://www.google.com/search?q=' + encodeURIComponent(`"${f.rawName || f.name}" fire ${f.county || ''} ${f.state || ''} inciweb OR evacuation`) : `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${sheetCtx.c.lng.toFixed(3)},${sheetCtx.c.lat.toFixed(3)},11z`;
  window.open(url, '_blank', 'noopener');
}

/* ------------------------------------------------------------------ learn */
const GRAD = 'linear-gradient(135deg,var(--maroon),var(--red) 55%,#e0793e)';
const NEWTAB = '<span class="sr-only"> (opens in a new tab)</span>';
const ytThumb = (id) => `<img loading="lazy" alt="" src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" onerror="this.remove()"><span class="playdot"><span class="pd"><svg aria-hidden="true"><use href="#i-play"/></svg></span></span>`;
const photoThumb = (id) => `<img loading="lazy" alt="" src="img/learn/${id}-thumb.jpg">`;
function renderLearn() {
  const fa = ARTICLES.find((a) => a.id === FEATURED_ID) || ARTICLES[0];
  $('featured-title').textContent = fa.title; $('featured-meta').textContent = fa.cat + ' · ' + fa.meta.split('·')[0].trim();
  $('featured-card').setAttribute('aria-label', 'Featured article: ' + fa.title);
  const cats = ['All', ...new Set([...ARTICLES, ...VIDEOS].map((x) => x.cat))];
  const f = state.learnCat || 'All';
  $('learnFilter').innerHTML = cats.map((c) => `<button class="chip ${c === f ? 'active' : ''}" aria-pressed="${c === f}" onclick="setLearnCat('${esc(c)}')">${esc(c)}</button>`).join('');
  const arts = ARTICLES.filter((a) => f === 'All' || a.cat === f), vids = VIDEOS.filter((v) => f === 'All' || v.cat === f);
  const done = data.read || {};
  $('articlelist').innerHTML = arts.length ? arts.map((a) => `<button class="listcard" onclick="openArticle('${a.id}','learn')"><span class="thumb">${photoThumb(a.id)}</span><span class="info"><span class="h">${esc(a.title)}</span><span class="m"><span class="taglet">${esc(a.cat)}</span>${esc(a.meta.split('·')[0])}${done[a.id] ? '<span class="readmark">✓ Read</span>' : ''}</span></span></button>`).join('') : '<p class="emptystate">No articles in this topic yet.</p>';
  $('videolist').innerHTML = !vids.length ? '<p class="emptystate">No videos in this topic yet.</p>' : vids.map((v) => `<button class="listcard" onclick="openVideo('${v.id}','learn')"><span class="thumb">${ytThumb(v.id)}</span><span class="info"><span class="h">${esc(v.title)}</span><span class="m"><span class="taglet">${esc(v.cat)}</span>${esc(v.channel)}${done[v.id] ? '<span class="readmark">✓ Watched</span>' : ''}</span></span></button>`).join('');
  $('reslist').innerHTML = RESOURCES.map((r) => `<a class="listcard" href="${r.u}" target="_blank" rel="noopener"><span class="info"><span class="h">${esc(r.t)}</span><span class="m">${esc(r.s)}</span></span>${NEWTAB}</a>`).join('');
  renderChecklist();
}

function renderChecklist() {
  const done = data.checklist || {};
  $('clitems').innerHTML = CHECKLIST.map((g) => `<div class="clgroup"><h3 class="clg">${esc(g.g)}</h3>` + g.items.map((it) => {
    const on = !!done[it.id];
    const how = it.a ? `<button class="clhow" onclick="openArticle('${it.a}','learn')">How to</button>`
      : it.u ? `<a class="clhow" href="${esc(it.u)}" target="_blank" rel="noopener">${esc(it.ul || 'Learn how')}${NEWTAB}</a>`
      : it.act ? `<button class="clhow" onclick="${it.act}()">${esc(it.ul)}</button>` : '';
    return `<div class="clrow"><button class="clitem ${on ? 'checked' : ''}" id="cl-${it.id}" role="checkbox" aria-checked="${on}" onclick="toggleCheck('${it.id}')"><span class="box" aria-hidden="true"><svg><use href="#i-check"/></svg></span><span class="label">${esc(it.t)}${it.s ? `<span class="clsub">${esc(it.s)}</span>` : ''}</span></button>${how}</div>`;
  }).join('') + '</div>').join('');
  const n = CHECK_ITEMS.filter((it) => done[it.id]).length;
  $('clbar').style.width = (n / CHECK_ITEMS.length * 100) + '%'; $('cltxt').textContent = `${n} of ${CHECK_ITEMS.length} done`;
  $('clreset').style.display = n ? '' : 'none';
}
function toggleCheck(id) {
  data.checklist = data.checklist || {};
  if (data.checklist[id]) delete data.checklist[id]; else data.checklist[id] = Date.now();
  saveData(); renderChecklist();
  const b = $('cl-' + id); if (b) b.focus({ preventScroll: true });
  if (CHECK_ITEMS.every((it) => data.checklist[it.id])) toast('Checklist complete — nice work staying ready');
}
async function resetChecklist() {
  if (!(await confirmSheet('Start the checklist over?', '<p>This unticks every item, for example at the start of a new fire season.</p>', 'Start over'))) return;
  data.checklist = {}; saveData(); renderChecklist(); toast('Checklist reset');
}
function setLearnCat(c) { state.learnCat = c; renderLearn(); }

function renderRelated(currentId) {
  const cur = [...ARTICLES, ...VIDEOS].find((x) => x.id === currentId) || {};
  const items = [...ARTICLES.map((a) => ({ k: 'a', id: a.id, t: a.title, c: a.cat })), ...VIDEOS.map((v) => ({ k: 'v', id: v.id, t: v.title, c: v.cat }))]
    .filter((x) => x.id !== currentId).sort((a, b) => (b.c === cur.cat) - (a.c === cur.cat)).slice(0, 3);
  $('art-related').innerHTML = '<h2 class="relhead">You might also like</h2><div class="card list">' + items.map((it) => `<button class="listcard" onclick="${it.k === 'v' ? 'openVideo' : 'openArticle'}('${it.id}','${state.returnTo}')"><span class="thumb">${it.k === 'v' ? ytThumb(it.id) : photoThumb(it.id)}</span><span class="info"><span class="h">${esc(it.t)}</span><span class="m"><span class="taglet">${esc(it.c)}</span>${it.k === 'v' ? 'Video' : 'Article'}</span></span></button>`).join('') + '</div>';
}

function photoCredit(c) {
  if (!c) return '';
  return `Photo: ${esc(c.author)} · <a href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(c.license)}${NEWTAB}</a>`;
}

function openArticle(id, from) {
  const a = ARTICLES.find((x) => x.id === id); if (!a) return;
  state.returnTo = from;
  const ph = photoFor(id);
  $('art-bg').style.background = ''; $('art-bg').style.backgroundImage = ph ? `url("img/learn/${id}.jpg")` : GRAD;
  $('art-bg').setAttribute('role', 'img'); $('art-bg').setAttribute('aria-label', ph ? ph.description : '');
  $('art-credit').innerHTML = photoCredit(ph);
  $('art-head').classList.remove('isvideo'); $('art-video').style.display = 'none'; $('art-video').innerHTML = '';
  $('art-cat').textContent = a.cat; $('art-title').textContent = a.title; $('art-meta').textContent = a.meta;
  $('art-body').innerHTML = a.body.map((p) => `<p>${p}</p>`).join('');
  state.cur = { kind: 'a', id, title: a.title };
  renderRelated(id); show('article'); updateDoneBtn();
}
function openVideo(id, from) {
  const v = VIDEOS.find((x) => x.id === id); if (!v) return;
  state.returnTo = from;
  $('art-bg').style.backgroundImage = ''; $('art-bg').style.background = '#000'; $('art-bg').removeAttribute('role'); $('art-bg').removeAttribute('aria-label');
  $('art-credit').innerHTML = ''; $('art-head').classList.add('isvideo');
  $('art-video').style.display = 'block';
  $('art-cat').textContent = v.cat + ' · Video'; $('art-title').textContent = v.title; $('art-meta').textContent = 'From ' + v.channel + ' on YouTube';
  $('art-body').innerHTML = v.body.map((p) => `<p>${esc(p)}</p>`).join('') + `<p><a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Watch on YouTube${NEWTAB}</a></p>`;
  state.cur = { kind: 'v', id, title: v.title };
  renderRelated(id); show('article'); updateDoneBtn();
  $('art-video').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${v.id}?rel=0&playsinline=1" title="${esc(v.title)}" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

/* ------------------------------------------------------------------- news */
const liveAlerts = () => alerts.filter((a) => !a.ends || a.ends > Date.now());
function alertCard(a) {
  const sev = a.severity && a.severity !== 'Unknown' ? a.severity : '';
  const area = (a.area || '').split(';').map((x) => x.trim()).filter(Boolean);
  return `<button class="alertcard clickable ${a.fire ? 'fire' : 'other'}" onclick="openAlert('${esc(a.id)}')"><span class="srcline">Official · ${esc(a.sender)}</span>`
    + `<span class="h">${esc(a.event)}${sev ? ` <span class="sevtag">${esc(sev)}</span>` : ''}</span>`
    + `<span class="s">${esc(area.slice(0, 3).join('; '))}${area.length > 3 ? ` and ${area.length - 3} more areas` : ''}</span>`
    + `<span class="s">Issued ${esc(ago(a.sent))}${a.ends ? ' · ' + esc(untilText(a.ends)) : ''}</span><span class="morelink">${a.instr ? 'Details and what to do' : 'Details'}</span></button>`;
}
function renderAlerts() {
  const h = viewLoc(), el = $('alertsList');
  $('alertsFor').textContent = h ? 'For ' + placeName(h) : '';
  if (!h) { el.innerHTML = '<div class="alertcard calm"><span class="h">No place chosen yet</span><span class="s">Add a place on Home to see official warnings for it.</span></div>'; return; }
  const live = liveAlerts(), checked = state.at.alerts ? 'Checked ' + ago(state.at.alerts) : '';
  if (!live.length) {
    el.innerHTML = `<div class="alertcard calm"><span class="h">${esc(alertsNote ? (alertsNote === US_ONLY_NOTE ? 'Not available for this place' : 'Warnings unavailable') : 'No active warnings')}</span><span class="s">${esc(alertsNote || 'National Weather Service · ' + placeName(h) + (checked ? ' · ' + checked : ''))}</span>${alertsNote && alertsNote !== US_ONLY_NOTE ? '<button class="linkbtn" onclick="refreshAll(true)">Try again</button>' : ''}</div>`;
    return;
  }
  const fire = live.filter((a) => a.fire), other = live.filter((a) => !a.fire);
  el.innerHTML = (fire.length ? fire.map(alertCard).join('') : `<div class="alertcard calm"><span class="h">No fire-related warnings</span><span class="s">National Weather Service · ${esc(placeName(h))}</span></div>`)
    + (other.length ? `<h3 class="subhead">Other weather alerts here</h3>` + other.map(alertCard).join('') : '')
    + (checked ? `<p class="fineprint">${esc(checked)}${alertsNote ? ' · ' + esc(alertsNote) : ''}</p>` : '');
}

let newsLoading = 0, newsFailAt = 0, newsFailKey = '';
async function loadNews(manual) {
  renderNewsScope();
  const scope = newsRegion();
  const ck = 'cache.news' + (scope ? '.' + scope.toLowerCase() : '');
  if (!manual && newsItems.length && newsScopeKey === ck && Date.now() - newsAt < 10 * 60e3) return renderNews();
  if (newsLoading && newsScopeKey === ck) return;
  if (!manual && newsFailKey === ck && newsScopeKey === ck && Date.now() - newsFailAt < 60e3) return;   // it just failed — don't hit a busy service on every screen change; Refresh still tries
  newsLoading++;
  $('newsRefresh').textContent = 'Loading…'; $('newsRefresh').classList.add('busy');
  if (newsScopeKey !== ck) { const c = LS.get(ck); newsItems = c ? c.v : []; newsAt = c ? c.t : 0; newsScopeKey = ck; $('newslist').innerHTML = newsItems.length ? '' : '<div class="muted-txt">Loading headlines…</div>'; if (newsItems.length) renderNews(); }
  try {
    let items;
    try { items = await fetchNews(scope); }
    catch (e1) { if (/HTTP 502/.test(e1.message)) throw e1; await sleep(6000); items = await fetchNews(scope); }   // GDELT allows 1 request / 5 s — retry once (not when the Worker already tried twice)
    newsFailAt = 0;
    if (newsScopeKey === ck) { newsItems = items; newsAt = Date.now(); LS.set(ck, { t: newsAt, v: newsItems }); renderNews(); if (manual) toast('Headlines updated'); }
  } catch (e) {
    newsFailAt = Date.now(); newsFailKey = ck;
    if (newsScopeKey === ck) renderNews(newsItems.length ? '' : "Couldn't load headlines right now — the news service is slow or busy, or you may be offline. Try Refresh in a minute, or search the news yourself with the link below.");
    if (manual && newsItems.length) toast("Couldn't refresh — showing saved headlines");
  }
  newsLoading = Math.max(0, newsLoading - 1);
  if (!newsLoading) { $('newsRefresh').textContent = 'Refresh'; $('newsRefresh').classList.remove('busy'); }
  renderHomeNews();
}
function renderNews(errMsg) {
  const el = $('newslist');
  if (!newsItems.length) { el.innerHTML = `<p class="emptystate">${esc(errMsg || (newsRegion() ? 'No recent wildfire headlines mention ' + newsRegion() + '. Try “Everywhere”.' : 'No headlines yet.'))}</p>`; return; }
  el.innerHTML = newsItems.map((n) => `<a class="listcard" href="${esc(n.url)}" target="_blank" rel="noopener"><span class="thumb"><svg aria-hidden="true"><use href="#i-news"/></svg>${n.img ? `<img loading="lazy" alt="" referrerpolicy="no-referrer" src="${esc(n.img)}" onerror="this.remove()">` : ''}</span><span class="info"><span class="h">${esc(n.title)}</span><span class="m">${esc(n.domain)} · ${ago(n.t)}</span></span>${NEWTAB}</a>`).join('');
}

/* ---------------------------------------------------------- notifications */
const FEED_KIND = { hs: 'Satellite heat · unconfirmed', inc: 'Official incident', nws: 'Official warning' };
function renderFeed() {
  const el = $('notiflist');
  const s = data.settings, perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notifStatus').innerHTML = !data.locations.length ? 'Add a place to start getting alerts.'
    : `Watching ${data.locations.length} place${data.locations.length > 1 ? 's' : ''} within ${s.radius} mi. ${s.push && perm === 'granted' ? 'Phone notifications are on.' : 'Phone notifications are off — alerts only appear here.'} <button class="linkbtn" onclick="openAlertSettings()">Settings</button>`;
  if (!feed.length) { el.innerHTML = '<p class="emptystate">No alerts yet.<br>New satellite heat detections, official incidents and fire-weather warnings near your saved places will appear here.</p>'; }
  else el.innerHTML = feed.map((n, i) => `<button class="notifitem ${n.unread ? '' : 'read'}" onclick="openFeed(${i})"><span class="ic k-${esc(n.kind || 'x')}" aria-hidden="true"><svg><use href="#${esc(n.icon || 'i-bell')}"/></svg></span><span class="grow">${n.kind ? `<span class="k">${esc(FEED_KIND[n.kind] || '')}</span>` : ''}<span class="h">${n.unread ? '<span class="sr-only">Unread: </span>' : ''}${esc(n.h)}</span><span class="t">${n.sub ? esc(n.sub) + ' · ' : ''}added ${esc(ago(n.t))}</span></span><span class="unread" aria-hidden="true"></span></button>`).join('');
  updateNotifDot();
}
function openFeed(i) {
  const n = feed[i]; if (!n) return;
  n.unread = false; saveFeed(); updateNotifDot(); renderFeed();
  const g = n.goto || {};
  const place = g.place && data.locations.find((l) => l.id === g.place);
  if (g.kind === 'nws') {
    if (place && (!viewLoc() || viewLoc().id !== place.id)) setView(place, { quiet: true });
    show('news');
    setTimeout(() => { if (alerts.some((a) => String(a.id) === String(g.alert))) openAlert(g.alert); else toast('This warning has ended or is no longer active', 3500); }, 300);
    return;
  }
  if (g.lat != null) {
    goTab('map');
    setTimeout(() => {
      map.setView([g.lat, g.lng], Math.max(map.getZoom(), 11));
      if (g.kind === 'inc') { const f = incidents.find((x) => x.id === g.id); if (f) openIncidentSheet(f); else toast('This incident is no longer in the current incident list', 3500); }
      else if (g.kind === 'hs') openHotspotSheet({ lat: g.lat, lng: g.lng, n: g.n || 1, maxFrp: g.maxFrp || 0, t: g.t, conf: g.conf || 'nominal', pts: [] });
    }, 200);
    return;
  }
  if (g.screen) { if (MAIN_TABS.includes(g.screen)) goTab(g.screen); else show(g.screen); }
}
function markAllRead() { feed.forEach((n) => (n.unread = false)); saveFeed(); renderFeed(); }
function updateNotifDot() {
  const n = feed.filter((x) => x.unread).length;
  $('notifdot').style.display = n ? 'block' : 'none';
  $('bellBtn').setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
}

/* ---------------------------------------------------------------- profile */
function renderProfile() {
  if (!me) return;
  $('profile-name').textContent = data.profile.name || me.name; $('profile-email').textContent = me.email || '';
  $('acctMode').textContent = me.mode === 'cloud' ? 'Synced account (Firebase)' : 'On-device account · not synced';
  renderSyncLine();
  renderIdentity();
  const v = viewLoc();
  $('locationlist').innerHTML = data.locations.length ? data.locations.map((l) => `<div class="listrow locrow"><svg aria-hidden="true"><use href="#i-pin"/></svg><div class="grow"><span class="h">${esc(l.label)} ${l.default ? '<span class="badge">Home</span>' : ''}${v && v.id === l.id ? ' <span class="badge soft">On Home now</span>' : ''}</span><span class="s">${esc(l.place)}</span><div class="rowact left">${v && v.id === l.id ? '' : `<button class="rowbtn" onclick="pickPlace('${l.id}'); goTab('home')" aria-label="Show ${esc(l.label)} on Home">Show on Home</button>`}<button class="rowbtn" onclick="viewLocation('${l.id}')" aria-label="Show ${esc(l.label)} on the map">Map</button>${l.default ? '' : `<button class="rowbtn" onclick="makeHome('${l.id}')" aria-label="Make ${esc(l.label)} your home place">Make home</button>`}<button class="rowbtn" onclick="renameLoc('${l.id}')" aria-label="Rename ${esc(l.label)}">Rename</button><button class="rowbtn danger" onclick="removeLoc('${l.id}')" aria-label="Remove ${esc(l.label)}">Remove</button></div></div></div>`).join('') : '<p class="emptystate">No places yet. Add your current location or an address below.</p>';
  $('contactlist').innerHTML = data.contacts.length ? data.contacts.map((c) => { const num = c.phone.replace(/[^\d+]/g, ''); return `<div class="listrow locrow"><svg aria-hidden="true"><use href="#i-user"/></svg><div class="grow"><span class="h">${esc(c.name)}</span><span class="s">${esc(c.phone)}</span><div class="rowact left"><a class="ract" href="tel:${esc(num)}" aria-label="Call ${esc(c.name)}">Call</a><a class="ract" href="sms:${esc(num)}" aria-label="Text ${esc(c.name)}">Text</a><button class="rowbtn danger" onclick="removeContact('${c.id}')" aria-label="Remove ${esc(c.name)}">Remove</button></div></div></div>`; }).join('') : '<p class="emptystate">Add people you would text if you had to leave. They appear on the Call tab.</p>';
  renderVerifyLine();
  const s = data.settings;
  $('sw-wx').classList.toggle('on', !!s.wxAlerts); $('sw-conf').classList.toggle('on', !!s.highConfOnly);
  document.querySelectorAll('#radiusrow .rchip').forEach((c) => c.classList.toggle('active', +c.dataset.r === s.radius));
  const perm = !('Notification' in window) ? 'unsupported' : Notification.permission;
  $('sw-push').classList.toggle('on', !!(s.push && perm === 'granted'));
  $('pushStatus').textContent = pushStatusText();
  syncStates();
  updateInstallUI();
}

/** Says exactly what notifications can do on this device — no more. */
function pushStatusText() {
  const s = data.settings, perm = !('Notification' in window) ? 'unsupported' : Notification.permission;
  if (perm === 'unsupported') return isIOS && !isStandalone() ? 'On iPhone and iPad, add Aflare to your Home Screen first' : "This browser can't show notifications — alerts appear in the bell list";
  if (perm === 'denied') return 'Blocked — allow notifications for this site in your browser settings';
  if (!(s.push && perm === 'granted')) return 'Off — alerts appear only in the bell list';
  if (state.bgSync === 'on') return 'On · while Aflare is open, plus occasional background checks when the browser allows (not guaranteed)';
  return isIOS ? 'On · only while Aflare is open (iPhone and iPad don\'t allow background checks)' : 'On · only while Aflare is open. Background checks need the installed app in Chrome on Android.';
}

function renderSyncLine() {
  const el = $('syncLine'); if (!el || !me) return;
  if (me.mode !== 'cloud') { el.textContent = 'Places, contacts and settings are saved in this browser only. Clearing site data removes them.'; return; }
  el.textContent = sync.state === 'saving' ? 'Saving to your account…'
    : sync.state === 'error' ? 'Last change is saved on this device but has not synced yet. Aflare will try again with your next change.'
    : sync.state === 'offline-copy' ? "Couldn't reach your account — showing this device's copy."
    : sync.at ? 'Synced to your account · ' + ago(sync.at) : 'Synced to your account';
}

function toggleEditProfile() {
  const f = $('editProfileForm'), open = f.style.display === 'none';
  if (open) $('editName').value = data.profile.name || '';
  f.style.display = open ? 'flex' : 'none';
}
function saveProfile() {
  const n = $('editName').value.trim();
  if (!n) return toast('Name is required');
  data.profile.name = n; me.name = n; saveData();
  if (me.mode === 'cloud' && fbAuth.currentUser) fbAuth.currentUser.updateProfile({ displayName: n }).catch(() => {});
  else { const acc = LS.get('accounts', {}); if (acc[me.id]) { acc[me.id].name = n; LS.set('accounts', acc); } }
  toggleEditProfile(); renderProfile(); renderHome(); toast('Profile updated');
}

function toggleAddLocation() { const f = $('addLocForm'); f.style.display = f.style.display === 'none' ? 'flex' : 'none'; }

/** Look up an address typed in any "add a place" box and save it. Returns the new place, or null. */
async function addPlaceFromQuery(q, label, btn) {
  q = (q || '').trim();
  if (!q) { toast('Type a city or address first'); return null; }
  if (btn) { if (btn.classList.contains('loading')) return null; btn.classList.add('loading'); }
  try {
    const g = await geocode(q);
    if (!g) { toast("Couldn't find that place — try adding a city, state or country", 3600); return null; }
    const dup = data.locations.find((l) => Math.abs(l.lat - g.lat) < 0.005 && Math.abs(l.lng - g.lng) < 0.005);
    if (dup) { setView(dup); toast('You already saved this place as “' + dup.label + '”'); return dup; }
    const loc = addLocation({ label: (label || '').trim() || g.label.split(',')[0], place: g.label, lat: g.lat, lng: g.lng, country: g.country, county: g.county || '', state: g.state || '' }, { view: true });
    return loc;
  } catch (e) { toast(navigator.onLine ? "Address lookup isn't available right now — try again in a moment" : 'Looking up an address needs a connection'); return null; }
  finally { if (btn) btn.classList.remove('loading'); }
}

async function saveLocation(btn) {
  const loc = await addPlaceFromQuery($('newLocCity').value, $('newLocName').value, btn);
  if (loc) { $('newLocName').value = ''; $('newLocCity').value = ''; toggleAddLocation(); }
}

/** Save a place. With opts.view it also becomes the place shown on Home. */
function addLocation(loc, opts) {
  const first = !data.locations.length;
  const l = Object.assign({ id: 'loc' + Date.now() + Math.floor(Math.random() * 99), default: first }, loc);
  data.locations.push(l);
  saveData(); mirrorForServiceWorker();
  if (first || (opts && opts.view)) setView(l, { quiet: true });
  else { renderHome(); drawPlaces(); }
  renderProfile();
  if (!(opts && opts.quiet)) toast('Saved ' + l.place + (first || (opts && opts.view) ? ' — now showing on Home' : ''));
  return l;
}
function makeHome(id) {
  data.locations.forEach((l) => (l.default = l.id === id));
  saveData(); renderProfile(); renderHome(); drawPlaces(); toast('Home place updated — Aflare opens on it first');
}
async function removeLoc(id) {
  const l = data.locations.find((x) => x.id === id); if (!l) return;
  if (!(await confirmSheet('Remove this place?', `<p><b>${esc(l.label)}</b> — ${esc(l.place)}</p><p>Aflare will stop checking for fires and warnings here.</p>`, 'Remove', true))) return;
  const wasDefault = l.default;
  const viewing = viewLoc() && viewLoc().id === id;
  data.locations = data.locations.filter((x) => x.id !== id);
  if (wasDefault && data.locations.length) data.locations[0].default = true;
  ['nearby', 'wx', 'air', 'alerts'].forEach((c) => LS.del(`cache.${c}.${userKey()}.${id}`)); LS.del(`alertsInit.${userKey()}.${id}`);
  saveData(); mirrorForServiceWorker(); toast('Place removed');
  if (viewing) { state.viewId = null; LS.del('view.' + userKey()); const n = homeLoc(); if (n) setView(n, { quiet: true }); else { loadViewCaches(); renderHome(); renderMini(); renderAlerts(); } }
  else { renderHome(); }
  renderProfile(); drawPlaces();
}

/** Save this device's location as a place (the first one becomes Home). */
async function useMyLocation() {
  toast('Finding your location…');
  try {
    const p = await getPosition({ enableHighAccuracy: true });
    const lat = p.coords.latitude, lng = p.coords.longitude;
    let rg = null; try { rg = await reverseGeocode(lat, lng); } catch (e) { /* label falls back below */ }
    const place = rg ? rg.label : `Pinned spot (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
    const first = !data.locations.length;
    addLocation({ label: first ? 'Home' : (rg ? rg.label.split(',')[0] : 'Pinned spot'), place, lat, lng, country: rg ? rg.country : '', county: rg ? rg.county : '', state: rg ? rg.state : '' }, { view: true });
  } catch (e) { toast(geoErrorText(e), 4800); }
}

function toggleAddContact() { const f = $('addContactForm'); f.style.display = f.style.display === 'none' ? 'flex' : 'none'; }
function saveContact() {
  const name = $('newContactName').value.trim(), phone = $('newContactPhone').value.trim();
  if (!name || !/\d{6,}/.test(phone.replace(/\D/g, '') ) ) return toast('Enter a name and a valid phone number');
  data.contacts.push({ id: 'c' + Date.now(), name, phone }); saveData();
  $('newContactName').value = ''; $('newContactPhone').value = ''; toggleAddContact(); renderProfile(); renderEmgContacts(); toast('Contact saved');
}
async function removeContact(id) {
  const c = data.contacts.find((x) => x.id === id); if (!c) return;
  if (!(await confirmSheet('Remove contact?', `<p><b>${esc(c.name)}</b> · ${esc(c.phone)}</p>`, 'Remove', true))) return;
  data.contacts = data.contacts.filter((x) => x.id !== id); saveData(); renderProfile(); renderEmgContacts(); toast('Contact removed');
}

function toggleSetting(key, el) {
  data.settings[key] = !data.settings[key]; el.classList.toggle('on', data.settings[key]); saveData(); syncStates();
  const v = viewLoc(); if (v) evaluateAlerts(v, nearby, incidents, alerts);
  renderFeed(); renderHome(); renderMini();
  if (key === 'highConfOnly' && currentScreen === 'map') loadViewport();
  toast(key === 'wxAlerts' ? 'NWS warnings in notifications ' + (data.settings[key] ? 'on' : 'off') : (data.settings[key] ? 'Hiding' : 'Showing') + ' low-confidence detections');
}
function setRadius(r) {
  data.settings.radius = r; saveData(); renderProfile(); renderHome(); renderMini();
  toast(`Radius: ${r} mi — used for alerts and the Home summary`);
  // A wider radius needs a bigger search area, so re-check the other saved places soon too.
  data.locations.forEach((l) => { const k = 'cache.nearby.' + userKey() + '.' + l.id, c = LS.get(k); if (c) { c.t = 0; LS.set(k, c); } });
  refreshAll(false);
}

async function togglePush(el) {
  // Go by what the switch shows: if the browser permission was withdrawn, the switch is off and a tap means "turn on".
  const effectiveOn = data.settings.push && 'Notification' in window && Notification.permission === 'granted';
  if (effectiveOn) { data.settings.push = false; saveData(); renderProfile(); return toast('Phone notifications off — alerts still appear in the bell list', 3500); }
  if (!('Notification' in window) || (isIOS && !isStandalone())) {
    return showInfo('Add Aflare to your Home Screen first', '<p>On iPhone and iPad, notifications only work for apps added to the Home Screen.</p><ol><li>Open this page in Safari.</li><li>Tap Share → <b>Add to Home Screen</b>.</li><li>Open Aflare from the Home Screen and turn notifications on again.</li></ol>');
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { renderProfile(); return toast('Notifications are blocked — allow them for this site in your browser settings', 4200); }
  data.settings.push = true; saveData(); renderProfile();
  await registerPeriodicSync(); renderProfile();
  osNotify('Aflare notifications are on', `You'll be notified about new detections, incidents and warnings within ${data.settings.radius} mi of your saved places when Aflare checks.`, 'welcome');
}

/* -------------------------------------------------------------- emergency */
/* Emergency numbers are only shown for countries where we are sure of them. */
const EMERGENCY_NUMBERS = { us: '911', ca: '911', mx: '911', gb: '999', ie: '112', au: '000', nz: '111', jp: '119', kr: '119' };
const EU_112 = ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se', 'ch', 'no', 'is'];
function emergencyNumber(cc) {
  cc = (cc || '').toLowerCase();
  if (EMERGENCY_NUMBERS[cc]) return { n: EMERGENCY_NUMBERS[cc], known: true };
  if (EU_112.includes(cc)) return { n: '112', known: true };
  return { n: '112', known: false };
}
const COUNTRY_NAMES = { us: 'the US', ca: 'Canada', mx: 'Mexico', gb: 'the UK', ie: 'Ireland', au: 'Australia', nz: 'New Zealand', jp: 'Japan', kr: 'South Korea' };
const emg = { pos: null, address: null, cc: '' };
const canPhone = () => /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches);

function setCallNumber(cc) {
  const { n, known } = emergencyNumber(cc);
  emg.cc = (cc || '').toLowerCase();
  $('callBtn').href = 'tel:' + n; $('callLabel').textContent = 'Call ' + n; $('callBtn').setAttribute('aria-label', 'Call ' + n + ', emergency services');
  $('callNote').textContent = known
    ? `Emergency number in ${COUNTRY_NAMES[emg.cc] || emg.cc.toUpperCase()} — fire, police and ambulance.`
    : "112 works on mobile phones in many countries, but we couldn't confirm the number for your location. If you know your local emergency number, use it.";
  $('deskCall').style.display = canPhone() ? 'none' : '';
  $('deskCallNum').textContent = n;
  $('textTip').style.display = emg.cc === 'us' ? '' : 'none';
  renderEmgResources();
}

/** The place to describe in a report: live device location if we have it, else the place shown on Home. */
function reportPlace() {
  if (emg.pos) return { lat: emg.pos.lat, lng: emg.pos.lng, label: emg.address ? (emg.address.street ? emg.address.street + ', ' : '') + emg.address.label : `${emg.pos.lat.toFixed(5)}, ${emg.pos.lng.toFixed(5)}`, county: emg.address && emg.address.county, state: emg.address && emg.address.state, live: true };
  const h = viewLoc() || homeLoc();
  return h ? { lat: h.lat, lng: h.lng, label: placeName(h), county: h.county, state: h.state, live: false } : null;
}

async function openEmergency() {
  const h = viewLoc() || homeLoc();
  const regionFromLang = ((navigator.language || '').split('-')[1] || '').toLowerCase();
  setCallNumber((emg.address && emg.address.country) || (h && h.country) || regionFromLang || 'us');
  renderEmgContacts();
  if (!emg.pos) {
    $('emgLocH').textContent = h ? placeName(h) : 'Finding your location…';
    $('emgLocS').textContent = h ? 'Your saved place — checking this device’s location…' : 'Allow location access to show your address';
  }
  try {
    const p = await getPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    emg.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) };
    $('emgLocH').textContent = `${emg.pos.lat.toFixed(5)}, ${emg.pos.lng.toFixed(5)}`;
    $('emgLocS').textContent = `Device location, accurate to about ${emg.pos.acc.toLocaleString()} m`;
    try {
      emg.address = await reverseGeocode(emg.pos.lat, emg.pos.lng);
      $('emgLocH').textContent = emg.address.street ? emg.address.street + ', ' + emg.address.label : emg.address.label;
      $('emgLocS').textContent = `Nearest address to your device (±${emg.pos.acc.toLocaleString()} m) · ${emg.pos.lat.toFixed(5)}, ${emg.pos.lng.toFixed(5)}`;
      setCallNumber(emg.address.country || 'us');
    } catch (e) { /* coordinates are still shown */ }
  } catch (e) {
    emg.pos = null;
    $('emgLocS').textContent = (h ? 'Saved place shown — ' : '') + 'live location unavailable. Tell the dispatcher your address or nearest cross-streets.';
  }
}

function renderEmgContacts() {
  const el = $('emgContacts');
  el.innerHTML = data.contacts.length
    ? data.contacts.map((c) => { const num = c.phone.replace(/[^\d+]/g, ''); return `<div class="listrow"><svg aria-hidden="true"><use href="#i-user"/></svg><span class="grow"><span class="h">${esc(c.name)}</span><span class="s">${esc(c.phone)}</span></span><span class="rowact"><a class="ract" href="tel:${esc(num)}" aria-label="Call ${esc(c.name)}">Call</a><a class="ract" href="sms:${esc(num)}" aria-label="Text ${esc(c.name)}">Text</a></span></div>`; }).join('')
      + '<button class="listrow clickable-row" onclick="needContacts(true)"><svg aria-hidden="true"><use href="#i-plus"/></svg><span class="grow h">Add or edit contacts</span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>'
    : '<p class="emptystate">No contacts saved yet. Add family or neighbors you would text if you had to leave.</p><div class="btnrow center"><button class="btn secondary small" onclick="needContacts(true)"><svg class="bi" aria-hidden="true"><use href="#i-plus"/></svg><span class="label">Add a contact</span></button></div>';
}

/* Official sources only. Links that depend on where you are use your county and state; a web search is labelled as one. */
function renderEmgResources() {
  const p = reportPlace(), cc = emg.cc || 'us', us = cc === 'us';
  const st = ((p && p.state) || '').toLowerCase();
  const county = p && p.county ? p.county.replace(/ County$/i, '') : '';
  const rows = [];
  const link = (t, s, u, extra) => rows.push(`<a class="listrow clickable-row" href="${esc(u)}" ${/^https?:/.test(u) ? 'target="_blank" rel="noopener"' : ''}><span class="grow"><span class="h">${esc(t)}</span><span class="s">${esc(s)}</span></span><svg class="chev" aria-hidden="true"><use href="#${/^https?:/.test(u) ? 'i-ext' : 'i-chevr'}"/></svg>${/^https?:/.test(u) ? NEWTAB : ''}${extra || ''}</a>`);
  const btn = (t, s, fn) => rows.push(`<button class="listrow clickable-row" onclick="${fn}"><span class="grow"><span class="h">${esc(t)}</span><span class="s">${esc(s)}</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>`);
  if (county) link(`${county} County emergency alerts`, 'Web search for your county’s official alert sign-up and evacuation orders', 'https://www.google.com/search?q=' + encodeURIComponent(`${county} County ${p.state || ''} emergency alerts evacuation orders official`));
  else link('Your local emergency alerts', 'Web search for your county’s official alert sign-up and evacuation orders', 'https://www.google.com/search?q=' + encodeURIComponent('county emergency alerts sign up evacuation orders'));
  if (us && /california|oregon|washington|nevada|arizona|idaho|colorado|utah|texas/.test(st || 'california')) link('Genasys Protect — evacuation zones', 'Live evacuation zones used by many western US counties', 'https://protect.genasys.com/');
  if (st === 'california') link('CAL FIRE — current incidents', 'California’s official incident list and evacuation info', 'https://www.fire.ca.gov/incidents');
  if (us) link('InciWeb — official incident updates', 'Federal and partner agencies’ updates on larger fires', 'https://inciweb.wildfire.gov/');
  if (us || cc === 'ca') link('Call 211 — shelters and local help', 'Free help finding shelters, food and services (not for emergencies)', 'tel:211');
  btn('Fire stations near you', 'Opens a map search — find your department’s non-emergency number on its site', 'findStations()');
  btn('If you may need to evacuate', 'What to take and what to do before you leave', 'openEvacInfo()');
  if (us) link('AirNow — smoke and air quality', 'Official US air-quality readings', 'https://www.airnow.gov/');
  $('emgResources').innerHTML = rows.join('');
}

async function copyLocation() {
  const p = reportPlace();
  if (!p) return toast('No location yet — allow location access or add a place');
  const text = `${p.label} (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`;
  try { await navigator.clipboard.writeText(text); toast('Location copied'); } catch (e) { showInfo('Your location', `<p>${esc(text)}</p>`); }
}

function selectSev(el) { el.parentElement.querySelectorAll('.sevchip').forEach((c) => { c.classList.remove('active'); c.setAttribute('aria-checked', 'false'); }); el.classList.add('active'); el.setAttribute('aria-checked', 'true'); }

function reportText() {
  const sev = ($('sevrow').querySelector('.sevchip.active') || {}).textContent || 'fire';
  const p = reportPlace();
  return `${data.profile.name || 'I'}: I'm seeing ${sev.toLowerCase() === 'smoke only' ? 'smoke' : 'a ' + sev.toLowerCase().replace('structure', 'structure fire')} near ${p ? p.label : 'my location'}.${p ? ' Map: https://maps.google.com/?q=' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5) : ''} I've called / will call emergency services. (Sent from Aflare)`;
}

function alertContacts() {
  if (!data.contacts.length) return needContacts();
  goExternal(`sms:${contactNumbers()}${isIOS ? '&' : '?'}body=${encodeURIComponent(reportText())}`);
}
/** Hand a tel:/sms:/mailto: link to the phone's own app. */
function goExternal(url) { location.href = url; }
async function shareLocation() {
  const text = reportText();
  try { if (navigator.share) return await navigator.share({ title: 'Aflare fire report', text }); } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Report copied — paste it into a message'); } catch (e) { showInfo('Copy this report', `<p>${esc(text)}</p>`); }
}
function openEvacInfo() {
  showInfo('If you may need to evacuate',
    '<ol><li><b>Leave when officials tell you to</b> — or sooner if you feel unsafe. Don\'t wait for a warning to reach you.</li><li>Take people, pets, medications, documents, phones and chargers.</li><li>If there is time: close windows and doors, leave lights on, and move flammable items away from the house.</li><li>Drive with headlights on, windows closed and air on recirculate. Expect smoke and traffic; have a second route in mind.</li></ol><p>Evacuation orders and zones come from your county, sheriff or fire agency. Aflare does not show evacuation orders.</p><p><a href="https://www.ready.gov/evacuation" target="_blank" rel="noopener">Ready.gov evacuation guide<span class="sr-only"> (opens in a new tab)</span></a></p>');
}

/* ------------------------------------------------------ PWA & background */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; updateInstallUI(); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; updateInstallUI(); toast('Aflare installed'); });

function updateInstallUI() {
  const can = !isStandalone() && (deferredPrompt || isIOS);
  $('installCard').style.display = can ? 'flex' : 'none';
  $('installDesktopBtn').style.display = deferredPrompt && !isStandalone() ? 'inline-flex' : 'none';
}
async function installApp() {
  if (deferredPrompt) { deferredPrompt.prompt(); try { await deferredPrompt.userChoice; } catch (e) { /* ignore */ } deferredPrompt = null; updateInstallUI(); }
  else if (isIOS) showInfo('Install on iPhone / iPad', '<ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button.</li><li>Choose <b>Add to Home Screen</b>, then tap Add.</li></ol><p>Opening Aflare from the Home Screen gives you the full-screen app, offline use and notifications.</p>');
  else toast('Use your browser menu → "Install app" or "Add to Home screen"', 4200);
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  // Tapping a notification while Aflare is already open: go to the screen it is about.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'open' || !me) return;
    const sc = new URL(e.data.url, location.href).searchParams.get('screen');
    if (MAIN_TABS.includes(sc)) goTab(sc); else if (['news', 'notif'].includes(sc)) show(sc);
  });
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready — reopen Aflare to use the new version', 6000); });
    });
  } catch (e) { console.warn('Service worker not registered', e); }
}

/** Chrome on Android can wake the service worker every few hours (installed apps only).
    state.bgSync records whether that is really set up, so settings never over-promise. */
async function registerPeriodicSync() {
  state.bgSync = 'off';
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await Promise.race([navigator.serviceWorker.ready, sleep(3000).then(() => null)]);
    if (!reg || !('periodicSync' in reg)) return;
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return;
    await reg.periodicSync.register('aflare-check', { minInterval: 3 * 3600 * 1000 });
    const tags = await reg.periodicSync.getTags();
    state.bgSync = tags.includes('aflare-check') ? 'on' : 'off';
  } catch (e) { state.bgSync = 'off'; }
}

function updateOnlineBar() {
  const off = !navigator.onLine;
  $('offlineBar').style.display = off ? '' : 'none';
  $('app').classList.toggle('offline', off);
  if (me) { renderHome(); if (currentScreen === 'map') loadViewport(); }
}
window.addEventListener('online', () => { updateOnlineBar(); if (me) { refreshAll(false); if (sync.state === 'error') cloudSaveNow(); } });
window.addEventListener('offline', updateOnlineBar);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me && Date.now() - lastRefresh > 8 * 60e3) refreshAll(false); });
setInterval(() => { if (me && document.visibilityState === 'visible' && Date.now() - lastRefresh > 10 * 60e3) refreshAll(false); }, 60e3);

/* ------------------------------------------------------------------- boot */


function wireInputs() {
  document.querySelectorAll('#screen-auth .field input').forEach((i) => i.addEventListener('input', () => i.closest('.field').classList.remove('err')));
  // Enter submits the <form> by itself; no extra key handlers (they caused double sign-in attempts).
  [['newLocCity', () => saveLocation($('saveLocBtn'))], ['newContactPhone', saveContact], ['homeAddr', () => homeAddPlace($('homeAddBtn'))]]
    .forEach(([id, fn]) => { const el = $(id); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }); });
}

async function boot() {
  $('versionLine').textContent = 'Aflare v' + VERSION;
  initMap(); initMiniMap();
  wireInputs(); setupServiceWorker(); updateOnlineBar();
  const fbOK = await initFirebase();
  if (!fbOK) {
    $('fbBanner').style.display = 'block';
    $('fbBanner').textContent = fbConfigured() ? 'Cloud sign-in is unavailable right now — using accounts saved on this device.' : 'Accounts in this copy of Aflare are saved on this device only.';
  }
  await restoreSession();
  await Promise.race([sleep(1400), skipSplashPromise]);
  if (me) enterApp(); else routeToAuth();
}

/* =========================================================================
   Home — what is happening near the place you are looking at: official
   warnings, reported fires, satellite heat, then the weather and fire-weather
   forecast. Also switching between saved places.
   ========================================================================= */

/* ---------------------------------------------------- which place we show */
/** The place the Home screen is showing: a saved place, or "current location". */
function viewLoc() {
  if (state.gpsView) return state.gpsView;
  const id = state.viewId || LS.get('view.' + userKey());
  return data.locations.find((l) => l.id === id) || homeLoc();
}
function isHomeView() { const v = viewLoc(), h = homeLoc(); return !!(v && h && v.id === h.id); }
const viewKeyFor = (l) => userKey() + '.' + (l ? l.id : 'none');
const viewKey = () => viewKeyFor(viewLoc());
const cacheOf = (kind, l) => LS.get('cache.' + kind + '.' + viewKeyFor(l));
const cachedNearby = (l) => { const c = cacheOf('nearby', l); return c ? c.v : null; };
const cachedAlerts = (l) => { const c = cacheOf('alerts', l); return c ? c.v : null; };

function loadViewCaches() {
  const k = viewKey();
  const nb = LS.get('cache.nearby.' + k); nearby = nb ? nb.v : [];
  const w = LS.get('cache.wx.' + k); wx = w && w.v && w.v.v === 2 ? w.v : null;
  const a = LS.get('cache.air.' + k); air = a ? a.v : null;
  const al = LS.get('cache.alerts.' + k); alerts = al ? al.v : []; alertsNote = al ? al.note || '' : '';
  const v = viewLoc();
  if (v && !isUSPlace(v)) alertsNote = US_ONLY_NOTE;
  state.at = { nearby: nb ? nb.t : 0, wx: w ? w.t : 0, air: a ? a.t : 0, alerts: al ? al.t : 0 };
  state.wxFailed = false;
  state.fail = { incidents: (state.fail || {}).incidents };
}

function setView(loc, opts) {
  if (!loc) return;
  if (loc.id === 'gps') { state.gpsView = loc; }
  else { state.gpsView = null; state.viewId = loc.id; LS.set('view.' + userKey(), loc.id); }
  loadViewCaches();
  renderHome(); renderMini(); renderHomeNews(); renderAlerts(); drawPlaces();
  if (map && currentScreen !== 'map') map.setView([loc.lat, loc.lng], 9);   // the map opens on the place you picked
  if (currentScreen === 'profile') renderProfile();
  if (!(opts && opts.quiet)) toast('Showing ' + placeName(loc));
  refreshAll(false, true);
}

/* ------------------------------------------------------------ places sheet */
/** One-line summary of a saved place from whatever Aflare last downloaded for it. */
function placeBrief(l) {
  const isView = viewLoc() && viewLoc().id === l.id;
  const pts = isView ? nearby : cachedNearby(l), al = isView ? alerts : cachedAlerts(l);
  const w = isView ? wx : ((cacheOf('wx', l) || {}).v || null);
  if (!pts && !w && !al) return 'Not checked yet';
  const s = situation(l, pts || [], incidents, al || []);
  const bits = [];
  if (w && w.now) bits.push(`${w.now.tempF}° · fire weather ${RISK_NAME[w.now.key].toLowerCase()}`);
  if (s.warnings.length) bits.push('⚠ ' + s.warnings[0].event);
  if (s.incActiveIn.length) bits.push(`${s.incActiveIn.length} reported fire${s.incActiveIn.length > 1 ? 's' : ''} within ${s.R} mi`);
  if (pts) bits.push(s.detIn ? `${s.detIn} heat detection${s.detIn > 1 ? 's' : ''} within ${s.R} mi` : `no heat detections within ${s.R} mi`);
  return bits.join(' · ');
}
function placeStatusHtml(l, s) {
  return `<ul class="sitmini"><li>${s.warnings.length ? '<b>' + esc(s.warnings.map((a) => a.event).join(', ')) + '</b>' : 'No official fire-weather warnings'}</li>`
    + `<li>${s.incActiveIn.length ? `<b>${s.incActiveIn.length} reported fire${s.incActiveIn.length > 1 ? 's' : ''}</b> within ${s.R} mi (not fully contained)` : `No reported fires within ${s.R} mi that aren't contained`}</li>`
    + `<li>${s.detIn ? `<b>${s.detIn} satellite heat detection${s.detIn > 1 ? 's' : ''}</b> within ${s.R} mi (24 h)` : `No satellite heat within ${s.R} mi (24 h)`}</li></ul>`;
}

function openPlaces() {
  const v = viewLoc(), h = homeLoc(), gps = state.gpsView;
  const row = (l) => { const cur = v && l.id === v.id; return `<button class="placerow ${cur ? 'current' : ''}" onclick="pickPlace('${l.id}')" ${cur ? 'aria-current="true"' : ''}><svg aria-hidden="true"><use href="#i-pin"/></svg><span class="grow"><span class="h">${esc(l.label)} ${h && l.id === h.id ? '<span class="badge">Home</span>' : ''}</span><span class="s">${esc(l.place || '')}</span><span class="s brief">${esc(placeBrief(l))}</span></span>${cur ? '<svg class="tick" aria-hidden="true"><use href="#i-check"/></svg><span class="sr-only"> (showing now)</span>' : ''}</button>`; };
  const html = `<div class="placelist">
    ${data.locations.map(row).join('')}
    <button class="placerow ${gps ? 'current' : ''}" onclick="pickCurrentLocation()" ${gps ? 'aria-current="true"' : ''}><svg aria-hidden="true"><use href="#i-locate"/></svg><span class="grow"><span class="h">Current location</span><span class="s">${gps ? esc(gps.place) + ' · not saved' : 'Look around wherever this device is now (not saved)'}</span></span>${gps ? '<svg class="tick" aria-hidden="true"><use href="#i-check"/></svg>' : ''}</button>
  </div>
  <form class="addplace" onsubmit="event.preventDefault(); sheetAddPlace()">
    <label class="sheetlabel" for="sheetAddr">Add a place</label>
    <div class="addrow"><input id="sheetAddr" class="sheetinput" type="text" autocomplete="street-address" placeholder="City or address, e.g. Boulder, CO"><button class="btn" id="sheetAddBtn" type="submit"><span class="spinner" aria-hidden="true"></span><span class="label">Add</span></button></div>
  </form>`;
  showInfo('Your places', html, '<button class="btn secondary" onclick="closeSheets(); goProfileLocations()"><span class="label">Manage places</span></button><button class="btn" onclick="closeSheets()"><span class="label">Done</span></button>');
}
async function sheetAddPlace() {
  const loc = await addPlaceFromQuery($('sheetAddr').value, '', $('sheetAddBtn'));
  if (loc) closeSheets();
}
async function homeAddPlace(btn) {
  const loc = await addPlaceFromQuery($('homeAddr').value, data.locations.length ? '' : 'Home', btn);
  if (loc) $('homeAddr').value = '';
}
function pickPlace(id) { const l = data.locations.find((x) => x.id === id); closeSheets(); if (l) setView(l); }
async function pickCurrentLocation() {
  closeSheets(); toast('Finding your location…');
  try {
    const p = await getPosition({ enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    const lat = p.coords.latitude, lng = p.coords.longitude;
    let rg = null; try { rg = await reverseGeocode(lat, lng); } catch (e) { /* label below */ }
    setView({ id: 'gps', label: 'Current location', place: rg ? rg.label : 'Near you', lat, lng, country: rg ? rg.country : '', county: rg ? rg.county : '', state: rg ? rg.state : '' });
  } catch (e) { toast(geoErrorText(e), 4800); }
}

/* ------------------------------------------------------------ helpers */
const RISK_NAME = { low: 'Low', mod: 'Moderate', high: 'High', vhigh: 'Very high', ext: 'Extreme' };
const RISK_SHORT = { low: 'Low', mod: 'Mod', high: 'High', vhigh: 'V. high', ext: 'Extr.' };
const wxIcon = (code, isDay, cls) => { const m = wmo(code, isDay); return `<svg class="${cls || 'wi'}" aria-hidden="true"><use href="#${m.i}"/></svg>`; };
/** Colour for a temperature (°F) on a cool → hot scale, for the 10-day range bars. */
function tempColor(t) {
  const stops = [[20, [92, 141, 214]], [45, [106, 169, 233]], [60, [124, 196, 160]], [72, [244, 178, 58]], [85, [232, 117, 46]], [100, [190, 50, 40]]];
  if (t <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], k = (t - t0) / (t1 - t0);
    return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}
function humidityWord(rh) { return rh < 15 ? 'Extremely dry' : rh < 25 ? 'Very dry' : rh < 40 ? 'Dry' : rh < 65 ? 'Comfortable' : 'Humid'; }
function windWord(w) { return w < 5 ? 'Calm' : w < 13 ? 'Breezy' : w < 25 ? 'Windy' : 'Very windy'; }
function uvWord(u) { return u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme'; }
/** Plain-language reason for the fire-weather level ("Dry air (14%) and wind 22 mph"). */
function fireWhy(n) {
  const say = { 'Dry air': () => `Dry air (${n.rh}% humidity)`, Wind: () => `Wind ${n.wind} mph`, Heat: () => `Hot (${n.tempF}°F)`, 'Dry spell': () => 'No rain in 3 days' };
  const parts = scoreParts({ rh: n.rh, wind: n.wind, tempF: n.tempF, rain3d: n.rain3d == null ? 1 : n.rain3d })
    .filter(([, pts, max]) => pts / max >= 0.45).sort((a, b) => b[1] / b[2] - a[1] / a[2]).map(([name]) => say[name]());
  return parts.length ? parts.slice(0, 2).join(' · ') : `Humidity ${n.rh}%, wind ${n.wind} mph`;
}

/* --------------------------------------------------------------- render */
function renderHome() {
  const v = viewLoc();
  $('homeLocCard').style.display = v ? 'none' : '';
  $('tapHint').style.display = v && !LS.get('hint.tap') ? '' : 'none';
  ['hero', 'sitCard', 'hourCard', 'dayCard', 'tiles', 'homeFine'].forEach((id) => ($(id).style.display = v ? '' : 'none'));
  $('tipText').textContent = TIPS[Math.floor(Date.now() / 864e5) % TIPS.length];
  const newest = Math.max(state.at.wx || 0, state.at.nearby || 0, state.at.alerts || 0);
  $('homeUpdated').textContent = !v ? '' : newest ? (navigator.onLine ? 'Updated ' : 'Offline · last updated ') + ago(newest) : navigator.onLine ? 'Loading…' : 'Offline · no saved data for this place yet';
  if (!v) { $('alertBanner').innerHTML = ''; $('homeNearList').innerHTML = ''; return; }

  $('heroPlace').textContent = placeName(v);
  $('heroSub').textContent = (state.gpsView ? 'Current location · not saved' : isHomeView() ? 'Home' : v.label) + (state.at.wx ? ' · weather ' + ago(state.at.wx) : '');

  // ---- weather now + fire weather
  if (wx) {
    const n = wx.now, m = wmo(n.code, n.isDay), pk = wx.peak;
    $('hero').dataset.risk = n.key;
    $('heroIcon').style.display = '';
    $('heroIcon').querySelector('use').setAttribute('href', '#' + m.i);
    $('heroTemp').textContent = n.tempF + '°';
    $('heroTemp').setAttribute('aria-label', n.tempF + ' degrees Fahrenheit');
    $('heroCond').textContent = m.t + (Math.abs(n.feels - n.tempF) >= 3 ? ` · Feels like ${n.feels}°` : '');
    $('heroHL').textContent = wx.today && wx.today.max != null ? `H: ${wx.today.max}°   L: ${wx.today.min}°` : '';
    $('riskLbl').textContent = RISK_NAME[n.key];
    $('riskScore').textContent = n.score.toFixed(1) + '/10';
    const peakTxt = pk && pk.score >= n.score + 0.5 && pk.key !== n.key ? `Rises to ${RISK_NAME[pk.key].toLowerCase()} around ${pk.tl}` : '';
    $('riskWhy').textContent = [fireWhy(n), peakTxt].filter(Boolean).join(' · ');
    $('riskPill').setAttribute('aria-label', `Fire weather, an Aflare estimate: ${RISK_NAME[n.key]} now, ${n.score.toFixed(1)} out of 10. ${$('riskWhy').textContent}. Show how it's worked out.`);
  } else {
    $('hero').dataset.risk = 'none';
    $('heroIcon').style.display = 'none';
    $('heroTemp').textContent = '—';
    $('heroTemp').setAttribute('aria-label', 'Temperature not available');
    $('heroCond').innerHTML = !navigator.onLine ? 'Forecast unavailable offline' : state.wxFailed ? 'Couldn\'t load the forecast. <button class="linkbtn" onclick="refreshAll(true)">Try again</button>' : 'Loading forecast…';
    $('heroHL').textContent = ''; $('riskLbl').textContent = 'Not available yet'; $('riskScore').textContent = ''; $('riskWhy').textContent = 'Needs the weather forecast';
    $('riskPill').setAttribute('aria-label', 'Fire weather not available yet. Learn what it means.');
  }

  renderAlertBanner(); renderSituation(v); renderHourly(); renderDaily(); renderTiles(); renderNearList();
}

/** The three separate kinds of information, never mixed: warnings, reported fires, satellite heat. */
function renderSituation(v) {
  const s = situation(v, nearby, incidents, alerts), R = s.R, us = isUSPlace(v), fail = state.fail || {};
  $('sitTitle').textContent = 'Near ' + placeName(v).split(',')[0];
  const dir = (o) => compass(v.lat, v.lng, o.lat, o.lng);
  const row = (cls, ic, k, val, fn) => `<li><button class="sitrow ${cls}" onclick="${fn}"><span class="si" aria-hidden="true"><svg><use href="#${ic}"/></svg></span><span class="grow"><span class="k">${k}</span><span class="v">${val}</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button></li>`;
  let w = '';
  if (s.warnings.length) w = '';   // already shown as a banner right above this card
  else if (!us) w = row('muted', 'i-shield', 'Official warnings', 'Not available outside the US in Aflare', 'openNews()');
  else if (!state.at.alerts && !alerts.length) w = row('muted', 'i-shield', 'Official warnings · NWS', alertsNote ? esc(alertsNote) : !navigator.onLine ? 'Not loaded (offline)' : fail.alerts ? "Couldn't load right now — try Refresh" : 'Checking…', 'openNews()');
  else w = row('ok', 'i-check', 'Official warnings · NWS', 'No fire-weather warnings' + (s.otherAlerts.length ? ` · ${s.otherAlerts.length} other alert${s.otherAlerts.length > 1 ? 's' : ''}` : ''), 'openNews()');

  let f;
  const nearestTxt = (x) => `nearest ${esc(x.name)}, ${fmtMi(x.d)} ${dir(x)}`;
  if (!us) f = row('muted', 'i-flame', 'Reported fires · NIFC', 'US incidents only — rely on local authorities here', "goTab('map')");
  else if (!incidents.length) f = row('muted', 'i-flame', 'Reported fires · NIFC', !navigator.onLine ? 'Not loaded (offline)' : fail.incidents ? "Couldn't load right now — try Refresh" : 'Checking…', "goTab('map')");
  else if (s.incActiveIn.length) {
    const unsized = s.incActiveIn.filter((x) => x.acres == null).length;
    const n = s.incActiveIn.length;
    const note = unsized === n && n > 1 ? ' · all are new reports with no size yet' : unsized >= 3 ? ` · ${unsized} are new reports with no size yet` : '';
    f = row('alert', 'i-flame', 'Reported fires · NIFC', `<b>${n} within ${R} mi</b> not fully contained · ${nearestTxt(s.incActiveIn[0])}${note}`, 'openNearInc()');
  }
  else f = row('ok', 'i-check', 'Reported fires · NIFC', `None within ${R} mi that aren't fully contained${s.nearestActiveInc && s.nearestActiveInc.d < 300 ? ' · ' + nearestTxt(s.nearestActiveInc) : ''}${s.incContainedIn.length ? ` · ${s.incContainedIn.length} contained` : ''}`, "goTab('map')");

  let h;
  if (!state.at.nearby && !nearby.length) h = row('muted', 'i-warn', 'Satellite heat · last 24 h', !navigator.onLine ? 'Not loaded (offline)' : fail.nearby ? "Couldn't load right now — try Refresh" : 'Checking…', "goTab('map')");
  else if (s.clustersIn.length) { const c = s.clustersIn[0]; h = row('warn', 'i-warn', 'Satellite heat · last 24 h', `<b>${s.detIn} detection${s.detIn > 1 ? 's' : ''} within ${R} mi</b> · nearest ${fmtMi(c.d)} ${dir(c)}, ${ago(c.t)} · unconfirmed`, 'openNearHeat()'); }
  else h = row('ok', 'i-check', 'Satellite heat · last 24 h', `None within ${R} mi${s.clusters[0] && s.clusters[0].d < Math.max(50, R) ? ` · nearest ${fmtMi(s.clusters[0].d)} ${dir(s.clusters[0])}` : ''}`, "goTab('map')");

  $('sitList').innerHTML = w + f + h;
  $('sitFoot').textContent = `Within ${R} mi (change in Settings). Satellites pass a few times a day and can miss fires under cloud or smoke.${state.at.nearby ? ' Satellite data checked ' + ago(state.at.nearby) + '.' : ''}`;
}

function renderAlertBanner() {
  const fire = liveAlerts().filter((a) => a.fire);
  const el = $('alertBanner');
  if (!fire.length) { el.innerHTML = ''; return; }
  el.innerHTML = fire.slice(0, 3).map((a) => `<button class="alertbanner" onclick="openAlert('${esc(a.id)}')"><svg aria-hidden="true"><use href="#i-warn"/></svg><span class="grow"><span class="src">Official warning · ${esc(a.sender)}</span><span class="h">${esc(a.event)}</span><span class="s">${a.ends ? esc(untilText(a.ends)) + ' · ' : ''}Tap for what to do</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>`).join('')
    + (fire.length > 3 ? `<button class="textbtn" onclick="openNews()">${fire.length - 3} more warnings</button>` : '');
}

function renderHourly() {
  const el = $('hourly');
  if (!wx || !wx.hours) { el.innerHTML = '<p class="emptystate">The hourly forecast will appear here once it loads.</p>'; $('hourSummary').textContent = ''; return; }
  const hrs = wx.hours.slice(0, 24), pk = wx.peak;
  $('hourSummary').textContent = pk && pk.score >= 2
    ? `Fire weather peaks around ${pk.tl === 'Now' ? 'now' : pk.tl}: ${RISK_NAME[pk.key].toLowerCase()}, humidity ${pk.rh}%, gusts ${pk.gust} mph.`
    : 'Low fire weather for the next 24 hours.';
  el.innerHTML = hrs.map((h) => {
    const m = wmo(h.code, h.isDay);
    return `<div class="hour" role="listitem" aria-label="${esc(h.tl)}: ${h.tempF} degrees, ${esc(m.t)}${h.pop >= 20 ? ', ' + h.pop + ' percent chance of rain' : ''}. Fire weather ${RISK_NAME[h.key]}. Wind ${h.wind} miles per hour.">
      <span class="t">${esc(h.tl)}</span>
      ${wxIcon(h.code, h.isDay)}
      <span class="pop">${h.pop >= 20 ? h.pop + '%' : ''}</span>
      <span class="tmp">${h.tempF}°</span>
      <span class="rk r-${h.key}"><i aria-hidden="true"></i>${RISK_SHORT[h.key]}</span>
      <span class="wnd">${h.wind} mph</span>
    </div>`;
  }).join('');
}

function renderDaily() {
  const el = $('daily');
  if (!wx || !wx.week || !wx.week.length) { el.innerHTML = '<p class="emptystate">The 10-day forecast will appear here once it loads.</p>'; return; }
  const lo = Math.min(...wx.week.map((d) => d.min)), hi = Math.max(...wx.week.map((d) => d.max)), span = Math.max(1, hi - lo);
  el.innerHTML = wx.week.map((d, i) => {
    const m = wmo(d.code, 1);
    const left = ((d.min - lo) / span) * 100, width = Math.max(6, ((d.max - d.min) / span) * 100);
    return `<button class="dayrow" onclick="openDay(${i})" aria-label="${esc(d.isToday ? 'Today' : d.dayLong)}: ${esc(m.t)}, high ${d.max}, low ${d.min}${d.pop >= 20 ? ', ' + d.pop + ' percent chance of rain' : ''}. Fire weather ${RISK_NAME[d.key]}. Show details.">
      <span class="dn"><span class="d">${esc(d.isToday ? 'Today' : d.day)}</span><span class="rk r-${d.key}"><i aria-hidden="true"></i>${RISK_NAME[d.key]}</span></span>
      <span class="di">${wxIcon(d.code, 1)}<span class="pop">${d.pop >= 20 ? d.pop + '%' : ''}</span></span>
      <span class="lo">${d.min}°</span>
      <span class="bar" aria-hidden="true"><i style="left:${left.toFixed(1)}%;width:${Math.min(100 - left, width).toFixed(1)}%;background:linear-gradient(90deg,${tempColor(d.min)},${tempColor(d.max)})"></i></span>
      <span class="hi">${d.max}°</span>
    </button>`;
  }).join('');
}

function renderTiles() {
  const el = $('tiles');
  if (!wx) { el.innerHTML = ''; return; }
  const n = wx.now, t = wx.today || {};
  const rainNext = wx.hours ? Math.max(0, ...wx.hours.slice(0, 24).map((h) => h.pop || 0)) : 0;
  const aq = air;
  const tiles = [
    { id: 'wind', ic: 'i-wind', h: 'Wind', v: `${n.wind}<small> mph</small>`, s: `Gusts ${n.gust} mph · from ${n.dir}`, viz: `<span class="compass" aria-hidden="true"><svg style="transform:rotate(${(n.dirDeg + 180) % 360}deg)"><use href="#i-arrow"/></svg></span>`, label: `Wind ${n.wind} miles per hour from the ${n.dir}, gusts ${n.gust}. ${windWord(n.wind)}.` },
    { id: 'hum', ic: 'i-drop', h: 'Humidity', v: `${n.rh}<small>%</small>`, s: `${humidityWord(n.rh)} · dew point ${n.dew}°`, viz: `<span class="meter" aria-hidden="true"><i style="width:${n.rh}%"></i></span>`, label: `Humidity ${n.rh} percent, ${humidityWord(n.rh)}. Dew point ${n.dew} degrees.` },
    aq ? { id: 'air', ic: 'i-air', h: 'Air quality', v: `${aq.aqi}<small> AQI</small>`, s: `${aq.cat} · model estimate`, viz: `<span class="aqscale" aria-hidden="true"><i style="left:${Math.min(100, aq.aqi / 3)}%"></i></span>`, label: `Air quality index ${aq.aqi}, ${aq.cat}. Model estimate. Fine particles PM 2.5: ${aq.pm25} micrograms per cubic meter.` }
       : { id: 'air', ic: 'i-air', h: 'Air quality', v: '—', s: navigator.onLine ? 'Loading…' : 'Unavailable offline', viz: '', label: 'Air quality not loaded yet.' },
    { id: 'uv', ic: 'i-uv', h: 'UV index', v: `${Math.round(n.uv)}`, s: `${uvWord(n.uv)} now · max ${t.uvMax ?? '—'} today`, viz: `<span class="uvscale" aria-hidden="true"><i style="left:${Math.min(100, n.uv / 11 * 100)}%"></i></span>`, label: `UV index ${Math.round(n.uv)}, ${uvWord(n.uv)}.` },
    { id: 'rain', ic: 'i-drop', h: 'Rain', v: `${n.rain3d.toFixed(2)}<small> in</small>`, s: `last 3 days · ${rainNext}% chance in 24 h`, viz: '', label: `${n.rain3d.toFixed(2)} inches of rain in the last 3 days. ${rainNext} percent chance in the next 24 hours.` },
    { id: 'sun', ic: 'i-sunrise', h: 'Sunset', v: clockLabel(t.sunset).replace(/ (AM|PM)/, '<small> $1</small>'), s: `Sunrise ${clockLabel(t.sunrise)}`, viz: '', label: `Sunset ${clockLabel(t.sunset)}, sunrise ${clockLabel(t.sunrise)}.` },
  ];
  el.innerHTML = tiles.map((x) => `<button class="tile${x.id === 'air' && aq ? ' aq-' + aq.key : ''}" onclick="openTile('${x.id}')" aria-label="${esc(x.label)} More info."><span class="th"><svg aria-hidden="true"><use href="#${x.ic}"/></svg>${x.h}</span><span class="tv">${x.v}</span>${x.viz}<span class="ts">${x.s}</span></button>`).join('');
}

/* ----------------------------------------------------- tile explanations */
function openTile(id) {
  if (!wx) return;
  const n = wx.now, v = viewLoc();
  const where = esc(placeName(v));
  if (id === 'wind') return showInfo('Wind', `<div class="wxgrid"><div><b>${n.wind} mph</b><span>Sustained</span></div><div><b>${n.gust} mph</b><span>Gusts</span></div><div><b>${n.dir}</b><span>From</span></div></div><p>Wind is one of the biggest drivers of wildfire spread. It pushes flames forward, dries out fuel and can carry embers more than a mile ahead of a fire.</p><p>Above about <b>20 mph</b>, or when gusts top <b>30 mph</b>, avoid anything that can throw sparks: mowing, grinding, welding, campfires or dragging trailer chains.</p><p class="muted">Forecast model data (Open-Meteo), not a station reading.</p>`);
  if (id === 'hum') return showInfo('Humidity', `<div class="wxgrid"><div><b>${n.rh}%</b><span>Humidity</span></div><div><b>${n.dew}°</b><span>Dew point</span></div><div><b>${humidityWord(n.rh)}</b><span>Right now</span></div></div><p>Dry air pulls moisture out of grass, leaves and brush. Below about <b>25%</b> humidity, fine fuels catch fire easily; below <b>15%</b> fires can spread very quickly.</p><p>Humidity is usually lowest in the mid-afternoon, which is why fire weather often peaks then.</p>`);
  if (id === 'air') {
    const a = air;
    if (!a) return showInfo('Air quality', '<p>Air-quality data hasn\'t loaded yet. Check your connection and refresh.</p>');
    const tips = { good: 'Air quality is good. Enjoy outdoor activities.', moderate: 'Unusually sensitive people should consider reducing long or heavy outdoor exertion.', usg: 'Children, older adults and people with heart or lung disease should reduce long or heavy outdoor exertion.', unhealthy: 'Everyone should reduce long or heavy outdoor exertion. Sensitive groups should avoid it. Keep windows closed.', vunhealthy: 'Everyone should avoid long or heavy outdoor exertion. Stay indoors with filtered air if you can.', hazardous: 'Everyone should avoid all outdoor exertion. Stay indoors with windows closed and use a HEPA air cleaner.' };
    return showInfo('Air quality', `<div class="wxgrid"><div><b>${a.aqi}</b><span>US AQI</span></div><div><b>${a.pm25}</b><span>PM2.5 µg/m³</span></div><div><b>${a.peak}</b><span>Next 24 h peak</span></div></div><p><b>${esc(a.cat)}.</b> ${tips[a.key]}</p><p>PM2.5 is the fine particle pollution that wildfire smoke is mostly made of. These are <b>model estimates</b> for ${where} from Open-Meteo (CAMS), not sensor readings, and can miss local smoke. For official readings check <a href="https://www.airnow.gov/" target="_blank" rel="noopener">AirNow<span class="sr-only"> (opens in a new tab)</span></a>.</p>`);
  }
  if (id === 'uv') return showInfo('UV index', `<div class="wxgrid"><div><b>${Math.round(n.uv)}</b><span>Now</span></div><div><b>${wx.today.uvMax ?? '—'}</b><span>Today's max</span></div><div><b>${uvWord(n.uv)}</b><span>Level</span></div></div><p>At 3 or higher, use sunscreen, a hat and sunglasses if you'll be outside for a while — for example while clearing brush or working on defensible space.</p>`);
  if (id === 'rain') return showInfo('Rain', `<div class="wxgrid"><div><b>${n.rain3d.toFixed(2)} in</b><span>Last 3 days</span></div><div><b>${wx.week[0] && wx.week[0].pop != null ? wx.week[0].pop + '%' : '—'}</b><span>Chance today</span></div><div><b>${wx.week.slice(0, 7).filter((d) => d.pop >= 40).length}</b><span>Wet days this week</span></div></div><p>A few dry days in a row let grass and brush dry out, which raises fire risk. Light rain helps only briefly — dead grass can dry out again within hours on a sunny, windy day.</p>`);
  if (id === 'sun') return showInfo('Sunrise & sunset', `<div class="wxgrid"><div><b>${clockLabel(wx.today.sunrise)}</b><span>Sunrise</span></div><div><b>${clockLabel(wx.today.sunset)}</b><span>Sunset</span></div><div><b>${esc(wx.tz ? wx.tz.split('/').pop().replace(/_/g, ' ') : '')}</b><span>Time zone</span></div></div><p>The VIIRS satellites pass over most places in the early afternoon and again after midnight, and detections usually appear in Aflare within about three hours of a pass.</p>`);
}

/** The one-time "anything with an arrow opens more detail" tip. Stays gone once dismissed (or once any detail sheet was opened). */
function dismissTapHint() { LS.set('hint.tap', 1); const el = $('tapHint'); if (el) el.style.display = 'none'; }

/* =========================================================================
   Third part — detail sheets, home extras, profile & emergency tools,
   keyboard access, boot
   ========================================================================= */

/* ------------------------------------------------------- home: near list */
/** The closest reported fires and heat detections within your radius, for the list under the mini-map. */
function nearItems() {
  const h = viewLoc(); if (!h) return [];
  const s = situation(h, nearby, incidents, alerts);
  const inc = s.incActiveIn.map((f) => ({ k: 'inc', f, lat: f.lat, lng: f.lng, d: f.d }));
  const hs = s.clustersIn.map((c) => ({ k: 'hs', c, lat: c.lat, lng: c.lng, d: c.d }));
  return [...inc.slice(0, 3), ...hs].slice(0, 4).sort((a, b) => (a.k === 'inc' ? 0 : 1) - (b.k === 'inc' ? 0 : 1) || a.d - b.d);
}

function renderNearList() {
  const el = $('homeNearList'); if (!el) return;
  const h = viewLoc();
  state.nearItems = nearItems();
  if (!h || !state.nearItems.length) { el.innerHTML = ''; return; }
  el.innerHTML = state.nearItems.map((it, i) => {
    const dir = compass(h.lat, h.lng, it.lat, it.lng);
    const title = it.k === 'inc' ? it.f.name : `${it.c.n} heat detection${it.c.n > 1 ? 's' : ''}`;
    const sub = it.k === 'inc'
      ? `Official incident · ${fmtMi(it.d)} ${dir} · ${incSize(it.f)} · ${incContain(it.f)}`
      : `Satellite, unconfirmed · ${fmtMi(it.d)} ${dir} · ${ago(it.c.t)}`;
    return `<button class="nearrow k-${it.k}" onclick="openNear(${i})"><span class="ic" aria-hidden="true"><svg><use href="#${it.k === 'inc' ? 'i-flame' : 'i-warn'}"/></svg></span><span class="grow"><span class="h">${esc(title)}</span><span class="s">${esc(sub)}</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>`;
  }).join('');
}

function openNear(i) {
  const it = (state.nearItems || [])[i]; if (!it) return;
  goTab('map');
  setTimeout(() => {
    map.setView([it.lat, it.lng], 12);
    if (it.k === 'inc') openIncidentSheet(it.f); else openHotspotSheet(it.c);
  }, 220);
}
function openNearInc() { const i = (state.nearItems || []).findIndex((x) => x.k === 'inc'); if (i >= 0) openNear(i); else goTab('map'); }
function openNearHeat() { const i = (state.nearItems || []).findIndex((x) => x.k === 'hs'); if (i >= 0) openNear(i); else goTab('map'); }

/* ------------------------------------------------------- home: news card */
function openNews() { show('news'); }

/** Home shows headlines only; official warnings have their own place at the top of Home. */
function renderHomeNews() {
  const el = $('homeNews'); if (!el) return;
  const heads = newsItems.slice(0, 3).map((n) => `<a class="hn-item" href="${esc(n.url)}" target="_blank" rel="noopener"><span class="h">${esc(n.title)}</span><span class="m">${esc(n.domain)} · ${ago(n.t)}</span>${NEWTAB}</a>`).join('');
  el.innerHTML = heads || `<p class="muted-txt">${newsLoading ? 'Loading headlines…' : navigator.onLine ? 'No headlines loaded yet.' : 'Headlines need a connection.'}</p>`;
}

/* ------------------------------------------------------ weather sheets */
function partsTable(parts) {
  return '<div class="ptable">' + parts.map(([name, pts, max, detail]) =>
    `<div class="prow"><div class="pn">${esc(name)}<span>${esc(detail)}</span></div><div class="pbar"><i style="width:${Math.round(pts / max * 100)}%"></i></div><div class="pv">${pts.toFixed(1)}/${max}</div></div>`).join('') + '</div>';
}

function forecastUrl(l) {
  return (l.country || '').toLowerCase() === 'us'
    ? `https://forecast.weather.gov/MapClick.php?lat=${l.lat.toFixed(4)}&lon=${l.lng.toFixed(4)}`
    : `https://www.windy.com/?${l.lat.toFixed(3)},${l.lng.toFixed(3)},9`;
}

function openWeather() {
  const h = viewLoc();
  if (!h) return showInfo('Weather', '<p>Set a home location to see the weather and fire-weather forecast for it.</p>', '<button class="btn secondary" onclick="closeSheets()"><span class="label">Later</span></button><button class="btn" onclick="closeSheets(); goProfileLocations()"><span class="label">Set location</span></button>');
  if (!wx) return showInfo('Weather', '<p>The forecast hasn\'t loaded yet. Check your connection and refresh.</p>', '<button class="btn secondary" onclick="closeSheets()"><span class="label">Close</span></button><button class="btn" onclick="closeSheets(); refreshAll(true)"><span class="label">Refresh now</span></button>');
  const n = wx.now, fire = alerts.filter((a) => a.fire);
  let html = `<p style="margin-bottom:6px;color:var(--muted)">${esc(placeName(h))} · ${lastRefresh ? 'updated ' + ago(lastRefresh) : ''}</p>`;
  html += `<div class="wxgrid"><div><b>${n.tempF}°F</b><span>Temperature</span></div><div><b>${n.rh}%</b><span>Humidity</span></div><div><b>${n.wind} mph</b><span>Wind from ${esc(n.dir)}</span></div></div>`;
  if (fire.length) html += fire.map((a) => `<button class="alertcard clickable" onclick="openAlert('${esc(a.id)}')"><span class="h">${esc(a.event)}</span><span class="s">${esc(a.sender || 'NWS')} · tap for details</span></button>`).join('');
  html += `<p style="margin-top:8px"><b>Fire weather now: ${n.score.toFixed(1)} · ${esc(n.label)}</b></p>`;
  if (wx.week.length) html += '<table class="daytable"><caption class="sr-only">7-day forecast. Choose a day for details.</caption><thead><tr><th scope="col">Day</th><th scope="col">Fire weather</th><th scope="col">High</th><th scope="col">Min humidity</th><th scope="col">Wind (mph)</th></tr></thead><tbody>' + wx.week.map((d, i) => `<tr><td><button onclick="openDay(${i})">${esc(d.day)}</button></td><td class="r-${d.risk}">${esc(d.label || scoreLabel(d.score))}</td><td>${d.tempMax != null ? d.tempMax + '°' : '—'}</td><td>${d.rhMin != null ? d.rhMin + '%' : '—'}</td><td>${d.windMax != null ? d.windMax : '—'}</td></tr>`).join('') + '</tbody></table>';
  html += '<p class="fineprint" style="margin:0">Forecast: Open-Meteo model data. Wind in mph. Fire weather is an Aflare estimate, not an official rating.</p>';
  showInfo('Weather', html, `<button class="btn secondary" onclick="window.open('${forecastUrl(h)}','_blank','noopener')"><span class="label">Official forecast ↗</span></button><button class="btn" onclick="explainIndex()"><span class="label">About fire weather</span></button>`);
}

function openDay(i) {
  const d = wx && wx.week[i]; if (!d) return;
  const date = d.date ? new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : d.day;
  const v = (x, u) => (x == null ? '—' : x + u);
  let html = `<p><b>Fire weather (Aflare estimate): ${esc(RISK_NAME[d.key] || d.label)} · ${d.score.toFixed(1)} / 10</b></p>`;
  html += `<div class="wxgrid"><div><b>${v(d.tempMax, '°F')}</b><span>High</span></div><div><b>${v(d.rhMin, '%')}</b><span>Lowest humidity</span></div><div><b>${v(d.windMax, ' mph')}</b><span>Strongest wind</span></div></div>`;
  html += `<p>Rain: <b>${d.rain == null ? '—' : d.rain + ' in'}</b></p>`;
  html += `<p>Rain chance: <b>${d.pop == null ? '—' : d.pop + '%'}</b> · Gusts up to <b>${d.gustMax} mph</b></p>`;
  html += `<p>${d.risk === 'high' ? 'Weather that favors fast fire spread. Avoid anything that can spark — mowing, grinding, campfires, dragging trailer chains — and keep your go-bag ready.' : d.risk === 'med' ? 'Some fire-weather concern. Be careful with outdoor equipment and open flames.' : 'Lower fire-weather concern. Always follow local burn rules.'} Check for official Red Flag Warnings before burning or working outdoors.</p>`;
  html += '<p class="fineprint" style="margin:0">Score is the average of the afternoon hours (noon–6 pm), when fire weather usually peaks. Aflare estimate, not an official rating.</p>';
  showInfo(date, html, '<button class="btn secondary" onclick="openWeather()"><span class="label">All days</span></button><button class="btn" onclick="closeSheets()"><span class="label">Got it</span></button>');
}

/* --------------------------------------------------------- tip of the day */
function openTip(step) {
  if (state.tipIdx == null) state.tipIdx = Math.floor(Date.now() / 864e5) % TIPS.length;
  if (step) state.tipIdx = (state.tipIdx + step + TIPS.length) % TIPS.length;
  showInfo('Fire Safety Tip', `<p style="font-size:14px;line-height:1.5"><b>${esc(TIPS[state.tipIdx])}</b></p><p style="color:var(--muted)">Tip ${state.tipIdx + 1} of ${TIPS.length}</p>`,
    '<button class="btn secondary" onclick="openTip(1)"><span class="label">Next tip</span></button><button class="btn" onclick="closeSheets(); goTab(\'learn\')"><span class="label">Learn more</span></button>');
}

/* ------------------------------------------------------------- articles */
async function shareArticle() {
  const c = state.cur; if (!c) return;
  const url = c.kind === 'v' ? 'https://www.youtube.com/watch?v=' + c.id : location.href.split(/[?#]/)[0];
  const text = c.kind === 'v' ? `${c.title} — a fire-safety video recommended in Aflare` : `${c.title} — from Aflare, the satellite fire-alert app`;
  try { if (navigator.share) return await navigator.share({ title: c.title, text, url }); } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text + ' ' + url); toast('Link copied — paste it anywhere'); }
  catch (e) { showInfo('Share', `<p>${esc(text)}</p><p style="word-break:break-all">${esc(url)}</p>`); }
}
function updateDoneBtn() {
  const c = state.cur; if (!c) return;
  const done = !!(data.read && data.read[c.id]);
  $('art-done').querySelector('.label').textContent = done ? (c.kind === 'v' ? 'Watched' : 'Read') : (c.kind === 'v' ? 'Mark as watched' : 'Mark as read');
  $('art-done').classList.toggle('done', done);
  $('art-done').setAttribute('aria-pressed', String(done));
}
function toggleArticleDone() {
  const c = state.cur; if (!c) return;
  data.read = data.read || {};
  if (data.read[c.id]) delete data.read[c.id]; else data.read[c.id] = Date.now();
  saveData(); updateDoneBtn();
  const total = ARTICLES.length + VIDEOS.length, n = Object.keys(data.read).length;
  if (data.read[c.id]) toast(`${n} of ${total} lessons done`);
}

/* ---------------------------------------------------------------- news */
let newsScopeKey = '';
function homeRegion() {
  const h = viewLoc(); if (!h) return '';
  const r = placeName(h).split(',').map((x) => x.trim()).filter(Boolean).pop() || '';
  return r === 'Pinned location' || r === 'My location' ? '' : r;
}
function newsRegion() { return state.newsScope === 'near' ? homeRegion() : ''; }
function renderNewsScope() {
  const el = $('newsScope'), reg = homeRegion();
  const more = $('newsMore'); if (more) more.href = 'https://news.google.com/search?q=' + encodeURIComponent('wildfire' + (newsRegion() ? ' ' + newsRegion() : '') + ' when:2d');
  if (!reg) { el.innerHTML = ''; return; }
  const near = state.newsScope === 'near';
  el.innerHTML = `<button class="chip ${near ? '' : 'active'}" aria-pressed="${!near}" onclick="setNewsScope('all')">Everywhere</button><button class="chip ${near ? 'active' : ''}" aria-pressed="${near}" onclick="setNewsScope('near')">Near ${esc(reg)}</button>`;
}
function setNewsScope(s) {
  const want = s === 'near' ? 'near' : '';
  if ((state.newsScope || '') === want) return;
  state.newsScope = want; loadNews(false);
}

function openAlert(id) {
  const a = alerts.find((x) => String(x.id) === String(id)); if (!a) return toast('This warning is no longer active');
  const h = viewLoc(), d = a.desc || '', when = (t) => esc(new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  showInfo(a.event,
    `<p class="srcline">Official warning · ${esc(a.sender)}${a.severity && a.severity !== 'Unknown' ? ' · ' + esc(a.severity) : ''}</p>`
    + `<p><b>${esc(a.headline || '')}</b></p>`
    + `<div class="wxgrid two"><div><b>${a.onset ? when(a.onset) : '—'}</b><span>Starts</span></div><div><b>${a.ends ? when(a.ends) : 'Until further notice'}</b><span>Ends</span></div></div>`
    + (a.instr ? `<h3 class="sheeth">What to do</h3><p class="alertdesc">${esc(a.instr.slice(0, 1600))}</p>` : '')
    + `<h3 class="sheeth">Details</h3><p class="alertdesc">${esc(d.slice(0, 2400))}${d.length > 2400 ? '…' : ''}</p>`
    + `<p class="muted">Areas: ${esc((a.area || '').slice(0, 300))}<br>Issued ${ago(a.sent)}. Text from the National Weather Service, unchanged.</p>`,
    `${h ? `<button class="btn secondary" onclick="window.open('${forecastUrl(Object.assign({}, h, { country: 'us' }))}','_blank','noopener')"><span class="label">weather.gov ↗</span></button>` : ''}<button class="btn" onclick="closeSheets()"><span class="label">Got it</span></button>`);
}

/* -------------------------------------------------------- notifications */
async function clearFeed() {
  if (!feed.length) return toast('No notifications to clear');
  if (!(await confirmSheet('Clear all notifications?', '<p>This removes them from this list. You won\'t be alerted again about the same detections.</p>', 'Clear all', true))) return;
  feed = []; saveFeed(); renderFeed(); toast('Notifications cleared');
}
function openAlertSettings() { goSettings('alertsCard'); }
async function testAlert() {
  addFeed({ id: 'test:' + Date.now(), icon: 'i-bell', h: 'Test alert from Aflare', sub: 'If you can see this, alerts reach this device.', goto: { screen: 'profile' } }, false);
  saveFeed(); renderFeed();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  if (data.settings.push && perm === 'granted') toast('Test alert sent — check your notifications');
  else toast('Added to the bell list. Phone notifications are off, so nothing was sent to the phone.', 4800);
}

/* -------------------------------------------------------------- profile */
function pickPhoto() {
  if (data.profile.photo) return showInfo('Profile photo', '<p>Choose a new photo or remove the current one.</p>', '<button class="btn secondary" onclick="removePhoto()"><span class="label">Remove</span></button><button class="btn" onclick="closeSheets(); $(\'photoInput\').click()"><span class="label">Choose new</span></button>');
  $('photoInput').click();
}
function photoChosen(input) {
  const f = input.files && input.files[0]; input.value = '';
  if (!f) return;
  if (!/^image\//.test(f.type)) return toast('Choose an image file');
  const url = URL.createObjectURL(f), img = new Image();
  img.onload = () => {
    const S = 160, c = document.createElement('canvas'), k = Math.min(img.width, img.height);
    c.width = c.height = S;
    c.getContext('2d').drawImage(img, (img.width - k) / 2, (img.height - k) / 2, k, k, 0, 0, S, S);
    URL.revokeObjectURL(url);
    data.profile.photo = c.toDataURL('image/jpeg', 0.85);
    saveData(); renderIdentity(); toast('Photo updated');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("Couldn't read that image — try a JPG or PNG"); };
  img.src = url;
}
function removePhoto() { delete data.profile.photo; saveData(); renderIdentity(); closeSheets(); toast('Photo removed'); }

const pwProvider = () => { const u = fbAuth && fbAuth.currentUser; return !u || (u.providerData || []).some((p) => p.providerId === 'password'); };
function renderVerifyLine() {
  const el = $('verifyLine'), u = me && me.mode === 'cloud' && fbAuth && fbAuth.currentUser;
  if (!u || u.emailVerified || !pwProvider()) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = 'Email not verified · <span class="vlink" onclick="resendVerify()">Resend link</span> · <span class="vlink" onclick="recheckVerify()">I verified it</span>';
}
async function resendVerify() { try { await fbAuth.currentUser.sendEmailVerification(); toast('Verification email sent to ' + me.email, 3500); } catch (e) { toast(friendlyAuthError(e)); } }
async function recheckVerify() {
  try { await fbAuth.currentUser.reload(); renderVerifyLine(); toast(fbAuth.currentUser.emailVerified ? 'Email verified — thank you' : 'Not verified yet — check your inbox and spam folder', 3500); }
  catch (e) { toast(friendlyAuthError(e)); }
}

function togglePasswordForm() {
  const f = $('passwordForm'), open = f.style.display === 'none';
  if (open && me.mode === 'cloud' && !pwProvider()) return toast('You sign in with Google — change your password in your Google account', 4200);
  ['pwCurrent', 'pwNew', 'pwNew2'].forEach((i) => ($(i).value = ''));
  f.style.display = open ? 'flex' : 'none';
  if (open) setTimeout(() => $('pwCurrent').focus(), 50);
}
async function changePassword(btn) {
  const cur = $('pwCurrent').value, n1 = $('pwNew').value, n2 = $('pwNew2').value;
  if (!cur || !n1) return toast('Fill in your current and new password');
  if (n1.length < 6) return toast('New password should be at least 6 characters');
  if (n1 !== n2) return toast("New passwords don't match");
  btn.classList.add('loading');
  try {
    if (me.mode === 'cloud') {
      const u = fbAuth.currentUser;
      await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, cur));
      await u.updatePassword(n1);
    } else {
      const acc = LS.get('accounts', {}), a = acc[me.id];
      if (!a || (await sha256(a.salt + cur)) !== a.hash) throw { message: 'Current password is incorrect.' };
      a.salt = randomSalt(); a.hash = await sha256(a.salt + n1); LS.set('accounts', acc);
    }
    togglePasswordForm(); toast('Password updated');
  } catch (e) {
    toast(e && (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') ? 'Current password is incorrect.' : friendlyAuthError(e), 4000);
  }
  btn.classList.remove('loading');
}

function viewLocation(id) {
  const l = data.locations.find((x) => x.id === id); if (!l) return;
  goTab('map'); setTimeout(() => map.setView([l.lat, l.lng], 10), 160);
}
function mapGoView() { const v = viewLoc(); if (v) map.setView([v.lat, v.lng], Math.max(9, map.getZoom())); else toast('Add a place first'); }
function renameLoc(id) {
  const l = data.locations.find((x) => x.id === id); if (!l) return;
  showInfo('Rename location', `<label class="sheetlabel" for="renameInput">New name</label><input id="renameInput" class="sheetinput" maxlength="40" value="${esc(l.label)}" placeholder="e.g. Home, Cabin, Mom's house">`,
    `<button class="btn secondary" onclick="closeSheets()"><span class="label">Cancel</span></button><button class="btn" onclick="saveRename('${id}')"><span class="label">Save</span></button>`);
  setTimeout(() => { const i = $('renameInput'); if (!i) return; i.focus(); i.select(); i.onkeydown = (e) => { if (e.key === 'Enter') saveRename(id); }; }, 260);
}
function saveRename(id) {
  const v = ($('renameInput').value || '').trim(); if (!v) return toast('Enter a name');
  const l = data.locations.find((x) => x.id === id); if (!l) return closeSheets();
  l.label = v; saveData(); closeSheets(); renderProfile(); renderHome(); drawPlaces(); toast('Renamed to ' + v);
}

/* ------------------------------------------------------------ emergency */
function contactNumbers() { return data.contacts.map((c) => c.phone.replace(/[^\d+]/g, '')).join(','); }
function needContacts(direct) {
  if (!direct) toast('Add a contact first — they will appear on the Call tab', 3500);
  setTimeout(() => { show('profile'); $('addContactForm').style.display = 'flex'; $('addContactForm').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('newContactName').focus({ preventScroll: true }); }, direct ? 50 : 600);
}
function sendSafe() {
  if (!data.contacts.length) return needContacts();
  const p = reportPlace();
  const text = `${data.profile.name || 'Me'}: I'm safe.${p ? ' I\'m near ' + p.label + ': https://maps.google.com/?q=' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5) : ''} (sent from Aflare)`;
  goExternal(`sms:${contactNumbers()}${isIOS ? '&' : '?'}body=${encodeURIComponent(text)}`);
}
function findStations() {
  const p = reportPlace();
  const url = p ? `https://www.google.com/maps/search/fire+station/@${p.lat.toFixed(5)},${p.lng.toFixed(5)},13z` : 'https://www.google.com/maps/search/fire+station+near+me';
  window.open(url, '_blank', 'noopener');
}

/* ----------------------------------------------------------- fire sheet */
function zoomToSheet() {
  if (!sheetCtx) return;
  const o = sheetCtx.kind === 'inc' ? sheetCtx.f : sheetCtx.c;
  closeSheets();
  if (currentScreen !== 'map') goTab('map');
  setTimeout(() => map.setView([o.lat, o.lng], Math.max(map.getZoom(), 13)), 150);
}

/* ------------------------------------------------- map: accessible list */
/* Everything on the map in a plain list — works with keyboards, screen readers and big fingers. */
function openMapList() {
  if (!map) return;
  const b = map.getBounds(), c = map.getCenter();
  const inView = (x) => b.contains([x.lat, x.lng]);
  const items = [];
  if (state.layers.inc) incidents.filter(inView).forEach((f) => items.push({ k: 'inc', f, lat: f.lat, lng: f.lng, d: distMiles(c.lat, c.lng, f.lat, f.lng) }));
  if (state.layers.sat && map.getZoom() >= 5) clusterPoints(viewPoints.filter(inView), 0.1).forEach((cl) => items.push({ k: 'hs', c: cl, lat: cl.lat, lng: cl.lng, d: distMiles(c.lat, c.lng, cl.lat, cl.lng) }));
  items.sort((a, b2) => (b2.k === 'inc' && incActive(b2.f)) - (a.k === 'inc' && incActive(a.f)) || (b2.k === 'inc') - (a.k === 'inc') || a.d - b2.d);
  state.mapList = items.slice(0, 40);
  const h = viewLoc();
  const rows = state.mapList.map((it, i) => {
    const t = it.k === 'inc' ? it.f.name : `${it.c.n} heat detection${it.c.n > 1 ? 's' : ''}`;
    const away = h ? ' · ' + fmtMi(distMiles(h.lat, h.lng, it.lat, it.lng)) + ' from ' + (state.gpsView ? 'you' : h.label) : '';
    const sub = it.k === 'inc' ? `Official incident · ${incSize(it.f)} · ${incContain(it.f)}${away}` : `Satellite, unconfirmed · ${ago(it.c.t)}${away}`;
    return `<button class="nearrow k-${it.k}" onclick="openMapListItem(${i})"><span class="ic" aria-hidden="true"><svg><use href="#${it.k === 'inc' ? 'i-flame' : 'i-warn'}"/></svg></span><span class="grow"><span class="h">${esc(t)}</span><span class="s">${esc(sub)}</span></span><svg class="chev" aria-hidden="true"><use href="#i-chevr"/></svg></button>`;
  }).join('');
  const note = map.getZoom() < 5 && state.layers.sat ? '<p class="muted">Zoom in to include satellite heat detections.</p>' : '';
  showInfo('On the map now', (rows ? `<p class="muted">${state.mapList.length}${items.length > 40 ? ' of ' + items.length : ''} item${state.mapList.length === 1 ? '' : 's'} in this view — official incidents first (active, then contained), then satellite heat nearest the center.</p>` + rows : `<p>${!state.layers.inc && !state.layers.sat ? 'Both layers are turned off. Turn on “Heat detections” or “Incidents”.' : 'Nothing to show in this part of the map. Zoom out or search another place.'}</p>`) + note);
}
function openMapListItem(i) {
  const it = (state.mapList || [])[i]; if (!it) return;
  closeSheets();
  map.setView([it.lat, it.lng], Math.max(map.getZoom(), 11));
  setTimeout(() => { if (it.k === 'inc') openIncidentSheet(it.f); else openHotspotSheet(it.c); }, 250);
}

/* -------------------------------------------------------------- privacy */
function renderPrivacy() {
  $('photoCredits').innerHTML = PHOTO_CREDITS.map((c) => `<li><b>${esc(c.description)}</b><br>${esc(c.author)} · <a href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(c.license)}${NEWTAB}</a></li>`).join('');
  $('srcFire').innerHTML = nasaProxyUrl()
    ? 'NASA FIRMS VIIRS 375&nbsp;m near-real-time active fire data, fetched directly from NASA\'s FIRMS API (backup source: the same NASA data via Esri\'s Living Atlas).'
    : 'NASA FIRMS VIIRS 375&nbsp;m active fire data (NASA/LANCE), served by Esri\'s Living Atlas.';
}

/* --------------------------------------------- keyboard & screen readers */
function enhanceClickables() {
  document.querySelectorAll('#app [onclick]:not(button):not(a):not(input):not([role]):not(.sheet-backdrop)').forEach((el) => {
    el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  });
  syncStates();
}
/* Keep ARIA states in step with the visual classes (screen readers hear on/off, pressed, checked). */
function syncStates() {
  document.querySelectorAll('#app .switch').forEach((el) => el.setAttribute('aria-checked', String(el.classList.contains('on'))));
  document.querySelectorAll('#app .chip, #app .rchip').forEach((el) => el.setAttribute('aria-pressed', String(el.classList.contains('active'))));
  document.querySelectorAll('#app .clitem').forEach((el) => el.setAttribute('aria-checked', String(el.classList.contains('checked'))));
}
function skipToContent(e) {
  e.preventDefault();
  const scr = document.querySelector('.screen.active');
  const target = scr && (scr.querySelector('h1') || scr.querySelector('button, a, input'));
  if (target) { if (!target.matches('button, a, input')) target.setAttribute('tabindex', '-1'); target.focus(); }
}
function togglePw(btn) {
  const inp = btn.parentElement.querySelector('input');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.querySelector('use').setAttribute('href', show ? '#i-eyeoff' : '#i-eye');
}
const enhanceSoon = debounce(enhanceClickables, 120);
document.addEventListener('keydown', (e) => {
  const openSheet = document.querySelector('.sheet.open');
  if (e.key === 'Escape') { if (openSheet) closeSheets(); return; }
  if (e.key === 'Tab' && openSheet) {   // keep keyboard focus inside the open dialog
    const f = [...openSheet.querySelectorAll('button, a[href], input, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!openSheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t && t.getAttribute && t.getAttribute('role') === 'button' && t.hasAttribute('onclick')) { e.preventDefault(); t.click(); }
});
/* Give the static top bar a backdrop once content scrolls underneath it. */
document.addEventListener('scroll', (e) => {
  const t = e.target; if (!t.classList || !t.classList.contains('content')) return;
  $('topbar').classList.toggle('solid', t.scrollTop > 6 && currentScreen !== 'map');
}, true);
new MutationObserver(enhanceSoon).observe($('app'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
enhanceClickables();

boot();
