
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
let baseLayer, labelLayer, oldBase = [];
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
  if (baseLayer) oldBase.push(baseLayer);
  if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
  const layer = baseLayer = L.tileLayer(BASEMAPS[kind].url, BASEMAPS[kind].opt).addTo(map);
  layer.bringToBack();
  /* Keep the previous map underneath until the new tiles have loaded, so switching never flashes a blank map. */
  const swap = () => {
    if (layer !== baseLayer) return;
    oldBase.forEach((l) => map.removeLayer(l)); oldBase = [];
    if (kind === 'sat' && !labelLayer) labelLayer = L.tileLayer(BASEMAPS.labels.url, BASEMAPS.labels.opt).addTo(map);
  };
  if (oldBase.length) { layer.once('load', swap); setTimeout(swap, 5000); } else swap();
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
