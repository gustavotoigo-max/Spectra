// Spectra — servidor na Cloudflare (plano gratuito).
//
// Um único Worker faz três coisas:
//   1. Salas: cada código de sala é um Durable Object que mantém, por WebSocket,
//      a lista de quem está na sala, quem transmite e quem assiste quem.
//   2. Proxy do Cloudflare Realtime SFU: o app fala com /api/sfu/... e o Worker
//      repassa para rtc.live.cloudflare.com com o token secreto, que nunca sai daqui.
//   3. ICE: devolve o STUN da Cloudflare e, se configurado, credenciais TURN
//      temporárias para redes restritivas.
//
// Tudo exige a "chave de acesso" do grupo (SPECTRA_ACCESS_KEY), que você passa
// para os amigos. Variáveis (configure com `npx wrangler secret put NOME`):
//   CF_APP_ID, CF_APP_TOKEN          app do Realtime SFU (obrigatório)
//   SPECTRA_ACCESS_KEY               chave do grupo (obrigatório)
//   TURN_KEY_ID, TURN_KEY_TOKEN      chave TURN do Realtime (opcional)

import { DurableObject } from 'cloudflare:workers'

const SFU_API = 'https://rtc.live.cloudflare.com/v1'
const ROOM_CODE = /^[A-Z0-9]{4,12}$/
const PEER_ID = /^[a-z0-9]{8,32}$/
const MAX_PEERS = 25

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Spectra-Key',
  'Access-Control-Max-Age': '86400',
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })
const fail = (status, error) => json({ error }, status)

// Rotas do SFU que o app pode usar, com o método de cada uma.
const SFU_ROUTES = [
  ['POST', /^sessions\/new$/],
  ['POST', /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/new$/],
  ['PUT', /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/update$/],
  ['PUT', /^sessions\/[A-Za-z0-9_-]{1,128}\/tracks\/close$/],
  ['PUT', /^sessions\/[A-Za-z0-9_-]{1,128}\/renegotiate$/],
]

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env)
    } catch (ex) {
      console.error(ex)
      return fail(502, 'O servidor não conseguiu completar o pedido. Tente de novo.')
    }
  },
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')

  if (path === '' || path === '/api/health') {
    return json({ ok: true, app: 'spectra', configured: isConfigured(env) })
  }
  if (!path.startsWith('/api/')) return fail(404, 'Não encontrado.')
  if (!isConfigured(env)) return fail(503, 'Servidor sem configuração: faltam CF_APP_ID, CF_APP_TOKEN ou SPECTRA_ACCESS_KEY.')

  // WebSocket da sala: o navegador não envia cabeçalhos próprios no WebSocket,
  // então a chave vem na query (sempre por wss://).
  const ws = path.match(/^\/api\/rooms\/([A-Za-z0-9]{1,16})\/ws$/)
  if (ws) {
    if (request.headers.get('Upgrade') !== 'websocket') return fail(426, 'Use WebSocket.')
    if (!checkKey(env, url.searchParams.get('key'))) return fail(401, 'Chave de acesso incorreta.')
    const code = ws[1].toUpperCase()
    if (!ROOM_CODE.test(code)) return fail(400, 'Código de sala inválido (use de 4 a 12 letras ou números).')
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
    return stub.fetch(request)
  }

  if (!checkKey(env, request.headers.get('X-Spectra-Key'))) return fail(401, 'Chave de acesso incorreta.')

  if (path === '/api/check') return json({ ok: true })

  if (path === '/api/ice') return json({ iceServers: await iceServers(env) })

  if (path.startsWith('/api/sfu/')) {
    const sub = path.slice('/api/sfu/'.length)
    const route = SFU_ROUTES.find(([m, re]) => m === request.method && re.test(sub))
    if (!route) return fail(404, 'Operação do SFU não permitida.')
    const body = request.method === 'POST' || request.method === 'PUT' ? await request.text() : undefined
    if (body && body.length > 256 * 1024) return fail(413, 'Pedido grande demais.')
    const res = await fetch(`${SFU_API}/apps/${env.CF_APP_ID}/${sub}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${env.CF_APP_TOKEN}`, 'Content-Type': 'application/json' },
      body: body || undefined,
    })
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...CORS },
    })
  }

  return fail(404, 'Não encontrado.')
}

function isConfigured(env) {
  return !!(env.CF_APP_ID && env.CF_APP_TOKEN && env.SPECTRA_ACCESS_KEY)
}

function checkKey(env, given) {
  if (typeof given !== 'string' || !env.SPECTRA_ACCESS_KEY) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(env.SPECTRA_ACCESS_KEY)
  if (a.byteLength !== b.byteLength) return false
  return crypto.subtle.timingSafeEqual(a, b)
}

async function iceServers(env) {
  const stun = [{ urls: 'stun:stun.cloudflare.com:3478' }]
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return stun
  try {
    const res = await fetch(`${SFU_API}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    })
    if (!res.ok) return stun
    const { iceServers: list } = await res.json()
    // A porta 53 é bloqueada pelos navegadores e só atrasaria a conexão.
    return (Array.isArray(list) ? list : [list]).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }))
  } catch {
    return stun
  }
}

// ---------------------------------------------------------------------------
// Sala (Durable Object). Usa a API de WebSocket com hibernação: a sala não
// consome nada enquanto ninguém manda mensagem.

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request) {
    const url = new URL(request.url)
    const name = cleanName(url.searchParams.get('name'))
    const id = url.searchParams.get('id') || ''
    if (!name) return fail(400, 'Informe um nome de 1 a 32 caracteres.')
    if (!PEER_ID.test(id)) return fail(400, 'Identificador inválido.')

    // Mesmo id de novo = reconexão (ou a mesma pessoa em outra janela): derruba a antiga.
    const others = this.sockets().filter((s) => s.peer.id !== id)
    for (const s of this.sockets()) {
      if (s.peer.id === id) closeQuietly(s.ws, 4000, 'Você entrou nesta sala em outra janela.')
    }
    if (others.length >= MAX_PEERS) return fail(403, `A sala está cheia (máximo de ${MAX_PEERS} pessoas).`)

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    const peer = { id, name, watching: '', quality: 'high', share: null, joinedAt: Date.now() }
    server.serializeAttachment(peer)

    server.send(JSON.stringify({ t: 'welcome', id, peers: [...others.map((s) => s.peer), peer] }))
    this.broadcast(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg?.t !== 'set') return
    const peer = ws.deserializeAttachment()
    if (!peer) return

    if ('watching' in msg) peer.watching = typeof msg.watching === 'string' && PEER_ID.test(msg.watching) ? msg.watching : ''
    if ('quality' in msg) peer.quality = ['high', 'medium', 'low'].includes(msg.quality) ? msg.quality : 'high'
    if ('share' in msg) peer.share = cleanShare(msg.share)
    ws.serializeAttachment(peer)
    this.broadcast()
  }

  async webSocketClose(ws, code, reason) {
    closeQuietly(ws, code === 1005 ? 1000 : code, reason)
    this.broadcast(null, ws)
  }

  async webSocketError(ws) {
    closeQuietly(ws, 1011, 'erro')
    this.broadcast(null, ws)
  }

  /** Sockets abertos com o participante de cada um. */
  sockets(except) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, peer: ws.deserializeAttachment() }))
      .filter((s) => s.peer)
  }

  /** Manda a lista atualizada para todos (menos `skipSend`, que já recebeu o welcome). */
  broadcast(skipSend = null, gone = null) {
    const list = this.sockets(gone)
    const payload = JSON.stringify({ t: 'peers', peers: list.map((s) => s.peer) })
    for (const { ws } of list) {
      if (ws === skipSend) continue
      try {
        ws.send(payload)
      } catch {
        /* socket fechando */
      }
    }
  }
}

function closeQuietly(ws, code, reason) {
  try {
    ws.close(code, String(reason || '').slice(0, 120))
  } catch {
    /* já fechado */
  }
}

function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return name.length >= 1 && name.length <= 32 ? name : null
}

function cleanShare(s) {
  if (!s || typeof s !== 'object') return null
  const sessionId = typeof s.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s.sessionId) ? s.sessionId : null
  if (!sessionId) return null
  const track = (t) => (typeof t === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : null)
  const video = track(s.video)
  if (!video) return null
  const layers = Array.isArray(s.layers)
    ? s.layers.slice(0, 3).map((l) => ({
        rid: track(l?.rid) || '',
        h: Math.max(0, Math.min(4320, Math.round(Number(l?.h) || 0))),
        fps: Math.max(0, Math.min(240, Math.round(Number(l?.fps) || 0))),
      }))
    : []
  return { sessionId, video, audio: track(s.audio), layers, codec: track(s.codec) }
}
