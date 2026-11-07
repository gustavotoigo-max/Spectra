// Spectra — interface do app (roda dentro do WebView2).
//
// Arquitetura: o transmissor captura a tela e envia UM fluxo (com 3 camadas de
// simulcast) para o Cloudflare Realtime SFU. O SFU replica para cada espectador
// a camada que ele escolheu. Ninguém recebe vídeo de quem não está assistindo:
// o espectador só "puxa" a transmissão de quem escolheu, como no Discord.
//
// O servidor do grupo é um Worker da Cloudflare (pasta server/worker):
//   /api/rooms/CODIGO/ws  WebSocket da sala: quem está, quem transmite, quem assiste quem
//   /api/sfu/...          proxy para a API do SFU (o token secreto fica no Worker)
//   /api/ice              servidores STUN/TURN

import { switchIfNeeded } from './backend.js'

const APP_VERSION = window.spectraHost?.version ?? 'dev'
const REPO = 'gustavotoigo-max/Spectra'


// ---------------------------------------------------------------------------
// Armazenamento local (fica no perfil do WebView2, em %LOCALAPPDATA%\Spectra)

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`spectra.${key}`)
      return raw == null ? fallback : { ...fallback, ...JSON.parse(raw) }
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`spectra.${key}`, JSON.stringify(value))
    } catch {
      /* sem armazenamento: vale só nesta sessão */
    }
  },
}

let settings = store.get('settings', { server: '', accessKey: '', name: '' })
let share = store.get('share', { res: '1080', fps: '60', quality: 'balanced', content: 'motion', codec: 'h264', audio: true })
let viewer = store.get('viewer', { quality: 'high', volume: 1 })
let recent = store.get('recent', { codes: [] })

// ---------------------------------------------------------------------------
// Utilidades de DOM

const $ = (id) => document.getElementById(id)

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style') Object.assign(el.style, v)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`
}

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text)
  $('toasts').append(el)
  setTimeout(() => el.remove(), 4200)
}

const PALETTE = ['#8b5cff', '#4c8dff', '#2fe0c4', '#ff5c7a', '#f0b54a', '#5fa8ff', '#c45cff']
function colorFor(id) {
  let n = 0
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[n % PALETTE.length]
}
function initials(name) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase()
}
function avatar(name, id, small = false) {
  return h('span', { class: `avatar${small ? ' sm' : ''}`, style: { background: colorFor(id) } }, initials(name))
}
function meChip(el) {
  el.replaceChildren(avatar(settings.name || '?', settings.name || '?', true), h('span', {}, settings.name))
}

const mbps = (bps) => `${(bps / 1e6).toFixed(1).replace('.', ',')} Mbps`


// Identificador fixo desta instalação: permite reconectar sem "sumir" da sala.
let identity = store.get('identity', { id: '' })
if (!/^[a-z0-9]{8,32}$/.test(identity.id)) {
  identity = { id: Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('') }
  store.set('identity', identity)
}

// ---------------------------------------------------------------------------
// Plano de transmissão: resolução, bitrate e camadas de simulcast

const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] }
const BASE_KBPS = { 720: 2500, 1080: 4500, 1440: 8000 } // a 30 fps, qualidade "equilibrada"
const QUALITY_MULT = { eco: 0.6, balanced: 1, high: 1.6 }
const QUALITY_NAME = { eco: 'Econômica', balanced: 'Equilibrada', high: 'Alta' }
const CODEC_NAME = { h264: 'H.264', vp9: 'VP9', av1: 'AV1' }
const CODEC_MIME = { h264: 'video/H264', vp9: 'video/VP9', av1: 'video/AV1' }
// Nomes das camadas (RIDs). O SFU ordena "alfabeticamente": a = melhor.
const RIDS = ['a', 'b', 'c']
const QUALITY_RID = { high: 'a', medium: 'b', low: 'c' }

/** Calcula o que vai ser enviado a partir das opções do transmissor. */
function sharePlan(s) {
  const [w, h] = RES[s.res]
  const fps = Number(s.fps)
  const efficient = s.codec === 'vp9' || s.codec === 'av1'
  const fpsMult = fps >= 60 ? 1.5 : 1
  const codecMult = efficient ? 0.7 : 1 // VP9/AV1 entregam a mesma imagem com menos bits
  const maxBitrate = Math.round(BASE_KBPS[s.res] * fpsMult * QUALITY_MULT[s.quality] * codecMult) * 1000

  // da maior para a menor (é a ordem que o espectador vê)
  const midH = h >= 1080 ? 720 : 360
  const lowH = h >= 1080 ? 360 : 180
  const layers = [
    { rid: 'a', h, fps, bitrate: maxBitrate },
    { rid: 'b', h: midH, fps: Math.min(fps, 30), bitrate: Math.round((midH === 720 ? 1_500_000 : 600_000) * codecMult) },
    { rid: 'c', h: lowH, fps: 15, bitrate: Math.round((lowH === 360 ? 400_000 : 150_000) * codecMult) },
  ]
  const upload = layers.reduce((sum, l) => sum + l.bitrate, 0) + (s.audio ? 128_000 : 0)
  return { w, h, fps, maxBitrate, layers, upload }
}

const layerLabel = (l) => `${Math.round(l.h)}p${l.fps}`

// ---------------------------------------------------------------------------
// Servidor

function normalizeServer(raw) {
  let s = raw.trim().replace(/\/+$/, '').replace(/\/api$/, '')
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`
  return s
}

/** Chama o Worker do grupo. Lança Error com a mensagem para mostrar ao usuário. */
async function api(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${settings.server}${path}`, {
      method,
      headers: { 'X-Spectra-Key': settings.accessKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('Não consegui falar com o servidor. Confira o endereço e a sua internet.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 429) throw new Error('Muitas tentativas. Espere um minuto e tente de novo.')
    throw new Error(data.error || data.errorDescription || `O servidor respondeu com erro ${res.status}.`)
  }
  return data
}

// ---------------------------------------------------------------------------
// Cloudflare Realtime SFU (via proxy do Worker)

async function sfu(method, path, body) {
  const data = await api(`/api/sfu/${path}`, { method, body })
  if (data.errorCode) throw new Error(`SFU: ${data.errorDescription || data.errorCode}`)
  const bad = data.tracks?.find((t) => t.errorCode)
  if (bad) throw new Error(`SFU: ${bad.errorDescription || bad.errorCode}`)
  return data
}

function waitConnected(pc, timeoutMs = 15000) {
  if (pc.connectionState === 'connected') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Tempo esgotado ao conectar com o servidor de mídia.')), timeoutMs)
    function check() {
      if (pc.connectionState === 'connected') done()
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') done(new Error('A conexão de mídia falhou.'))
    }
    function done(err) {
      clearTimeout(timer)
      pc.removeEventListener('connectionstatechange', check)
      err ? reject(err) : resolve()
    }
    pc.addEventListener('connectionstatechange', check)
  })
}

/** Cria uma sessão no SFU, ligada a um RTCPeerConnection novo e já conectado. */
async function newSfuSession() {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
  try {
    pc.createDataChannel('server-events') // garante uma oferta inicial válida
    await pc.setLocalDescription(await pc.createOffer())
    const res = await sfu('POST', 'sessions/new', { sessionDescription: pc.localDescription })
    await pc.setRemoteDescription(res.sessionDescription)
    await waitConnected(pc)
    return { pc, sessionId: res.sessionId }
  } catch (ex) {
    pc.close()
    throw ex
  }
}

/** Quando o SFU devolve uma oferta (ao puxar faixas), responde e renegocia. */
async function answerSfuOffer(pc, sessionId, res) {
  if (!res.requiresImmediateRenegotiation) return
  await pc.setRemoteDescription(res.sessionDescription)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(answer.sdp) })
  await sfu('PUT', `sessions/${sessionId}/renegotiate`, { sessionDescription: pc.localDescription })
}

/** Liga o estéreo e 128 kbps no Opus (o padrão do navegador é mono, pensado para voz). */
function opusStereo(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i)?.[1]
  if (!pt) return sdp
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000'
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`)
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (line, params) => (/stereo=1/.test(params) ? line : `a=fmtp:${pt} ${params};${extra}`))
  }
  return sdp.replace(`a=rtpmap:${pt} opus/48000/2`, `a=rtpmap:${pt} opus/48000/2\r\na=fmtp:${pt} ${extra}`)
}

/** Coloca o codec escolhido em primeiro lugar (os outros ficam como reserva). */
function preferCodec(transceiver, codec) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs
  if (!caps || !transceiver.setCodecPreferences) return true
  const want = CODEC_MIME[codec]
  const first = caps.filter((c) => c.mimeType === want)
  if (!first.length) return false
  if (codec === 'h264') first.sort((a, b) => Number(/packetization-mode=1/.test(b.sdpFmtpLine)) - Number(/packetization-mode=1/.test(a.sdpFmtpLine)))
  transceiver.setCodecPreferences([...first, ...caps.filter((c) => c.mimeType !== want)])
  return true
}

// ---------------------------------------------------------------------------
// Limite de tráfego do mês
//
// A Cloudflare dá 1.000 GB por mês de tráfego do SFU (o que sai dela para quem
// assiste). Cada app soma o que recebeu e informa o Worker a cada 30 s; o Worker
// guarda o total do mês e bloqueia o uso ao chegar no limite (900 GB por padrão,
// com folga). Aqui mostramos o aviso, travamos os botões e saímos da sala.

/** @type {{status: 'ok'|'warning'|'blocked', usedBytes: number, limitBytes: number, percent: number, resetsOn: string} | null} */
let usage = null

const gb = (bytes) => (bytes >= 1e12 ? `${(bytes / 1e12).toFixed(2).replace('.', ',')} TB` : `${Math.round(bytes / 1e9)} GB`)
const dateBr = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : iso)

function usageMessage(u) {
  if (u.status === 'blocked') {
    return `O servidor atingiu o limite de tráfego do mês (${gb(u.limitBytes)}). O Spectra fica bloqueado até ${dateBr(u.resetsOn)}.`
  }
  return `Atenção: o servidor já usou ${String(u.percent).replace('.', ',')}% do tráfego do mês (${gb(u.usedBytes)} de ${gb(u.limitBytes)}). Ao chegar no limite, o Spectra fica bloqueado até ${dateBr(u.resetsOn)}.`
}

async function checkUsage() {
  if (!settings.server) return null
  try {
    const res = await fetch(`${settings.server}/api/usage`, { cache: 'no-store' })
    if (res.ok) setUsage(await res.json())
  } catch {
    /* sem conexão: mantém o último estado */
  }
  return usage
}

function setUsage(u) {
  usage = u
  renderUsage()
  if (usage?.status === 'blocked' && inRoom && !leaving) {
    toast(usageMessage(usage), 'error')
    cleanupRoom().then(openHome)
  }
}

function renderUsage() {
  const el = $('usage-banner')
  const blocked = usage?.status === 'blocked'
  $('home-create').disabled = blocked
  $('home-join').disabled = blocked
  if (!usage || usage.status === 'ok') {
    el.hidden = true
    return
  }
  el.className = `usage-banner${blocked ? ' blocked' : ''}`
  el.textContent = usageMessage(usage)
  el.hidden = false
}

// Bytes recebidos do SFU que ainda não foram informados ao Worker.
const countedBytes = new WeakMap() // RTCPeerConnection → bytes já contados
let pendingBytes = 0

async function collectUsage(pc) {
  const stats = await pc.getStats().catch(() => null)
  let transport = 0
  let rtp = 0
  stats?.forEach((r) => {
    if (r.type === 'transport') transport += r.bytesReceived || 0
    else if (r.type === 'inbound-rtp') rtp += (r.bytesReceived || 0) + (r.headerBytesReceived || 0)
  })
  const total = transport || rtp
  const prev = countedBytes.get(pc) || 0
  if (total > prev) {
    pendingBytes += total - prev
    countedBytes.set(pc, total)
  }
}

async function reportUsage() {
  if (sub) await collectUsage(sub.pc)
  if (pendingBytes < 1 || !settings.server) return
  const bytes = pendingBytes
  pendingBytes = 0
  try {
    setUsage(await api('/api/usage/report', { method: 'POST', body: { bytes } }))
  } catch {
    pendingBytes += bytes // tenta de novo na próxima
  }
}

setInterval(reportUsage, 30 * 1000)
setInterval(checkUsage, 5 * 60 * 1000)

// ---------------------------------------------------------------------------
// Tela de configuração

function openSetup(firstRun) {
  $('setup-name').value = settings.name
  $('setup-server').value = settings.server
  $('setup-key').value = settings.accessKey
  $('setup-cancel').hidden = firstRun
  $('setup-error').hidden = true
  showView('setup')
  ;(firstRun || !settings.name ? $('setup-name') : $('setup-server')).focus()
}

$('setup-cancel').addEventListener('click', () => showView('home'))

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const next = {
    name: $('setup-name').value.trim().slice(0, 32),
    server: normalizeServer($('setup-server').value),
    accessKey: $('setup-key').value.trim(),
  }
  const btn = $('setup-submit')
  const err = $('setup-error')
  err.hidden = true
  btn.disabled = true
  btn.textContent = 'Testando…'

  // Servidor de outro tipo (Cloudflare ↔ LiveKit): salva e recarrega com o código certo.
  if (await switchIfNeeded(next.server, () => store.set('settings', next))) return

  const prev = settings
  settings = next
  try {
    await api('/api/check') // valida servidor + chave de uma vez só
    store.set('settings', settings)
    toast('Servidor conectado.', 'ok')
    openHome()
  } catch (ex) {
    settings = prev
    err.textContent = ex.message
    err.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Testar e salvar'
  }
})

// ---------------------------------------------------------------------------
// Início

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('')
}

function openHome() {
  checkUsage()
  meChip($('home-me'))
  renderRecent()
  showView('home')
  $('home-code').focus()
}

function renderRecent() {
  const list = $('home-recent-list')
  list.replaceChildren(...recent.codes.map((c) => h('button', { onclick: () => joinRoom(c) }, c)))
  $('home-recent').hidden = recent.codes.length === 0
}

function rememberRoom(code) {
  recent = { codes: [code, ...recent.codes.filter((c) => c !== code)].slice(0, 6) }
  store.set('recent', recent)
}

$('home-settings').addEventListener('click', () => openSetup(false))
$('home-create').addEventListener('click', () => joinRoom(newCode()))
$('home-join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  if (usage?.status === 'blocked') return toast(usageMessage(usage), 'error')
  const code = $('home-code').value.trim().toUpperCase()
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    toast('O código tem de 4 a 12 letras ou números.', 'error')
    return
  }
  joinRoom(code)
})
$('home-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
})

async function checkForUpdate() {
  if (APP_VERSION === 'dev' || APP_VERSION.includes('-')) return // build de desenvolvimento
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) return
    const { tag_name: tag, html_url: url } = await res.json()
    const latest = String(tag).replace(/^v/, '')
    if (isNewer(latest, APP_VERSION)) {
      const banner = $('update-banner')
      banner.replaceChildren(
        `Nova versão ${latest} disponível.`,
        h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Baixar'),
      )
      banner.hidden = false
    }
  } catch {
    /* sem internet ou limite da API: tenta na próxima abertura */
  }
}
function isNewer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

// ---------------------------------------------------------------------------
// Sala

/** WebSocket da sala (presença) */
let ws = null
let inRoom = false
let roomCode = ''
let leaving = false
let reconnectTries = 0
let reconnectTimer = 0
let pingTimer = 0
/** @type {RTCIceServer[]} */
let iceServers = []
/** participantes da sala, por id: { id, name, watching, quality, share } */
let peers = new Map()
const me = () => identity.id
/** id de quem estou assistindo (pode ser eu mesmo, como prévia) */
let watching = null
/** minha transmissão: { pc, sessionId, stream, video, audio, videoTx, plan, active } */
let myShare = null
/** o que estou recebendo: { pc, sessionId, peerId, share, videoMid, seq } */
let sub = null
let subSeq = 0
let attached = { video: null, audio: null }

async function joinRoom(code) {
  if (inRoom) return
  if (!settings.server || !settings.accessKey || !settings.name) return openSetup(true)
  if (usage?.status === 'blocked') return toast(usageMessage(usage), 'error')

  inRoom = true
  roomCode = code
  leaving = false
  watching = null
  peers = new Map()
  reconnectTries = 0
  $('room-code').textContent = code
  setStatus('Conectando…', '')
  meChip($('room-me'))
  showView('room')
  renderShareSummary()
  renderPeople()
  renderStage()

  try {
    ;({ iceServers } = await api('/api/ice'))
    await openSocket()
    rememberRoom(code)
    restartStatsLoop()
  } catch (ex) {
    console.error(ex)
    toast(ex instanceof Error ? ex.message : 'Não consegui entrar na sala. Confira o servidor.', 'error')
    await cleanupRoom()
    openHome()
  }
}

function socketUrl() {
  const base = settings.server.replace(/^http/i, 'ws')
  const q = new URLSearchParams({ key: settings.accessKey, name: settings.name, id: me() })
  return `${base}/api/rooms/${roomCode}/ws?${q}`
}

/** Abre o WebSocket da sala. Resolve quando o servidor manda a lista inicial. */
function openSocket() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(socketUrl())
    ws = sock
    let welcomed = false

    sock.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.t === 'welcome') {
        welcomed = true
        reconnectTries = 0
        setStatus('Conectado', 'ok')
        onPeers(msg.peers)
        sendMyState()
        resolve()
      } else if (msg.t === 'peers') {
        onPeers(msg.peers)
      }
    }
    sock.onclose = (e) => {
      clearInterval(pingTimer)
      if (ws !== sock) return
      ws = null
      if (!welcomed) return reject(new Error('Não consegui entrar na sala. Confira o servidor e a chave de acesso.'))
      if (leaving) return
      if (e.code === 4000) {
        toast('Você entrou nesta sala em outra janela.', 'error')
        cleanupRoom().then(openHome)
        return
      }
      scheduleReconnect()
    }
    clearInterval(pingTimer)
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), 25000)
  })
}

function scheduleReconnect() {
  if (reconnectTries >= 6) {
    toast('A conexão com a sala caiu.', 'error')
    cleanupRoom().then(openHome)
    return
  }
  setStatus('Reconectando…', 'warn')
  const delay = Math.min(1000 * 2 ** reconnectTries, 15000)
  reconnectTries++
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (leaving || !inRoom) return
    openSocket().catch(() => !leaving && inRoom && scheduleReconnect())
  }, delay)
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'set', ...msg }))
}

/** Manda ao servidor tudo o que os outros precisam saber de mim (usado também ao reconectar). */
function sendMyState() {
  send({
    watching: watching && watching !== me() ? watching : '',
    quality: viewer.quality,
    share: myShare ? shareInfo(myShare) : null,
  })
}

function shareInfo(s) {
  return {
    sessionId: s.sessionId,
    video: 'screen',
    audio: s.audio ? 'audio' : null,
    codec: share.codec,
    layers: s.plan.layers.map((l) => ({ rid: l.rid, h: Math.round(l.h), fps: l.fps })),
  }
}

/** Nova lista de participantes vinda do servidor. */
function onPeers(list) {
  const prev = peers
  peers = new Map((Array.isArray(list) ? list : []).map((p) => [p.id, p]))

  for (const p of peers.values()) {
    if (p.id !== me() && p.share && !prev.get(p.id)?.share) toast(`${p.name} começou a transmitir.`)
  }

  // quem eu assisto parou, saiu ou recomeçou a transmissão
  if (watching && watching !== me()) {
    const p = peers.get(watching)
    if (!p?.share) {
      setWatching(null, false)
    } else if (sub && sub.share.sessionId !== p.share.sessionId) {
      setWatching(p.id)
    }
  }
  pickStream()
  updateDynacast()
  renderPeople()
  renderStage()
}

function setStatus(text, kind) {
  const el = $('room-status')
  el.textContent = text
  el.className = `status-pill ${kind}`
}

async function cleanupRoom() {
  leaving = true
  inRoom = false
  clearTimeout(reconnectTimer)
  clearInterval(pingTimer)
  stopStatsLoop()
  closeSub()
  detachAll()
  if (myShare) await stopShare(true)
  const sock = ws
  ws = null
  try {
    sock?.close(1000, 'saiu')
  } catch {
    /* já fechado */
  }
  peers = new Map()
  watching = null
  closeDrawer()
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
}

$('room-leave').addEventListener('click', async () => {
  await cleanupRoom()
  openHome()
})
$('room-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode)
    const btn = $('room-copy')
    btn.textContent = 'Copiado!'
    btn.classList.add('is-done')
    setTimeout(() => {
      btn.textContent = 'Copiar código'
      btn.classList.remove('is-done')
    }, 1600)
  } catch {
    toast(`Código da sala: ${roomCode}`)
  }
})

// ---- participantes ---------------------------------------------------------

function participants() {
  const mine = peers.get(me()) ?? { id: me(), name: settings.name, watching: '', share: null }
  const others = [...peers.values()].filter((p) => p.id !== me()).sort((a, b) => a.name.localeCompare(b.name))
  return [{ ...mine, share: myShare ? shareInfo(myShare) : null }, ...others]
}
const isSharing = (p) => !!p?.share
const nameOf = (p) => p.name || '?'
const findPeer = (id) => (id === me() ? participants()[0] : peers.get(id))
const viewersOf = (id) => [...peers.values()].filter((o) => o.id !== id && o.watching === id)

function renderPeople() {
  const list = participants()
  $('people-count').textContent = String(list.length || 1)
  const ul = $('people')
  if (!inRoom) {
    ul.replaceChildren()
    return
  }
  ul.replaceChildren(
    ...list.map((p) => {
      const sharing = isSharing(p)
      const isMe = p.id === me()
      const viewers = viewersOf(p.id).length
      const targetP = p.watching ? findPeer(p.watching) : null
      const sub = sharing
        ? viewers ? `${viewers} assistindo` : 'transmitindo'
        : targetP && targetP.id !== p.id
          ? `assistindo ${nameOf(targetP)}`
          : 'na sala'
      return h(
        'li',
        {
          class: `person${sharing ? ' can-watch' : ''}${p.id === watching ? ' is-watched' : ''}`,
          title: sharing ? (isMe ? 'Ver a prévia da sua transmissão' : `Assistir ${nameOf(p)}`) : null,
          onclick: sharing ? () => setWatching(p.id) : null,
        },
        avatar(nameOf(p), p.id),
        h('span', { class: 'person-text' }, h('b', {}, nameOf(p), isMe ? ' (você)' : ''), h('em', {}, sub)),
        sharing ? h('span', { class: 'live-tag' }, 'AO VIVO') : '',
      )
    }),
  )
}

// ---- quem assistir ------------------------------------------------------------

/** Se não estou assistindo ninguém, escolhe a primeira transmissão disponível. */
function pickStream() {
  if (!inRoom) return
  const current = watching ? findPeer(watching) : null
  const remote = participants().slice(1).find(isSharing)
  if (current && isSharing(current) && (current.id !== me() || !remote)) return
  const next = remote ? remote.id : myShare ? me() : null
  if (next !== watching) setWatching(next)
}

function setWatching(id, render = true) {
  if (!inRoom) return
  closeSub()
  detachAll()
  watching = id
  const p = id ? findPeer(id) : null

  if (id === me()) {
    if (myShare) attachTrack(myShare.video, true)
  } else if (p?.share) {
    subscribe(p).catch((ex) => {
      console.error(ex)
      if (watching === p.id) toast(`Não consegui receber a transmissão de ${nameOf(p)}.`, 'error')
    })
  }

  send({ watching: id && id !== me() ? id : '' })
  if (render) {
    renderStage()
    renderPeople()
  }
}

/** Puxa do SFU o vídeo e o áudio de quem transmite. */
async function subscribe(p) {
  const seq = ++subSeq
  const share = p.share
  const { pc, sessionId } = await newSfuSession()
  const stale = () => seq !== subSeq || watching !== p.id
  if (stale()) return pc.close()
  sub = { pc, sessionId, peerId: p.id, share, videoMid: null, seq }

  pc.ontrack = (e) => {
    if (sub?.pc === pc) attachTrack(e.track)
  }
  pc.addEventListener('connectionstatechange', () => {
    if (sub?.pc !== pc || pc.connectionState !== 'failed') return
    toast('A conexão com a transmissão caiu. Tentando de novo…', 'error')
    const target = watching
    setTimeout(() => target && watching === target && setWatching(target), 1500)
  })

  const tracks = [
    {
      location: 'remote',
      sessionId: share.sessionId,
      trackName: share.video,
      simulcast: { preferredRid: QUALITY_RID[viewer.quality], priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' },
    },
  ]
  if (share.audio) tracks.push({ location: 'remote', sessionId: share.sessionId, trackName: share.audio })

  const res = await sfu('POST', `sessions/${sessionId}/tracks/new`, { tracks })
  if (stale()) return pc.close()
  sub.videoMid = res.tracks?.find((t) => t.trackName === share.video)?.mid ?? null
  await answerSfuOffer(pc, sessionId, res)
}

function closeSub() {
  subSeq++
  if (!sub) return
  const { pc } = sub
  sub = null
  // conta o que chegou desde a última medição antes de fechar
  collectUsage(pc).finally(() => pc.close())
}

/** Muda a camada (Máxima/Média/Baixa) que o SFU me manda. */
async function applyViewerQuality() {
  if (!sub?.videoMid) return
  const s = sub
  try {
    const res = await sfu('PUT', `sessions/${s.sessionId}/tracks/update`, {
      tracks: [
        {
          location: 'remote',
          sessionId: s.share.sessionId,
          trackName: s.share.video,
          mid: s.videoMid,
          simulcast: { preferredRid: QUALITY_RID[viewer.quality], priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' },
        },
      ],
    })
    if (sub === s) await answerSfuOffer(s.pc, s.sessionId, res)
  } catch (ex) {
    console.error(ex)
    if (sub === s) setWatching(s.peerId) // assina de novo já com a qualidade nova
  }
}

function attachTrack(track, preview = false) {
  if (track.kind === 'video') {
    $('stage-video').srcObject = new MediaStream([track])
    attached.video = track
    $('stage').classList.add('has-video')
    renderStage()
  } else if (!preview) {
    $('stage-audio').srcObject = new MediaStream([track])
    $('stage-audio').volume = viewer.volume
    $('stage-audio').play().catch(() => {})
    attached.audio = track
  }
}
function detachAll() {
  attached = { video: null, audio: null }
  $('stage-video').srcObject = null
  $('stage-audio').srcObject = null
  $('stage').classList.remove('has-video')
}

// ---- palco ---------------------------------------------------------------------

function watchedLayers() {
  const layers = (watching ? findPeer(watching) : null)?.share?.layers
  return Array.isArray(layers) && layers.length ? layers : null
}

function renderStage() {
  const p = watching ? findPeer(watching) : null
  const isMe = p?.id === me()
  const live = !!p
  $('stage-top').hidden = !live
  $('stage-controls').hidden = !live
  $('stage-empty').hidden = live && !!attached.video
  if (!live) {
    const sharers = participants().filter(isSharing)
    $('stage-empty-title').textContent = sharers.length ? 'Escolha quem assistir' : 'Ninguém está transmitindo'
    $('stage-empty-hint').textContent = sharers.length
      ? 'Clique em quem está AO VIVO na lista ao lado.'
      : 'Clique em “Transmitir tela” para começar, ou espere alguém compartilhar.'
    $('stage-stats').textContent = ''
    return
  }
  if (!attached.video) {
    $('stage-empty-title').textContent = 'Carregando a transmissão…'
    $('stage-empty-hint').textContent = `Conectando ao vídeo de ${nameOf(p)}.`
  }
  $('stage-who').textContent = isMe ? 'Sua transmissão (prévia)' : nameOf(p)
  $('ctl-quality-wrap').hidden = isMe
  $('ctl-volume-wrap').hidden = isMe

  // opções de qualidade a partir das camadas que o transmissor anunciou
  const layers = watchedLayers()
  const names = ['Máxima', 'Média', 'Baixa']
  const keys = ['high', 'medium', 'low']
  const select = $('ctl-quality')
  select.replaceChildren(
    ...keys.map((k, i) => h('option', { value: k }, layers?.[i] ? `${names[i]} · ${layerLabel(layers[i])}` : names[i])),
  )
  select.value = viewer.quality
}

$('ctl-quality').addEventListener('change', (e) => {
  viewer = { ...viewer, quality: e.target.value }
  store.set('viewer', viewer)
  send({ quality: viewer.quality })
  applyViewerQuality()
})

$('ctl-volume').value = String(viewer.volume)
$('ctl-volume').addEventListener('input', (e) => {
  viewer = { ...viewer, volume: Number(e.target.value) }
  $('stage-audio').volume = viewer.volume
  store.set('viewer', viewer)
})

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else if (watching) $('stage').requestFullscreen().catch(() => {})
}
$('ctl-fullscreen').addEventListener('click', toggleFullscreen)
$('stage').addEventListener('dblclick', toggleFullscreen)

// Esconde controles e cursor quando o mouse fica parado sobre o vídeo.
let idleTimer = 0
$('stage').addEventListener('mousemove', () => {
  $('stage').classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (attached.video && !$('stage-controls').matches(':hover')) $('stage').classList.add('idle')
  }, 2500)
})
$('stage').addEventListener('mouseleave', () => $('stage').classList.remove('idle'))

// ---- estatísticas ------------------------------------------------------------------

let statsTimer = 0
let lastRecv = null
let lastSent = null

function stopStatsLoop() {
  clearInterval(statsTimer)
  statsTimer = 0
  lastRecv = null
  lastSent = null
}
function restartStatsLoop() {
  stopStatsLoop()
  if (!inRoom) return
  statsTimer = setInterval(updateStats, 1000)
}

async function updateStats() {
  const now = performance.now()

  // o que estou recebendo
  if (sub && watching !== me()) {
    const stats = await sub.pc.getStats().catch(() => null)
    let video = null
    let bytes = 0
    stats?.forEach((r) => {
      if (r.type !== 'inbound-rtp') return
      bytes += r.bytesReceived || 0
      if (r.kind === 'video') video = r
    })
    if (video) {
      const rate = lastRecv ? ((bytes - lastRecv.bytes) * 8000) / (now - lastRecv.t) : 0
      lastRecv = { bytes, t: now }
      const res = video.frameWidth ? `${video.frameWidth}×${video.frameHeight}` : '—'
      $('stage-stats').textContent = `${res} · ${Math.round(video.framesPerSecond || 0)} fps · ${mbps(Math.max(0, rate))}`
    }
  } else if (myShare && watching === me()) {
    $('stage-stats').textContent = 'Prévia local'
  }

  // o que estou enviando
  if (myShare) {
    const stats = await myShare.pc.getStats().catch(() => null)
    let top = null
    let bytes = 0
    stats?.forEach((r) => {
      if (r.type !== 'outbound-rtp') return
      bytes += r.bytesSent || 0
      if (r.kind === 'video' && (r.frameWidth || 0) >= (top?.frameWidth || 0)) top = r
    })
    const sent = lastSent ? ((bytes - lastSent.bytes) * 8000) / (now - lastSent.t) : 0
    lastSent = { bytes, t: now }
    const viewers = viewersOf(me()).length
    const parts = [
      top?.frameWidth ? `${top.frameWidth}×${top.frameHeight}` : null,
      top?.framesPerSecond ? `${Math.round(top.framesPerSecond)} fps` : null,
      `${mbps(Math.max(0, sent))} enviados`,
      `${viewers} assistindo`,
    ].filter(Boolean)
    const subEl = $('dock-sub')
    const reason = top?.qualityLimitationReason
    if (reason === 'cpu') {
      subEl.textContent = `${parts.join(' · ')} — limitado pelo processador: tente 30 fps ou H.264`
      subEl.className = 'hint warn'
    } else if (reason === 'bandwidth') {
      subEl.textContent = `${parts.join(' · ')} — limitado pela sua internet: reduza a qualidade`
      subEl.className = 'hint warn'
    } else {
      subEl.textContent = parts.join(' · ')
      subEl.className = 'hint'
    }
  }
}

// ---------------------------------------------------------------------------
// Transmitir

function renderShareSummary() {
  const plan = sharePlan(share)
  $('share-summary').textContent = `${share.res}p · ${share.fps} fps · ${CODEC_NAME[share.codec]}`
  for (const fs of document.querySelectorAll('.seg')) {
    const key = fs.dataset.key
    for (const b of fs.querySelectorAll('button')) b.classList.toggle('is-active', b.dataset.val === String(share[key]))
  }
  $('opt-audio').checked = !!share.audio
  $('drawer-summary').replaceChildren(
    h('span', {}, 'Imagem principal: ', h('b', {}, `${plan.w}×${plan.h} a ${plan.fps} fps, até ${mbps(plan.maxBitrate)}`)),
    h('span', {}, 'Opções para quem assiste: ', h('b', {}, plan.layers.map(layerLabel).join(', '))),
    h('span', {}, 'Seu upload estimado: ', h('b', {}, mbps(plan.upload))),
    h('span', {}, `Qualidade ${QUALITY_NAME[share.quality].toLowerCase()} · áudio ${share.audio ? 'estéreo 128 kbps' : 'desligado'}`),
  )
  if (!myShare) {
    $('dock-title').replaceChildren('Pronto para transmitir')
    $('dock-sub').textContent = `Upload estimado: ${mbps(plan.upload)}`
    $('dock-sub').className = 'hint'
  }
}

for (const fs of document.querySelectorAll('.seg')) {
  fs.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn || myShare) return
    share = { ...share, [fs.dataset.key]: btn.dataset.val }
    store.set('share', share)
    renderShareSummary()
  })
}
$('opt-audio').addEventListener('change', (e) => {
  if (myShare) return
  share = { ...share, audio: e.target.checked }
  store.set('share', share)
  renderShareSummary()
})

function openDrawer() {
  $('share-drawer').hidden = false
  $('drawer-backdrop').hidden = false
  $('share-drawer').classList.toggle('locked', !!myShare)
  $('drawer-lock').hidden = !myShare
}
function closeDrawer() {
  $('share-drawer').hidden = true
  $('drawer-backdrop').hidden = true
}
$('share-settings-btn').addEventListener('click', openDrawer)
$('drawer-close').addEventListener('click', closeDrawer)
$('drawer-backdrop').addEventListener('click', closeDrawer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer()
})

$('share-btn').addEventListener('click', () => (myShare ? stopShare() : startShare()))

async function startShare() {
  if (!inRoom || myShare) return
  const plan = sharePlan(share)
  const btn = $('share-btn')
  btn.disabled = true

  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: plan.w },
        height: { max: plan.h },
        frameRate: { ideal: plan.fps, max: plan.fps },
        displaySurface: 'monitor',
      },
      audio: share.audio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
        : false,
      systemAudio: share.audio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    })
  } catch (ex) {
    btn.disabled = false
    if (ex?.name !== 'NotAllowedError' && ex?.name !== 'AbortError') toast('Não consegui capturar a tela.', 'error')
    return
  }

  const [video] = stream.getVideoTracks()
  const [audio] = stream.getAudioTracks()
  video.contentHint = share.content === 'detail' ? 'detail' : 'motion'

  let pc = null
  try {
    const session = await newSfuSession()
    pc = session.pc

    // Simulcast: 3 versões da mesma imagem; o SFU manda a cada um a que ele escolheu.
    const srcH = video.getSettings().height || plan.h
    const efficient = share.codec === 'vp9' || share.codec === 'av1'
    const videoTx = pc.addTransceiver(video, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: plan.layers.map((l) => ({
        rid: l.rid,
        active: true,
        maxBitrate: l.bitrate,
        maxFramerate: l.fps,
        scaleResolutionDownBy: Math.max(1, srcH / l.h),
        ...(efficient ? { scalabilityMode: 'L1T3' } : {}),
        priority: 'high',
        networkPriority: 'high',
      })),
    })
    if (!preferCodec(videoTx, share.codec)) toast(`${CODEC_NAME[share.codec]} não está disponível aqui; usando outro codec.`)

    const audioTx = audio
      ? pc.addTransceiver(audio, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: 128_000 }] })
      : null

    const offer = await pc.createOffer()
    await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp) })
    const tracks = [{ location: 'local', mid: videoTx.mid, trackName: 'screen' }]
    if (audioTx) tracks.push({ location: 'local', mid: audioTx.mid, trackName: 'audio' })
    const res = await sfu('POST', `sessions/${session.sessionId}/tracks/new`, {
      sessionDescription: pc.localDescription,
      tracks,
    })
    await pc.setRemoteDescription({ type: 'answer', sdp: opusStereo(res.sessionDescription.sdp) })

    try {
      const params = videoTx.sender.getParameters()
      params.degradationPreference = share.content === 'detail' ? 'maintain-resolution' : 'maintain-framerate'
      await videoTx.sender.setParameters(params)
    } catch {
      /* navegador sem suporte: segue com o padrão */
    }

    if (!audio && share.audio) toast('Transmitindo sem áudio: marque “Compartilhar áudio do sistema” no seletor.', '')

    myShare = { pc, sessionId: session.sessionId, stream, video, audio, videoTx, plan, active: true }
    video.addEventListener('ended', () => stopShare()) // "Parar de compartilhar" do Windows/Chromium
    pc.addEventListener('connectionstatechange', () => {
      if (myShare?.pc === pc && pc.connectionState === 'failed') {
        toast('A transmissão caiu.', 'error')
        stopShare(true)
      }
    })

    send({ share: shareInfo(myShare) })
    updateDynacast()

    btn.classList.replace('btn-primary', 'btn-danger')
    $('share-btn-label').textContent = 'Parar transmissão'
    $('dock-title').replaceChildren(h('span', { class: 'live-tag' }, 'AO VIVO'), 'Você está transmitindo')
    $('dock-sub').textContent = 'Iniciando…'
    if (!watching) setWatching(me())
    restartStatsLoop()
    renderPeople()
  } catch (ex) {
    console.error(ex)
    pc?.close()
    stream.getTracks().forEach((t) => t.stop())
    toast(ex instanceof Error && ex.message.startsWith('SFU') ? `Não consegui iniciar a transmissão (${ex.message}).` : 'Não consegui iniciar a transmissão.', 'error')
  } finally {
    btn.disabled = false
  }
}

/**
 * Sem ninguém assistindo, só a camada mais baixa continua (o SFU descarta faixas
 * paradas por mais de 30 s). Com espectadores, todas as camadas voltam.
 */
async function updateDynacast() {
  const s = myShare
  if (!s) return
  const want = viewersOf(me()).length > 0
  if (want === s.active) return
  s.active = want
  try {
    const params = s.videoTx.sender.getParameters()
    for (const enc of params.encodings ?? []) enc.active = want || enc.rid === RIDS.at(-1)
    await s.videoTx.sender.setParameters(params)
  } catch (ex) {
    console.warn('dynacast', ex)
  }
}

async function stopShare(silent = false) {
  const s = myShare
  if (!s) return
  myShare = null
  if (watching === me()) setWatching(null)
  send({ share: null })
  s.pc.close()
  s.stream.getTracks().forEach((t) => t.stop())

  const btn = $('share-btn')
  btn.classList.replace('btn-danger', 'btn-primary')
  $('share-btn-label').textContent = 'Transmitir tela'
  renderShareSummary()
  closeDrawer()
  if (inRoom) {
    pickStream()
    renderPeople()
  }
  if (!silent) toast('Transmissão encerrada.')
}

// ---------------------------------------------------------------------------
// Início do app

window.addEventListener('beforeunload', () => {
  try {
    ws?.close(1000, 'saiu')
  } catch {
    /* nada a fazer */
  }
})

if (!settings.server || !settings.accessKey || !settings.name) openSetup(true)
else openHome()
checkForUpdate()

// para depuração no console (F12)
window.spectra = {
  get peers() {
    return peers
  },
  get share() {
    return myShare
  },
  get sub() {
    return sub
  },
  sharePlan,
  version: APP_VERSION,
}
