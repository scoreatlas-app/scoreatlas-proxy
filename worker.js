// ScoreAtlas proxy (Cloudflare Worker)
// Secret: API_KEY (jouw API-Football key). Optioneel variabele: ALLOW = "https://scoreatlas.org"
const UP = "https://v3.football.api-sports.io";
const ttl = p =>
  p.startsWith("/fixtures") && p.includes("live=") ? 20 :
  p.startsWith("/standings") ? 600 :
  p.startsWith("/fixtures") ? 60 :
  p.startsWith("/coachs") ? 86400 :
  p.startsWith("/players") ? 3600 : 180;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const list = (env.ALLOW || "").split(",").map(x => x.trim()).filter(Boolean);
    const ok = !list.length || list.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": list.length ? (ok ? origin : list[0]) : "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(req.url);
    const path = u.pathname + u.search;
    if (u.pathname === "/") return new Response("ScoreAtlas proxy OK", { headers: cors });
    if (u.pathname === "/chat") {
      if (!ok) return new Response("Forbidden", { status: 403, headers: cors });
      if (!env.CHAT) return new Response(JSON.stringify({ error: "Forum niet beschikbaar" }), { status: 501, headers: { ...cors, "content-type": "application/json" } });
      const room = u.searchParams.get("room") || "";
      if (!/^[A-Za-z0-9]{1,16}$/.test(room)) return new Response("Bad room", { status: 400, headers: cors });
      if (req.method !== "GET" && req.method !== "POST") return new Response("Method", { status: 405, headers: cors });
      const body = req.method === "POST" ? await req.text() : null;
      if (body && body.length > 3000) return new Response("Too large", { status: 413, headers: cors });
      const stub = env.CHAT.get(env.CHAT.idFromName(room));
      const r = await stub.fetch("https://chat/x?u=" + encodeURIComponent((u.searchParams.get("u") || "").slice(0, 40)) + "&ip=" + encodeURIComponent(req.headers.get("cf-connecting-ip") || ""), { method: req.method, body });
      const out = new Response(r.body, r);
      Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    if (!ok || req.method !== "GET") return new Response("Forbidden", { status: 403, headers: cors });
    if (!/^\/(fixtures|standings|leagues|players|coachs|injuries|teams|transfers|sidelined|venues|countries|trophies)/.test(u.pathname)) return new Response("Not found", { status: 404, headers: cors });
    const cache = caches.default;
    const key = new Request(UP + path);
    const T = ttl(path) * 1000;
    // Haalt vers antwoord op bij API-Football; bewaart het 6 uur (als "oud" antwoord blijft het bruikbaar)
    const fetchFresh = async (tries) => {
      let up, txt;
      for (let i = 0; i < tries; i++) {
        up = await fetch(UP + path, { headers: { "x-apisports-key": env.API_KEY } });
        txt = await up.text();
        if (!/rateLimit|Too many requests/i.test(txt)) break;
        if (i < tries - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
      const bad = /"errors":\s*(\{[^}]|\[[^\]])/.test(txt) || /rateLimit|Too many requests/i.test(txt);
      const r = new Response(txt, { status: up.status, headers: { "content-type": "application/json" } });
      if (up.ok && !bad) {
        const st = new Response(txt, { headers: { "content-type": "application/json", "Cache-Control": "public, max-age=21600", "x-ts": String(Date.now()) } });
        ctx.waitUntil(cache.put(key, st));
      }
      return { r, ok: up.ok && !bad };
    };
    let res = await cache.match(key);
    const age = res ? Date.now() - Number(res.headers.get("x-ts") || 0) : 0;
    const maxStale = T <= 60000 ? 120000 : 21600000; // live/wedstrijden: max 2 min oud tonen
    if (res && age <= maxStale) {
      if (age > T) ctx.waitUntil(fetchFresh(2)); // verouderd: direct tonen, op achtergrond verversen
    } else {
      res = (await fetchFresh(3)).r;
    }
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  }
};

// ---- Live forum: one Durable Object per room (match id) ----
export class Chat {
  constructor(state, env) { this.s = state; this.env = env; this.rl = new Map(); }
  async fetch(req) {
    const u = new URL(req.url), me = (u.searchParams.get("u") || "").slice(0, 40), ip = u.searchParams.get("ip") || "";
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    let list = (await this.s.storage.get("m")) || [];
    if (req.method === "GET") {
      return J(list.filter(x => (x.r || []).length < 3).slice(-300).map(x => ({
        id: x.id, ts: x.ts, u: x.u, n: x.n, t: x.t, p: x.p || null,
        lk: (x.l || []).length, dk: (x.d || []).length, ml: (x.l || []).includes(me), md: (x.d || []).includes(me)
      })));
    }
    let b; try { b = JSON.parse(await req.text()); } catch (e) { return J({ error: "Bad request" }, 400); }
    const uid = String(b.u || me || "").slice(0, 40); if (!uid) return J({ error: "Bad request" }, 400);
    const a = b.a, now = Date.now();
    const save = () => this.s.storage.put("m", list);
    if (a === "post") {
      const t = String(b.t || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 280);
      const n = String(b.n || "Gast").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 20) || "Gast";
      if (!t) return J({ error: "Leeg bericht" }, 400);
      if (/(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|nl|tr|io|me|ly|gg|co|xyz|info|biz|ru|cn)\b|@\w)/i.test(t)) return J({ error: "Links zijn niet toegestaan." }, 400);
      const k = uid + "|" + ip, hist = (this.rl.get(k) || []).filter(x => now - x < 60000);
      if (hist.length && now - hist[hist.length - 1] < 4000) return J({ error: "Te snel, wacht even" }, 429);
      if (hist.length >= 6) return J({ error: "Te snel, wacht even" }, 429);
      hist.push(now); this.rl.set(k, hist);
      let p = null;
      if (b.p) { const par = list.find(x => x.id === b.p && !x.p); if (par) p = par.id; }
      const msg = { id: crypto.randomUUID().slice(0, 8), ts: now, u: uid, n, t, p, l: [], d: [], r: [] };
      list.push(msg); if (list.length > 400) list = list.slice(-400);
      await save(); return J({ ok: 1, id: msg.id });
    }
    const m = list.find(x => x.id === b.id);
    if (!m) return J({ error: "Niet gevonden" }, 404);
    if (a === "like" || a === "dislike") {
      const on = a === "like" ? "l" : "d", off = a === "like" ? "d" : "l";
      m[off] = (m[off] || []).filter(x => x !== uid);
      m[on] = m[on] || [];
      if (m[on].includes(uid)) m[on] = m[on].filter(x => x !== uid); else if (m[on].length < 2000) m[on].push(uid);
      await save(); return J({ ok: 1 });
    }
    if (a === "report") {
      m.r = m.r || []; if (!m.r.includes(uid) && m.r.length < 50) m.r.push(uid);
      await save(); return J({ ok: 1 });
    }
    if (a === "del") {
      const admin = this.env.ADMIN && b.key === this.env.ADMIN;
      if (m.u !== uid && !admin) return J({ error: "Niet toegestaan" }, 403);
      list = list.filter(x => x.id !== m.id && x.p !== m.id);
      await save(); return J({ ok: 1 });
    }
    return J({ error: "Bad request" }, 400);
  }
}
