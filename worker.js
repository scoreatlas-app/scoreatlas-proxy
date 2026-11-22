// ScoreAtlas proxy (Cloudflare Worker)
// Secret: API_KEY (jouw API-Football key). Optioneel variabele: ALLOW = "https://rcanturkoglu.github.io"
const UP = "https://v3.football.api-sports.io";
const ttl = p =>
  p.startsWith("/fixtures") && p.includes("live=") ? 20 :
  p.startsWith("/standings") ? 300 :
  p.startsWith("/fixtures") ? 60 :
  p.startsWith("/players") || p.startsWith("/coachs") ? 3600 : 120;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const ok = !env.ALLOW || origin === env.ALLOW || origin === "";
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW || "*",
      "Access-Control-Allow-Headers": "*",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!ok || req.method !== "GET") return new Response("Forbidden", { status: 403, headers: cors });
    const u = new URL(req.url);
    const path = u.pathname + u.search;
    if (u.pathname === "/") return new Response("ScoreAtlas proxy OK", { headers: cors });
    const cache = caches.default;
    const key = new Request(UP + path);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(UP + path, { headers: { "x-apisports-key": env.API_KEY } });
      res = new Response(up.body, up);
      if (up.ok) {
        res.headers.set("Cache-Control", "public, max-age=" + ttl(path));
        ctx.waitUntil(cache.put(key, res.clone()));
      }
    }
    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  }
};
