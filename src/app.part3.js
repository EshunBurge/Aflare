
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
