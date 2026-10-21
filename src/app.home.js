
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
