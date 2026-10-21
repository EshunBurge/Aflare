// Aflare relay (Cloudflare Worker, free tier).
// Two jobs, both because the source servers don't send the CORS headers browsers need:
//   /area  → NASA FIRMS satellite heat detections (keeps your MAP_KEY secret)
//   /news  → wildfire headlines from the GDELT Project (shared cache + retry, so a busy
//            or rate-limited GDELT doesn't break the app for every visitor)
//
// Setup: Workers & Pages → your Worker → Edit code → paste this file → Deploy.
// First time only: Settings → Variables and Secrets → add secret MAP_KEY = your FIRMS key.
// Optional variable ALLOWED_ORIGIN = https://your-aflare-site.com (default *).

const NEWS_TTL = 900;   // seconds a good headlines answer is shared between visitors
const NEWS_BUDGET = 28000; // ms — the app gives up after 35 s; GDELT itself often needs ~15 s

async function news(u, cors) {
  const region = (u.searchParams.get('region') || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const q = '("wildfire" OR "forest fire" OR "brush fire")' + (region ? ' "' + region + '"' : '') + ' sourcelang:english';
  const api = 'https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&maxrecords=40&timespan=2d&sort=datedesc&query=' + encodeURIComponent(q);
  const json = (body, status, cache) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache } });
  const t0 = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    // Attempt 1 may be answered from the shared cache; attempt 2 skips it (in case a bad answer was cached).
    const url = attempt ? api + '&_=' + Date.now() : api;
    const cf = attempt ? { cacheTtl: 0 } : { cacheTtl: NEWS_TTL, cacheEverything: true, cacheTtlByStatus: { '200-299': NEWS_TTL, '300-599': 0 } };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1000, NEWS_BUDGET - (Date.now() - t0)));
    let wait = 0;
    try {
      const res = await fetch(url, { cf, signal: ctl.signal });
      const text = (await res.text()).trim();
      if (res.ok && text.startsWith('{')) return json(text, 200, 'public, max-age=300');
      if (res.ok && text === '') return json('{"articles":[]}', 200, 'public, max-age=300'); // GDELT answers "no matches" with an empty body
      if (res.status === 429) wait = 5500; // GDELT allows one request every 5 seconds
    } catch (_) { /* timed out or network error */ }
    finally { clearTimeout(timer); }
    // Only try again if there is enough of the time budget left for a second GDELT answer (~15 s).
    if (attempt === 0 && Date.now() - t0 + wait > NEWS_BUDGET - 16000) break;
    if (attempt === 0 && wait) await new Promise((r) => setTimeout(r, wait));
  }
  return json('{"error":"The news service is busy. Try again in a minute."}', 502, 'no-store');
}

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const u = new URL(req.url);
    if (u.pathname === '/news') return news(u, cors);
    if (u.pathname !== '/area') return new Response('Aflare relay. Use /area?west&south&east&north&days (NASA) or /news?region= (headlines)', { headers: cors });

    const num = (k) => { const v = parseFloat(u.searchParams.get(k)); return Number.isFinite(v) ? v : null; };
    const w = num('west'), s = num('south'), e = num('east'), n = num('north');
    const days = Math.min(5, Math.max(1, parseInt(u.searchParams.get('days') || '1', 10) || 1));
    if ([w, s, e, n].some((v) => v === null)) return new Response('bad bbox', { status: 400, headers: cors });
    if (!env.MAP_KEY) return new Response('MAP_KEY not set', { status: 500, headers: cors });

    const src = 'VIIRS_SNPP_NRT';
    const api = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.MAP_KEY}/${src}/${w},${s},${e},${n}/${days}`;
    const res = await fetch(api, { cf: { cacheTtl: 300, cacheEverything: true } });
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'text/csv', 'Cache-Control': 'public, max-age=300' } });
  },
};
