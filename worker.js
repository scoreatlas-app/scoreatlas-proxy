// ScoreAtlas proxy (Cloudflare Worker)
// Secret: API_KEY (jouw API-Football key). Optioneel variabele: ALLOW = "https://scoreatlas.org"
const UP = "https://v3.football.api-sports.io";
const ttl = p =>
  p.startsWith("/fixtures") && p.includes("live=") ? 15 :
  p.startsWith("/fixtures") && (p.includes("status=FT") || p.includes("ids=")) ? 3600 :
  p.startsWith("/standings") ? 600 :
  p.startsWith("/fixtures") ? 60 :
  p.startsWith("/coachs") ? 86400 :
  p.startsWith("/players/squads") ? 21600 :
  p.startsWith("/players") ? 3600 : 180;

// ---- Vooraf ophalen (cron): populaire competities en clubs staan klaar in de cache ----
const WL = [39,140,135,78,61,88,144,94,203,71,128,2,3,848,40,179,207,218,113,103,119,253,307,262];
const WT = [645,611,549,998,40,50,33,42,49,47,541,529,530,157,165,85,496,505,489,194,197,209,211,212];
async function warm(path, env, cache) {
  try {
    const r = await fetch(UP + path, { headers: { "x-apisports-key": env.API_KEY } });
    const txt = await r.text();
    const bad = /"errors":\s*(\{[^}]|\[[^\]])/.test(txt) || /rateLimit|Too many requests/i.test(txt);
    if (r.ok && !bad && !/"results":\s*0/.test(txt))
      await cache.put(new Request(UP + path), new Response(txt, { headers: { "content-type": "application/json", "Cache-Control": "public, max-age=21600", "x-ts": String(Date.now()) } }));
  } catch (e) {}
}
async function prewarm(env, withTeams) {
  const cache = caches.default, d = new Date();
  const season = d.getUTCMonth() < 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  for (const id of WL) { await warm("/standings?league=" + id + "&season=" + season, env, cache); await new Promise(r => setTimeout(r, 400)); }
  if (withTeams) for (const id of WT) {
    await warm("/fixtures?team=" + id + "&last=5", env, cache); await new Promise(r => setTimeout(r, 400));
    await warm("/fixtures?team=" + id + "&next=5", env, cache); await new Promise(r => setTimeout(r, 400));
  }
}

// ---- Scheidsrechters: elke 30 min wordt 1 competitie verwerkt en bewaard (Durable Object "__refs") ----
const RL = [39,140,135,78,61,88,144,94,203,71,128,2,3,848,40,179,207,218,113,103,119,253,307,262,136,79,62,141,1,4,5,13,11,45];
async function apiJ(path, env) {
  const r = await fetch(UP + path, { headers: { "x-apisports-key": env.API_KEY } });
  const j = await r.json();
  if (!r.ok || (j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length))) throw new Error("api");
  return j.response || [];
}
async function refJob(env, k) {
  const id = RL[k % RL.length], y = new Date().getUTCFullYear();
  let fx = [], season = y;
  for (const s of [y, y - 1]) {
    try { fx = (await apiJ("/fixtures?league=" + id + "&season=" + s + "&status=FT", env)).filter(f => f.fixture.referee); } catch (e) { fx = []; }
    if (fx.length) { season = s; break; }
  }
  if (!fx.length) return;
  fx = fx.slice(-400);
  const o = {}, name = fx[0].league.country + " · " + fx[0].league.name;
  const proc = d => d.forEach(f => {
    const n = f.fixture.referee; if (!n) return;
    const q = o[n] = o[n] || { m: 0, y: 0, r: 0, f: 0, fc: 0, p: 0, g: 0, fi: "9999", la: "0" }, dt = f.fixture.date.slice(0, 10);
    q.m++; q.g += (f.goals.home || 0) + (f.goals.away || 0); if (dt < q.fi) q.fi = dt; if (dt > q.la) q.la = dt;
    (f.events || []).forEach(e => { const dd = String(e.detail || ""); if (e.type == "Card") { if (/second yellow|red/i.test(dd)) q.r++; else if (/yellow/i.test(dd)) q.y++; } else if (e.type == "Goal" && /^penalty/i.test(dd) || /missed penalty/i.test(dd)) q.p++; });
    let fl = 0, ok = false; (f.statistics || []).forEach(z => { const v = (z.statistics || []).find(t => t.type == "Fouls"); if (v && v.value != null) { fl += +v.value || 0; ok = true; } });
    if (ok) { q.f += fl; q.fc++; }
  });
  const ch = []; for (let i = 0; i < fx.length; i += 20) ch.push(fx.slice(i, i + 20));
  const work = async () => { while (ch.length) { const c = ch.shift(); try { proc(await apiJ("/fixtures?ids=" + c.map(f => f.fixture.id).join("-"), env)); } catch (e) {} } };
  await Promise.all([work(), work(), work(), work(), work()]);
  if (!Object.keys(o).length) return;
  const stub = env.CHAT.get(env.CHAT.idFromName("__refs"));
  await stub.fetch("https://chat/rput", { method: "POST", body: JSON.stringify({ id, n: name, s: season, t: Date.now(), rows: o }) });
}

export default {
  async scheduled(ev, env, ctx) {
    if (ev.cron === "7,37 * * * *") { if (env.CHAT) ctx.waitUntil(refJob(env, Math.floor(ev.scheduledTime / 1800000))); return; }
    ctx.waitUntil(prewarm(env, new Date(ev.scheduledTime).getUTCMinutes() < 20));
  },
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
    if (u.pathname === "/refs") {
      if (!ok || req.method !== "GET") return new Response("Forbidden", { status: 403, headers: cors });
      if (!env.CHAT) return new Response("[]", { headers: { ...cors, "content-type": "application/json" } });
      const r = await env.CHAT.get(env.CHAT.idFromName("__refs")).fetch("https://chat/rget");
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
    if (u.pathname === "/rput") { const b = JSON.parse(await req.text()); await this.s.storage.put("r:" + b.id, b); return J({ ok: 1 }); }
    if (u.pathname === "/rget") { const m = await this.s.storage.list({ prefix: "r:" }); return J([...m.values()]); }
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
