var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
import { DurableObject } from "cloudflare:workers";
var SFU_API = "https://rtc.live.cloudflare.com/v1";
var ROOM_CODE = /^[A-Z0-9]{4,12}$/;
var PEER_ID = /^[a-z0-9]{8,32}$/;
var MAX_PEERS = 25;
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Spectra-Key",
  "Access-Control-Max-Age": "86400"
};
var json = /* @__PURE__ */ __name((body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } }), "json");
var fail = /* @__PURE__ */ __name((status, error) => json({ error }, status), "fail");
var SFU_ROUTES = [
  ["POST", /^sessions\/new$/],
  ["POST", /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/new$/],
  ["PUT", /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/update$/],
  ["PUT", /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/close$/],
  ["PUT", /^sessions\/[A-Za-z0-9_-]{1,128}\/renegotiate$/]
];
var index_default = {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (ex) {
      console.error(ex);
      return fail(502, "O servidor n\xE3o conseguiu completar o pedido. Tente de novo.");
    }
  }
};
async function handle(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/api/health") {
    return json({ ok: true, app: "spectra", configured: isConfigured(env) });
  }
  if (!path.startsWith("/api/")) return fail(404, "N\xE3o encontrado.");
  if (!isConfigured(env)) return fail(503, "Servidor sem configura\xE7\xE3o: faltam CF_APP_ID, CF_APP_TOKEN ou SPECTRA_ACCESS_KEY.");
  const ws = path.match(/^\/api\/rooms\/([A-Za-z0-9]{1,16})\/ws$/);
  if (ws) {
    if (request.headers.get("Upgrade") !== "websocket") return fail(426, "Use WebSocket.");
    if (!checkKey(env, url.searchParams.get("key"))) return fail(401, "Chave de acesso incorreta.");
    const code = ws[1].toUpperCase();
    if (!ROOM_CODE.test(code)) return fail(400, "C\xF3digo de sala inv\xE1lido (use de 4 a 12 letras ou n\xFAmeros).");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  }
  if (!checkKey(env, request.headers.get("X-Spectra-Key"))) return fail(401, "Chave de acesso incorreta.");
  if (path === "/api/check") return json({ ok: true });
  if (path === "/api/ice") return json({ iceServers: await iceServers(env) });
  if (path.startsWith("/api/sfu/")) {
    const sub = path.slice("/api/sfu/".length);
    const route = SFU_ROUTES.find(([m, re]) => m === request.method && re.test(sub));
    if (!route) return fail(404, "Opera\xE7\xE3o do SFU n\xE3o permitida.");
    const body = request.method === "POST" || request.method === "PUT" ? await request.text() : void 0;
    if (body && body.length > 256 * 1024) return fail(413, "Pedido grande demais.");
    const res = await fetch(`${SFU_API}/apps/${env.CF_APP_ID}/${sub}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${env.CF_APP_TOKEN}`, "Content-Type": "application/json" },
      body: body || void 0
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") || "application/json", ...CORS }
    });
  }
  return fail(404, "N\xE3o encontrado.");
}
__name(handle, "handle");
function isConfigured(env) {
  return !!(env.CF_APP_ID && env.CF_APP_TOKEN && env.SPECTRA_ACCESS_KEY);
}
__name(isConfigured, "isConfigured");
function checkKey(env, given) {
  if (typeof given !== "string" || !env.SPECTRA_ACCESS_KEY) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.SPECTRA_ACCESS_KEY);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
__name(checkKey, "checkKey");
async function iceServers(env) {
  const stun = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return stun;
  try {
    const res = await fetch(`${SFU_API}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 })
    });
    if (!res.ok) return stun;
    const { iceServers: list } = await res.json();
    return (Array.isArray(list) ? list : [list]).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u))
    }));
  } catch {
    return stun;
  }
}
__name(iceServers, "iceServers");
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async fetch(request) {
    const url = new URL(request.url);
    const name = cleanName(url.searchParams.get("name"));
    const id = url.searchParams.get("id") || "";
    if (!name) return fail(400, "Informe um nome de 1 a 32 caracteres.");
    if (!PEER_ID.test(id)) return fail(400, "Identificador inv\xE1lido.");
    const others = this.sockets().filter((s) => s.peer.id !== id);
    for (const s of this.sockets()) {
      if (s.peer.id === id) closeQuietly(s.ws, 4e3, "Voc\xEA entrou nesta sala em outra janela.");
    }
    if (others.length >= MAX_PEERS) return fail(403, `A sala est\xE1 cheia (m\xE1ximo de ${MAX_PEERS} pessoas).`);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const peer = { id, name, watching: "", quality: "high", share: null, joinedAt: Date.now() };
    server.serializeAttachment(peer);
    server.send(JSON.stringify({ t: "welcome", id, peers: [...others.map((s) => s.peer), peer] }));
    this.broadcast(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 8192) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.t !== "set") return;
    const peer = ws.deserializeAttachment();
    if (!peer) return;
    if ("watching" in msg) peer.watching = typeof msg.watching === "string" && PEER_ID.test(msg.watching) ? msg.watching : "";
    if ("quality" in msg) peer.quality = ["high", "medium", "low"].includes(msg.quality) ? msg.quality : "high";
    if ("share" in msg) peer.share = cleanShare(msg.share);
    ws.serializeAttachment(peer);
    this.broadcast();
  }
  async webSocketClose(ws, code, reason) {
    closeQuietly(ws, code === 1005 ? 1e3 : code, reason);
    this.broadcast(null, ws);
  }
  async webSocketError(ws) {
    closeQuietly(ws, 1011, "erro");
    this.broadcast(null, ws);
  }
  /** Sockets abertos com o participante de cada um. */
  sockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN).map((ws) => ({ ws, peer: ws.deserializeAttachment() })).filter((s) => s.peer);
  }
  /** Manda a lista atualizada para todos (menos `skipSend`, que já recebeu o welcome). */
  broadcast(skipSend = null, gone = null) {
    const list = this.sockets(gone);
    const payload = JSON.stringify({ t: "peers", peers: list.map((s) => s.peer) });
    for (const { ws } of list) {
      if (ws === skipSend) continue;
      try {
        ws.send(payload);
      } catch {
      }
    }
  }
};
function closeQuietly(ws, code, reason) {
  try {
    ws.close(code, String(reason || "").slice(0, 120));
  } catch {
  }
}
__name(closeQuietly, "closeQuietly");
function cleanName(raw) {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length >= 1 && name.length <= 32 ? name : null;
}
__name(cleanName, "cleanName");
function cleanShare(s) {
  if (!s || typeof s !== "object") return null;
  const sessionId = typeof s.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s.sessionId) ? s.sessionId : null;
  if (!sessionId) return null;
  const track = /* @__PURE__ */ __name((t) => typeof t === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : null, "track");
  const video = track(s.video);
  if (!video) return null;
  const layers = Array.isArray(s.layers) ? s.layers.slice(0, 3).map((l) => ({
    rid: track(l?.rid) || "",
    h: Math.max(0, Math.min(4320, Math.round(Number(l?.h) || 0))),
    fps: Math.max(0, Math.min(240, Math.round(Number(l?.fps) || 0)))
  })) : [];
  return { sessionId, video, audio: track(s.audio), layers, codec: track(s.codec) };
}
__name(cleanShare, "cleanShare");
export {
  Room,
  index_default as default
};
//# sourceMappingURL=index.js.map
