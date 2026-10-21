// Aflare → NASA FIRMS proxy (Cloudflare Worker, free tier).
// NASA's API doesn't send CORS headers, so browsers can't call it directly.
// This Worker calls it for you (keeping your MAP_KEY secret) and adds CORS.
//
// Setup: Workers & Pages → Create Worker → paste this file → Settings →
// Variables and Secrets → add secret MAP_KEY = your FIRMS key → Deploy.
// Optional variable ALLOWED_ORIGIN = https://your-aflare-site.com (default *).

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const u = new URL(req.url);
    if (u.pathname !== '/area') return new Response('Aflare NASA proxy. Use /area?west&south&east&north&days', { headers: cors });

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
