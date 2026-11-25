// ScoreAtlas proxy (Cloudflare Worker)
// Secret: API_KEY (jouw API-Football key). Optioneel variabele: ALLOW = "https://scoreatlas.org"
// Pushmeldingen: secret VAPID_PRIVATE, variabele VAPID_PUBLIC. Optioneel PUSH_MS (standaard 20000) = hoe vaak gecontroleerd wordt als niemand de site open heeft.
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

// ---- Web Push (VAPID + aes128gcm), zonder extra pakketten ----
// Secret: VAPID_PRIVATE  ·  Variabele: VAPID_PUBLIC (staat in wrangler.jsonc)
const b64u = {
  enc: b => { let s = ""; const a = new Uint8Array(b); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec: s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const t = atob(s), a = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a; }
};
const cat = (...xs) => { const n = xs.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const te = new TextEncoder();
async function hmac(key, data) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
let VKEY = null;
async function vapidKey(env) {
  if (VKEY) return VKEY;
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const jwk = { kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true };
  VKEY = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return VKEY;
}
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const h = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://scoreatlas.org" })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(env), te.encode(h + "." + c)));
  return "vapid t=" + h + "." + c + "." + b64u.enc(sig) + ", k=" + env.VAPID_PUBLIC;
}
async function encryptPayload(sub, text) {
  const ua = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, cat(te.encode("WebPush: info\0"), ua, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(te.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
let LASTERR = "";
// Geeft de HTTP-status terug (201 = gelukt, 404/410 = abonnement bestaat niet meer)
async function sendPush(sub, payload, env, ttl) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Authorization": await vapidAuth(sub.endpoint, env), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": String(ttl || 300), "Urgency": "high" },
    body
  });
  if (r.status >= 300) { try { LASTERR = r.status + " " + (await r.text()).slice(0, 200); } catch (e) { LASTERR = String(r.status); } }
  return r.status;
}
const PW = {
  goal: { nl: "GOAL", tr: "GOL", en: "GOAL", us: "GOAL", es: "GOL", la: "GOL", de: "TOR", fr: "BUT", it: "GOL", pt: "GOLO", br: "GOL", zh: "进球", ja: "ゴール", ko: "골" },
  no: { nl: "Doelpunt afgekeurd", tr: "Gol iptal edildi", en: "Goal disallowed", us: "Goal disallowed", es: "Gol anulado", la: "Gol anulado", de: "Tor aberkannt", fr: "But refusé", it: "Gol annullato", pt: "Golo anulado", br: "Gol anulado", zh: "进球无效", ja: "ゴール取り消し", ko: "골 취소" },
  og: { nl: "eigen doelpunt", tr: "kendi kalesine", en: "own goal", us: "own goal", es: "en propia", la: "en contra", de: "Eigentor", fr: "csc", it: "autogol", pt: "autogolo", br: "gol contra", zh: "乌龙球", ja: "オウンゴール", ko: "자책골" },
  pen: { nl: "penalty", tr: "penaltı", en: "penalty", us: "penalty", es: "penalti", la: "penal", de: "Elfmeter", fr: "penalty", it: "rigore", pt: "penálti", br: "pênalti", zh: "点球", ja: "PK", ko: "페널티킥" }
};

export default {
  async scheduled(ev, env, ctx) {
    if (env.LIVE) ctx.waitUntil(env.LIVE.get(env.LIVE.idFromName("live")).fetch("https://live/wake").catch(() => {}));
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
    if (u.pathname === "/usage") {
      // Toont hoeveel API-aanvragen vandaag gebruikt zijn. /status van API-Football telt zelf niet mee. 60 s in geheugen.
      const ck = new Request("https://usage.cache/v1"); let d = null;
      const hit = await caches.default.match(ck);
      if (hit) d = await hit.json();
      else {
        try {
          const r = await fetch(UP + "/status", { headers: { "x-apisports-key": env.API_KEY } });
          const j = await r.json(), q = (j.response || {}).requests || {}, sub = (j.response || {}).subscription || {};
          d = { used: +q.current || 0, limit: +q.limit_day || 0, plan: sub.plan || "", t: Date.now() };
          if (d.limit) await caches.default.put(ck, new Response(JSON.stringify(d), { headers: { "Cache-Control": "public, max-age=60" } }));
        } catch (e) { d = null; }
      }
      const H = { "content-type": "application/json", "Cache-Control": "no-store", ...cors };
      if (!d || !d.limit) return new Response(JSON.stringify({ error: "geen gegevens" }), { status: 502, headers: H });
      const left = Math.max(0, d.limit - d.used), pct = Math.min(100, Math.round(d.used / d.limit * 100));
      if (u.searchParams.get("json") !== null || /application\/json/.test(req.headers.get("accept") || "") && !/text\/html/.test(req.headers.get("accept") || ""))
        return new Response(JSON.stringify({ used: d.used, limit: d.limit, left, pct, plan: d.plan }), { headers: H });
      const col = pct < 60 ? "#16a24a" : pct < 85 ? "#e0a800" : "#d33";
      const f = n => n.toLocaleString("nl-NL");
      const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Gebruik</title><body style="font:18px -apple-system,system-ui,sans-serif;margin:0;padding:28px;background:#f3f8f4;color:#0b2b17"><h1 style="font-size:22px;margin:0 0 6px">API-gebruik vandaag</h1><p style="margin:0 0 18px;color:#567">Abonnement: ${d.plan || "onbekend"} · bijgewerkt ${new Date(d.t || Date.now()).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" })}</p><div style="background:#dfe9e2;border-radius:12px;height:26px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${col}"></div></div><p style="font-size:34px;font-weight:800;margin:14px 0 2px">${f(d.used)} <span style="font-size:18px;font-weight:600;color:#567">van ${f(d.limit)}</span></p><p style="margin:0 0 18px">${pct}% gebruikt · nog <b>${f(left)}</b> over</p><p style="color:#567;font-size:15px">De teller begint elke nacht om 00:00 UTC opnieuw (01:00 in de winter, 02:00 in de zomer). Boven 85% (rood): overweeg een groter abonnement.</p>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (u.pathname === "/live") {
      if (!ok || req.method !== "GET") return new Response("Forbidden", { status: 403, headers: cors });
      if (!env.LIVE) return new Response("Live niet beschikbaar", { status: 501, headers: cors });
      const r = await env.LIVE.get(env.LIVE.idFromName("live")).fetch("https://live/sse");
      const out = new Response(r.body, { status: r.status, headers: r.headers });
      Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
    if (u.pathname.startsWith("/push/")) {
      if (!ok || req.method !== "POST") return new Response("Forbidden", { status: 403, headers: cors });
      if (!env.LIVE || !env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return new Response(JSON.stringify({ error: "Push niet ingesteld" }), { status: 501, headers: { ...cors, "content-type": "application/json" } });
      const body = await req.text();
      if (body.length > 8000) return new Response("Too large", { status: 413, headers: cors });
      const r = await env.LIVE.get(env.LIVE.idFromName("live")).fetch("https://live" + u.pathname.slice(5), { method: "POST", body });
      const out = new Response(r.body, r);
      Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set("Cache-Control", "no-store");
      return out;
    }
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

// ---- Live push: 1 Durable Object haalt live=all op (zolang er bezoekers zijn) en stuurt alleen veranderingen via SSE ----
// Variabele (optioneel): LIVE_MS = interval in ms (standaard 5000). Past zichzelf aan als het dagquotum van API-Football bijna op is.
export class Live {
  constructor(state, env) {
    this.s = state; this.env = env; this.cl = new Set(); this.sig = new Map(); this.mn = "";
    this.ready = false; this.running = false; this.empty = false; this.rem = null; this.enc = new TextEncoder();
    this.subs = null; this.gl = new Map(); this.lastPull = 0;
  }
  async loadSubs() { if (!this.subs) this.subs = new Map(await this.s.storage.list({ prefix: "s:" })); return this.subs; }
  async skey(ep) { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(ep))); return "s:" + [...h.slice(0, 16)].map(x => x.toString(16).padStart(2, "0")).join(""); }
  async wake() { await this.loadSubs(); if (this.subs.size && !(await this.s.storage.getAlarm())) await this.s.storage.setAlarm(Date.now() + 3000); }
  async alarm() {
    await this.loadSubs();
    if (!this.subs.size) return;
    if (!this.running) { try { await this.pull(); } catch (e) {} }
    const next = this.running ? 60000 : Math.max(+this.env.PUSH_MS || 20000, this.base());
    await this.s.storage.setAlarm(Date.now() + next);
  }
  async api(req, path) {
    const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (path === "/wake") { await this.wake(); return J({ ok: 1 }); }
    let b; try { b = JSON.parse(await req.text()); } catch (e) { return J({ error: "Bad request" }, 400); }
    const sub = b && b.sub, ep = sub && String(sub.endpoint || "");
    if (!/^https:\/\/[^\s]{10,600}$/.test(ep)) return J({ error: "Bad subscription" }, 400);
    await this.loadSubs();
    const k = await this.skey(ep);
    if (path === "/unsub") { this.subs.delete(k); await this.s.storage.delete(k); return J({ ok: 1 }); }
    if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) return J({ error: "Bad subscription" }, 400);
    const l = /^[a-z]{2}$/.test(b.l || "") ? b.l : "en";
    const clean = { endpoint: ep, keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } };
    if (path === "/test") {
      const st = await sendPush(clean, { title: "✅ ScoreAtlas", body: ({ nl: "Meldingen staan aan. Je krijgt een melding bij elk doelpunt van je ⭐-wedstrijden en -teams.", tr: "Bildirimler açık. ⭐ maçlarında ve takımlarında her golde bildirim alırsın." }[l]) || "Notifications are on. You'll get an alert for every goal in your ⭐ matches and teams.", url: "/", tag: "test" }, this.env, 60).catch(e => { LASTERR = "fout: " + (e && e.message || e); return 0; });
      return J({ ok: st >= 200 && st < 300, status: st, err: st >= 200 && st < 300 ? "" : LASTERR, host: new URL(clean.endpoint).host });
    }
    if (path === "/sub") {
      const t = (Array.isArray(b.t) ? b.t : []).map(x => String(x).slice(0, 60)).slice(0, 60);
      const f = (Array.isArray(b.f) ? b.f : []).map(x => +x).filter(x => x > 0).slice(0, 150);
      const o = { sub: clean, t, f, l, ts: Date.now() };
      this.subs.set(k, o); await this.s.storage.put(k, o);
      await this.wake();
      return J({ ok: 1 });
    }
    return J({ error: "Not found" }, 404);
  }
  async notify(evs) {
    await this.loadSubs();
    if (!this.subs.size || !evs.length) return;
    const jobs = [];
    for (const ev of evs) {
      const f = ev.f, hn = f.teams.home.name, an = f.teams.away.name, id = f.fixture.id, g = [f.goals.home ?? 0, f.goals.away ?? 0];
      for (const [k, o] of this.subs) {
        if (!(o.f || []).includes(id) && !(o.t || []).includes(hn) && !(o.t || []).includes(an)) continue;
        const L = o.l, sc = hn + " " + g[0] + "–" + g[1] + " " + an;
        let p;
        if (ev.k === "goal") {
          const side = ev.side === 0 ? f.teams.home.id : ev.side === 1 ? f.teams.away.id : 0;
          const ge = (f.events || []).filter(e => e.type === "Goal" && !/missed/i.test(e.detail || "") && (!side || (e.team && e.team.id === side))).pop();
          const min = (f.fixture.status || {}).elapsed;
          let who = ge && ge.player && ge.player.name ? ge.player.name : "";
          if (who && /own/i.test(ge.detail || "")) who += " (" + (PW.og[L] || PW.og.en) + ")";
          else if (who && /penalty/i.test(ge.detail || "")) who += " (" + (PW.pen[L] || PW.pen.en) + ")";
          const mt = ge && ge.time && ge.time.elapsed ? ge.time.elapsed + (ge.time.extra ? "+" + ge.time.extra : "") : min;
          p = { title: "⚽ " + (PW.goal[L] || PW.goal.en) + "! " + sc, body: (mt ? mt + "′ " : "") + who, url: "/?m=" + id, tag: "g" + id };
        } else p = { title: "❌ " + (PW.no[L] || PW.no.en), body: sc, url: "/?m=" + id, tag: "g" + id };
        jobs.push([k, o, p]);
      }
    }
    for (let i = 0; i < jobs.length; i += 25) {
      await Promise.all(jobs.slice(i, i + 25).map(async ([k, o, p]) => {
        try { const st = await sendPush(o.sub, p, this.env, 300); if (st === 404 || st === 410) { this.subs.delete(k); await this.s.storage.delete(k); } } catch (e) {}
      }));
    }
  }
  put(c, str) {
    try {
      if (c.w.desiredSize !== null && c.w.desiredSize < -3) { this.cl.delete(c); try { c.w.abort(); } catch (e) {} return; }
      c.w.write(this.enc.encode(str)).catch(() => this.cl.delete(c));
    } catch (e) { this.cl.delete(c); }
  }
  all(str) { for (const c of [...this.cl]) this.put(c, str); }
  async fetch(req) {
    const pth = new URL(req.url).pathname;
    if (pth !== "/sse") return this.api(req, pth);
    const { readable, writable } = new TransformStream();
    const c = { w: writable.getWriter() };
    this.cl.add(c);
    this.put(c, "retry: 3000\nevent: hi\ndata: " + Date.now() + "\n\n");
    if (!this.running) { this.running = true; if (Date.now() - this.lastPull > 60000) { this.ready = false; this.sig = new Map(); } this.mn = ""; setTimeout(() => this.tick(), 0); }
    return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
  base() {
    let ms = Math.max(2000, +this.env.LIVE_MS || 5000);
    if (this.empty) ms = Math.max(ms, 30000);
    const r = this.rem;
    if (r != null) { if (r < 150) ms = Math.max(ms, 120000); else if (r < 600) ms = Math.max(ms, 30000); else if (r < 1500) ms = Math.max(ms, 15000); }
    return ms;
  }
  async tick() {
    if (!this.cl.size) { this.running = false; this.wake().catch(() => {}); return; }
    let wait = this.base();
    try { await this.pull(); } catch (e) { wait = Math.max(wait, 10000); }
    this.all("event: hb\ndata: " + Date.now() + "\n\n");
    setTimeout(() => this.tick(), wait);
  }
  async pull() {
    const r = await fetch(UP + "/fixtures?live=all", { headers: { "x-apisports-key": this.env.API_KEY } });
    const rem = parseInt(r.headers.get("x-ratelimit-requests-remaining"), 10);
    if (!isNaN(rem)) this.rem = rem;
    const txt = await r.text();
    if (!r.ok || /rateLimit|Too many requests/i.test(txt)) throw new Error("api");
    const j = JSON.parse(txt);
    if (j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length)) throw new Error("api");
    const arr = j.response || [];
    this.empty = !arr.length;
    if (Date.now() - this.lastPull > 180000) { this.ready = false; this.gl = new Map(); }
    this.lastPull = Date.now();
    // Doelpunten en afgekeurde doelpunten voor pushmeldingen
    const evs = [], gl = new Map(), LV = /^(1H|HT|2H|ET|BT|P|LIVE|INT)$/;
    for (const f of arr) {
      const id = f.fixture.id, g = [f.goals.home ?? 0, f.goals.away ?? 0], pv = this.gl.get(id), st = (f.fixture.status || {}).short || "";
      gl.set(id, g);
      if (!pv || !this.ready || !LV.test(st)) continue;
      if (g[0] + g[1] > pv[0] + pv[1]) evs.push({ k: "goal", f, side: g[0] > pv[0] && g[1] === pv[1] ? 0 : g[1] > pv[1] && g[0] === pv[0] ? 1 : -1 });
      else if (g[0] + g[1] < pv[0] + pv[1]) evs.push({ k: "no", f });
    }
    this.gl = gl;
    if (evs.length) { try { await this.notify(evs); } catch (e) {} }
    const nx = new Map(), ch = [], mn = {};
    for (const f of arr) {
      const id = f.fixture.id, st = f.fixture.status || {};
      mn[id] = st.elapsed;
      const sg = [f.goals.home, f.goals.away, st.short, (f.events || []).map(e => (e.time && e.time.elapsed) + e.type + e.detail + (e.player && e.player.id)).join("|")].join("~");
      nx.set(id, sg);
      if (this.ready && this.sig.get(id) !== sg) ch.push(f);
    }
    const wasReady = this.ready;
    this.sig = nx; this.ready = true;
    if (!wasReady) { this.mn = JSON.stringify(mn); return; }
    if (ch.length) this.all("event: d\ndata: " + JSON.stringify(ch) + "\n\n");
    const m = JSON.stringify(mn);
    if (m !== this.mn) { this.mn = m; this.all("event: m\ndata: " + m + "\n\n"); }
  }
}
