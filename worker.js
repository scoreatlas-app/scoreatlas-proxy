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
    const list = (env.ALLOW || "").split(",").map(x => x.trim()).filter(Boolean);
    const ok = !list.length || list.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": list.length ? (ok ? origin : list[0]) : "*",
      "Access-Control-Allow-Headers": "*",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(req.url);
    const path = u.pathname + u.search;
    if (u.pathname === "/") return new Response("ScoreAtlas proxy OK", { headers: cors });
    if (u.pathname === "/diag") {
      const d = await fetch(UP + "/status", { headers: { "x-apisports-key": env.API_KEY } });
      const j = await d.json().catch(() => ({}));
      const r = j.response || {};
      const h = k => d.headers.get(k);
      return new Response(JSON.stringify({
        plan: (r.subscription || {}).plan, active: (r.subscription || {}).active,
        day_used: (r.requests || {}).current, day_limit: (r.requests || {}).limit_day,
        minute_limit: h("x-ratelimit-limit"), minute_remaining: h("x-ratelimit-remaining"),
        errors: j.errors
      }, null, 1), { headers: { "content-type": "application/json" } });
    }
    if (!ok || req.method !== "GET") return new Response("Forbidden", { status: 403, headers: cors });
    if (!/^\/(fixtures|standings|leagues|players|coachs|injuries|teams|transfers|sidelined|venues|countries|trophies)/.test(u.pathname)) return new Response("Not found", { status: 404, headers: cors });
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
