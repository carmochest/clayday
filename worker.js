/* Clay Day — Cloudflare Worker: Ask (Anthropic proxy) + push notifications.
   Setup (Cloudflare dashboard):
   1. Workers & Pages → Create → Worker → paste this → Deploy.
   2. Settings → Variables and Secrets: add secret ANTHROPIC_API_KEY (optional MODEL).
   3. Storage: create a KV namespace (e.g. CLAY_PUSH) and bind it to this Worker as PUSH.
   4. Push keys: open the Worker URL + /push/keygen ONCE in a browser; it prints a VAPID key pair.
      Add secret VAPID_PRIVATE (the "private" value), variable VAPID_PUBLIC (the "public" value),
      and variable VAPID_SUBJECT = "mailto:<your contact email>" (push services require a contact).
      Put the same public value into VAPID_PUBLIC in index.html, and the Worker URL into AI_ENDPOINT.
   5. Triggers → Cron: add "* * * * *" (every minute) so due pushes get sent.
   Nothing here can read the Anthropic key or the push keys from the phone side. */
const ALLOWED = ["https://carmochest.github.io"];
const J = (o, status = 200, cors = {}) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const ok = ALLOWED.includes(origin);
    const cors = { "Access-Control-Allow-Origin": ok ? origin : ALLOWED[0], "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/push/keygen" && req.method === "GET") {            // one-time helper: prints a fresh pair, stores nothing
      const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const pub = await crypto.subtle.exportKey("raw", kp.publicKey), prv = await crypto.subtle.exportKey("jwk", kp.privateKey);
      return J({ public: b64u(new Uint8Array(pub)), private: prv.d, note: "Save VAPID_PRIVATE as a secret and VAPID_PUBLIC as a variable; put the public value in index.html too." });
    }
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
    if (!ok) return J({ error: "origin not allowed" }, 403, cors);
    let body; try { body = await req.json(); } catch { return J({ error: "bad json" }, 400, cors); }

    if (url.pathname === "/push/subscribe") {
      if (!env.PUSH || !body.sub || !body.sub.endpoint) return J({ error: "push not configured" }, 400, cors);
      const id = await sha(body.sub.endpoint);
      await env.PUSH.put("sub:" + id, JSON.stringify({ sub: body.sub, me: body.me || "", lang: body.lang || "en", t: Date.now() }));
      return J({ ok: true }, 200, cors);
    }
    if (url.pathname === "/push/unsubscribe") {
      if (env.PUSH && body.endpoint) { const id = await sha(body.endpoint); await env.PUSH.delete("sub:" + id); await env.PUSH.delete("sched:" + id); }
      return J({ ok: true }, 200, cors);
    }
    if (url.pathname === "/push/schedule") {                                     // the phone tells us its next alerts; we deliver them when the app is closed
      if (!env.PUSH || !body.endpoint) return J({ error: "push not configured" }, 400, cors);
      const id = await sha(body.endpoint);
      const items = (body.items || []).slice(0, 10).map(x => ({ at: Date.parse(x.at) || 0, title: String(x.title || "Clay Day").slice(0, 80), body: String(x.body || "").slice(0, 160) })).filter(x => x.at > Date.now() - 60000);
      await env.PUSH.put("sched:" + id, JSON.stringify({ items, t: Date.now() }));
      return J({ ok: true, n: items.length }, 200, cors);
    }

    /* Ask: Anthropic proxy */
    const messages = (body.messages || []).slice(-12).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 4000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") return J({ error: "no question" }, 400, cors);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.MODEL || "claude-haiku-5-5", max_tokens: 600, system: String(body.system || "").slice(0, 8000), messages })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return J({ error: j.error?.message || ("upstream " + r.status) }, 502, cors);
    return J({ text: (j.content || []).filter(c => c.type === "text").map(c => c.text).join("") }, 200, cors);
  },

  /* every minute: send any scheduled alert whose time has come */
  async scheduled(ev, env, ctx) {
    if (!env.PUSH || !env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return;
    const now = Date.now();
    let cursor; do {
      const page = await env.PUSH.list({ prefix: "sched:", cursor });
      for (const k of page.keys) {
        const id = k.name.slice(6);
        const sch = await env.PUSH.get(k.name, "json"); if (!sch) continue;
        const due = sch.items.filter(x => x.at <= now && x.at > now - 15 * 60000), rest = sch.items.filter(x => x.at > now);
        if (!due.length) { if (rest.length !== sch.items.length) await env.PUSH.put(k.name, JSON.stringify({ items: rest, t: sch.t })); continue; }
        const rec = await env.PUSH.get("sub:" + id, "json");
        if (rec) for (const d of due) { const st = await sendPush(rec.sub, { title: d.title, body: d.body, tag: "clay-" + d.at }, env); if (st === 404 || st === 410) { await env.PUSH.delete("sub:" + id); break; } }
        await env.PUSH.put(k.name, JSON.stringify({ items: rest, t: sch.t }));
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
};

/* ── Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with Web Crypto only ── */
async function sendPush(sub, payload, env) {
  const endpoint = sub.endpoint, p256 = b64d(sub.keys.p256dh), auth = b64d(sub.keys.auth);
  const ua = await crypto.subtle.importKey("raw", p256, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info = (s) => new TextEncoder().encode(s);
  const prk = await hkdf(auth, shared, cat(info("WebPush: info\0"), p256, localPub), 32);
  const cek = await hkdf(salt, prk, info("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prk, info("Content-Encoding: nonce\0"), 12);
  const plain = cat(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const header = cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([localPub.length]), localPub);
  const jwt = await vapidJwt(new URL(endpoint).origin, env);
  const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", "TTL": "900", "Urgency": "high", "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` }, body: cat(header, cipher) });
  return r.status;
}
async function vapidJwt(aud, env) {
  const hdr = b64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" })));
  const pub = b64d(env.VAPID_PUBLIC); const x = b64u(pub.slice(1, 33)), y = b64u(pub.slice(33, 65));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: env.VAPID_PRIVATE, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(hdr + "." + claims)));
  return hdr + "." + claims + "." + b64u(sig);
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
async function sha(s) { return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).slice(0, 32); }
