// Spectra — interface do app (roda dentro do WebView2).
//
// Arquitetura: o transmissor captura a tela e envia UM fluxo (com camadas de
// simulcast) para o servidor LiveKit (SFU). O servidor replica para cada
// espectador a camada que ele escolheu. Ninguém recebe vídeo de quem não está
// assistindo: a inscrição é manual (autoSubscribe: false), como no Discord.

import { switchIfNeeded } from './backend.js'

const L = window.LivekitClient
const { Room, RoomEvent, Track, VideoPreset, VideoQuality, AudioPresets, ConnectionState, DisconnectReason } = L

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

// ---------------------------------------------------------------------------
// Plano de transmissão: resolução, bitrate e camadas de simulcast

const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] }
const BASE_KBPS = { 720: 2500, 1080: 4500, 1440: 8000 } // a 30 fps, qualidade "equilibrada"
const QUALITY_MULT = { eco: 0.6, balanced: 1, high: 1.6 }
const QUALITY_NAME = { eco: 'Econômica', balanced: 'Equilibrada', high: 'Alta' }
const CODEC_NAME = { h264: 'H.264', vp9: 'VP9', av1: 'AV1' }

/** Calcula o que vai ser enviado a partir das opções do transmissor. */
function sharePlan(s) {
  const [w, h] = RES[s.res]
  const fps = Number(s.fps)
  const svc = s.codec === 'vp9' || s.codec === 'av1'
  const fpsMult = fps >= 60 ? 1.5 : 1
  const codecMult = svc ? 0.7 : 1 // VP9/AV1 entregam a mesma imagem com menos bits
  const maxBitrate = Math.round(BASE_KBPS[s.res] * fpsMult * QUALITY_MULT[s.quality] * codecMult) * 1000

  let layers // da maior para a menor (é a ordem que o espectador vê)
  if (svc) {
    // SVC: uma única transmissão com camadas espaciais 1/1, 1/2 e 1/4.
    layers = [
      { h, fps, bitrate: maxBitrate },
      { h: h / 2, fps, bitrate: 0 },
      { h: h / 4, fps, bitrate: 0 },
    ]
  } else {
    const midH = h >= 1080 ? 720 : 360
    const lowH = h >= 1080 ? 360 : 180
    layers = [
      { h, fps, bitrate: maxBitrate },
      { h: midH, fps: Math.min(fps, 30), bitrate: midH === 720 ? 1_500_000 : 600_000 },
      { h: lowH, fps: 15, bitrate: lowH === 360 ? 400_000 : 150_000 },
    ]
  }
  const upload = (svc ? maxBitrate : layers.reduce((sum, l) => sum + l.bitrate, 0)) + (s.audio ? 128_000 : 0)
  return { w, h, fps, svc, maxBitrate, layers, upload }
}

const layerLabel = (l) => `${Math.round(l.h)}p${l.fps}`

// ---------------------------------------------------------------------------
// Servidor

function normalizeServer(raw) {
  let s = raw.trim().replace(/\/+$/, '').replace(/\/api$/, '')
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`
  return s
}

async function requestToken(room) {
  let res
  try {
    res = await fetch(`${settings.server}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, name: settings.name, accessKey: settings.accessKey }),
    })
  } catch {
    throw new Error('Não consegui falar com o servidor. Confira o endereço e a sua internet.')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 429) throw new Error('Muitas tentativas. Espere um minuto e tente de novo.')
    throw new Error(body.error || `O servidor respondeu com erro ${res.status}.`)
  }
  return body // { token, url, identity, room }
}

// ---------------------------------------------------------------------------
// Limite de tráfego do servidor (Oracle Always Free)
//
// O servidor mede o tráfego de saída do mês e bloqueia o uso ao atingir o limite
// (5 TB por padrão). Aqui só mostramos o aviso e travamos os botões.

/** @type {{status: 'ok'|'warning'|'blocked', usedBytes: number, limitBytes: number, percent: number, resetsOn: string} | null} */
let usage = null

const tb = (bytes) => `${(bytes / 1e12).toFixed(2).replace('.', ',')} TB`
const dateBr = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : iso)

function usageMessage(u) {
  if (u.status === 'blocked') {
    return `O servidor atingiu o limite de tráfego do mês (${tb(u.limitBytes)}). O Spectra fica bloqueado até ${dateBr(u.resetsOn)}.`
  }
  return `Atenção: o servidor já usou ${String(u.percent).replace('.', ',')}% do tráfego do mês (${tb(u.usedBytes)} de ${tb(u.limitBytes)}). Ao chegar no limite, o Spectra fica bloqueado até ${dateBr(u.resetsOn)}.`
}

async function checkUsage() {
  if (!settings.server) return null
  try {
    const res = await fetch(`${settings.server}/api/usage`, { cache: 'no-store' })
    if (res.ok) usage = await res.json()
  } catch {
    /* sem conexão: mantém o último estado */
  }
  renderUsage()
  return usage
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
    await requestToken('PING') // valida servidor + chave de uma vez só
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

/** @type {import('livekit-client').Room | null} */
let room = null
let roomCode = ''
let leaving = false
/** identidade de quem estou assistindo (pode ser eu mesmo, como prévia) */
let watching = null
/** minha transmissão */
let myShare = null // { videoPub, audioPub, plan }
let attached = { video: null, audio: null }

async function joinRoom(code) {
  if (room) return
  if (!settings.server || !settings.accessKey || !settings.name) return openSetup(true)
  if (usage?.status === 'blocked') return toast(usageMessage(usage), 'error')

  roomCode = code
  leaving = false
  watching = null
  $('room-code').textContent = code
  setStatus('Conectando…', '')
  meChip($('room-me'))
  showView('room')
  renderShareSummary()
  renderPeople()
  renderStage()

  try {
    const { token, url } = await requestToken(code)
    room = new Room({
      adaptiveStream: false, // a qualidade é escolhida pelo espectador
      dynacast: true, // camadas que ninguém está vendo param de ser codificadas
      disconnectOnPageLeave: true,
    })
    wireRoom(room)
    await room.connect(url, token, { autoSubscribe: false })
    room.startAudio().catch(() => {})
    rememberRoom(code)
    setStatus('Conectado', 'ok')
    pickStream()
    renderPeople()
  } catch (ex) {
    console.error(ex)
    const msg = ex instanceof Error && !/^could not|websocket|signal/i.test(ex.message) ? ex.message : 'Não consegui entrar na sala. Confira o servidor.'
    toast(msg, 'error')
    await cleanupRoom()
    openHome()
  }
}

function wireRoom(r) {
  r.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state === ConnectionState.Connected) setStatus('Conectado', 'ok')
    else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) setStatus('Reconectando…', 'warn')
  })
  r.on(RoomEvent.Disconnected, async (reason) => {
    if (leaving) return
    if (reason === DisconnectReason.ROOM_DELETED && (await checkUsage())?.status === 'blocked') {
      toast(usageMessage(usage), 'error')
      await cleanupRoom()
      openHome()
      return
    }
    const msg =
      reason === DisconnectReason.DUPLICATE_IDENTITY
        ? 'Você entrou nesta sala em outra janela.'
        : reason === DisconnectReason.PARTICIPANT_REMOVED
          ? 'Você foi removido da sala.'
          : 'A conexão com a sala caiu.'
    toast(msg, 'error')
    await cleanupRoom()
    openHome()
  })

  r.on(RoomEvent.ParticipantConnected, renderPeople)
  r.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity === watching) setWatching(null)
    pickStream()
    renderPeople()
  })
  r.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
    renderPeople()
    if (p.identity === watching) renderStage()
  })

  r.on(RoomEvent.TrackPublished, (pub, p) => {
    if (p.identity === watching) pub.setSubscribed(true)
    if (pub.source === Track.Source.ScreenShare) {
      pickStream()
      toast(`${p.name || p.identity} começou a transmitir.`)
    }
    renderPeople()
  })
  r.on(RoomEvent.TrackUnpublished, (pub, p) => {
    if (pub.source === Track.Source.ScreenShare && p.identity === watching) {
      setWatching(null)
      pickStream()
    }
    renderPeople()
  })
  r.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    if (p.identity !== watching) return
    attachTrack(track)
    if (track.kind === Track.Kind.Video) applyViewerQuality()
  })
  r.on(RoomEvent.TrackUnsubscribed, (track) => detachTrack(track))
  r.on(RoomEvent.TrackSubscriptionFailed, (_sid, p) => {
    toast(`Não consegui receber a transmissão de ${p.name || p.identity}.`, 'error')
  })
  r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    if (pub.source === Track.Source.ScreenShare && myShare) stopShare()
  })
}

function setStatus(text, kind) {
  const el = $('room-status')
  el.textContent = text
  el.className = `status-pill ${kind}`
}

async function cleanupRoom() {
  leaving = true
  stopStatsLoop()
  detachAll()
  if (myShare) await stopShare(true)
  const r = room
  room = null
  watching = null
  if (r) await r.disconnect().catch(() => {})
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
  if (!room) return []
  const remotes = [...room.remoteParticipants.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return [room.localParticipant, ...remotes]
}
const isSharing = (p) => !!p.getTrackPublication(Track.Source.ScreenShare)
const nameOf = (p) => p.name || p.identity
const findParticipant = (identity) =>
  !room ? null : identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity)

function renderPeople() {
  const list = participants()
  $('people-count').textContent = String(list.length || 1)
  const ul = $('people')
  if (!room) {
    ul.replaceChildren()
    return
  }
  const me = room.localParticipant.identity
  ul.replaceChildren(
    ...list.map((p) => {
      const sharing = isSharing(p)
      const isMe = p.identity === me
      const viewers = list.filter((o) => o.identity !== p.identity && o.attributes['spectra.watching'] === p.identity).length
      const target = p.attributes['spectra.watching']
      const targetP = target ? findParticipant(target) : null
      const sub = sharing
        ? viewers ? `${viewers} assistindo` : 'transmitindo'
        : targetP && targetP.identity !== p.identity
          ? `assistindo ${nameOf(targetP)}`
          : 'na sala'
      return h(
        'li',
        {
          class: `person${sharing ? ' can-watch' : ''}${p.identity === watching ? ' is-watched' : ''}`,
          title: sharing ? (isMe ? 'Ver a prévia da sua transmissão' : `Assistir ${nameOf(p)}`) : null,
          onclick: sharing ? () => setWatching(p.identity) : null,
        },
        avatar(nameOf(p), p.identity),
        h('span', { class: 'person-text' }, h('b', {}, nameOf(p), isMe ? ' (você)' : ''), h('em', {}, sub)),
        sharing ? h('span', { class: 'live-tag' }, 'AO VIVO') : '',
      )
    }),
  )
}

// ---- quem assistir ------------------------------------------------------------

/** Se não estou assistindo ninguém, escolhe a primeira transmissão disponível. */
function pickStream() {
  if (!room) return
  const current = watching ? findParticipant(watching) : null
  const remote = [...room.remoteParticipants.values()].find(isSharing)
  if (current && isSharing(current) && (current !== room.localParticipant || !remote)) return
  setWatching(remote ? remote.identity : myShare ? room.localParticipant.identity : null)
}

function setWatching(identity) {
  if (!room) return
  const prev = watching ? findParticipant(watching) : null
  if (prev && prev !== room.localParticipant) {
    for (const pub of prev.trackPublications.values()) pub.setSubscribed(false)
  }
  detachAll()
  watching = identity
  const p = identity ? findParticipant(identity) : null

  if (p === room.localParticipant) {
    const track = myShare?.videoPub?.track
    if (track) attachTrack(track)
  } else if (p) {
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
        pub.setSubscribed(true)
        if (pub.track) attachTrack(pub.track)
      }
    }
    applyViewerQuality()
  }

  const watchingOther = identity && identity !== room.localParticipant.identity ? identity : ''
  room.localParticipant.setAttributes({ 'spectra.watching': watchingOther }).catch(() => {})
  renderStage()
  renderPeople()
  restartStatsLoop()
}

function attachTrack(track) {
  if (track.kind === Track.Kind.Video) {
    track.attach($('stage-video'))
    attached.video = track
    $('stage').classList.add('has-video')
    renderStage()
  } else {
    track.attach($('stage-audio'))
    attached.audio = track
    track.setVolume?.(viewer.volume)
  }
}
function detachTrack(track) {
  if (attached.video === track) {
    track.detach($('stage-video'))
    attached.video = null
    $('stage').classList.remove('has-video')
    renderStage()
  }
  if (attached.audio === track) {
    track.detach($('stage-audio'))
    attached.audio = null
  }
}
function detachAll() {
  if (attached.video) detachTrack(attached.video)
  if (attached.audio) detachTrack(attached.audio)
  $('stage-video').srcObject = null
}

// ---- palco ---------------------------------------------------------------------

function watchedLayers() {
  const p = watching ? findParticipant(watching) : null
  try {
    const layers = JSON.parse(p?.attributes['spectra.layers'] || '[]')
    return Array.isArray(layers) && layers.length ? layers : null
  } catch {
    return null
  }
}

function renderStage() {
  const p = watching ? findParticipant(watching) : null
  const isMe = room && p === room.localParticipant
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

function applyViewerQuality() {
  const p = watching ? findParticipant(watching) : null
  if (!p || !room || p === room.localParticipant) return
  const pub = p.getTrackPublication(Track.Source.ScreenShare)
  const q = { high: VideoQuality.HIGH, medium: VideoQuality.MEDIUM, low: VideoQuality.LOW }[viewer.quality]
  pub?.setVideoQuality?.(q)
}

$('ctl-quality').addEventListener('change', (e) => {
  viewer = { ...viewer, quality: e.target.value }
  store.set('viewer', viewer)
  applyViewerQuality()
})

$('ctl-volume').value = String(viewer.volume)
$('ctl-volume').addEventListener('input', (e) => {
  viewer = { ...viewer, volume: Number(e.target.value) }
  attached.audio?.setVolume?.(viewer.volume)
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

function stopStatsLoop() {
  clearInterval(statsTimer)
  statsTimer = 0
  lastRecv = null
}
function restartStatsLoop() {
  stopStatsLoop()
  if (!room) return
  statsTimer = setInterval(updateStats, 1000)
}

async function updateStats() {
  // o que estou recebendo
  const v = attached.video
  if (v && v !== myShare?.videoPub?.track && v.getReceiverStats) {
    const s = await v.getReceiverStats().catch(() => null)
    if (s) {
      const now = performance.now()
      const fps = lastRecv ? ((s.framesDecoded - lastRecv.frames) * 1000) / (now - lastRecv.t) : 0
      lastRecv = { frames: s.framesDecoded, t: now }
      const res = s.frameWidth ? `${s.frameWidth}×${s.frameHeight}` : '—'
      $('stage-stats').textContent = `${res} · ${Math.round(fps)} fps · ${mbps(v.currentBitrate || 0)}`
    }
  } else if (myShare && v) {
    $('stage-stats').textContent = 'Prévia local'
  }

  // o que estou enviando
  if (myShare?.videoPub?.track) {
    const t = myShare.videoPub.track
    const layers = await t.getSenderStats().catch(() => [])
    const top = layers.reduce((a, b) => ((b.frameWidth || 0) > (a?.frameWidth || 0) ? b : a), null)
    const viewers = participants().filter((p) => p.attributes['spectra.watching'] === room?.localParticipant.identity).length
    const sent = (t.currentBitrate || 0) + (myShare.audioPub?.track?.currentBitrate || 0)
    const parts = [
      top?.frameWidth ? `${top.frameWidth}×${top.frameHeight}` : null,
      top?.framesPerSecond ? `${Math.round(top.framesPerSecond)} fps` : null,
      `${mbps(sent)} enviados`,
      `${viewers} assistindo`,
    ].filter(Boolean)
    const sub = $('dock-sub')
    const reason = top?.qualityLimitationReason
    if (reason === 'cpu') {
      sub.textContent = `${parts.join(' · ')} — limitado pelo processador: tente 30 fps ou H.264`
      sub.className = 'hint warn'
    } else if (reason === 'bandwidth') {
      sub.textContent = `${parts.join(' · ')} — limitado pela sua internet: reduza a qualidade`
      sub.className = 'hint warn'
    } else {
      sub.textContent = parts.join(' · ')
      sub.className = 'hint'
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
  if (!room || myShare) return
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

  try {
    const lp = room.localParticipant
    const lowToHigh = plan.layers.slice(1).reverse()
    const videoPub = await lp.publishTrack(video, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      videoCodec: share.codec,
      simulcast: !plan.svc,
      scalabilityMode: plan.svc ? 'L3T3_KEY' : undefined,
      backupCodec: plan.svc ? { codec: 'vp8' } : false,
      screenShareEncoding: { maxBitrate: plan.maxBitrate, maxFramerate: plan.fps, priority: 'high' },
      screenShareSimulcastLayers: plan.svc
        ? undefined
        : lowToHigh.map((l) => new VideoPreset(Math.round((l.h * 16) / 9), l.h, l.bitrate, l.fps, 'medium')),
      degradationPreference: share.content === 'detail' ? 'maintain-resolution' : 'maintain-framerate',
    })

    let audioPub = null
    if (audio) {
      audioPub = await lp.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        name: 'screen-audio',
        audioPreset: AudioPresets.musicHighQualityStereo,
        forceStereo: true,
        dtx: false,
        red: false,
      })
    } else if (share.audio) {
      toast('Transmitindo sem áudio: marque “Compartilhar áudio do sistema” no seletor.', '')
    }

    myShare = { videoPub, audioPub, plan, stream }
    video.addEventListener('ended', () => stopShare()) // "Parar de compartilhar" do Windows/Chromium

    await lp.setAttributes({
      'spectra.layers': JSON.stringify(plan.layers.map((l) => ({ h: Math.round(l.h), fps: l.fps }))),
    })

    btn.classList.replace('btn-primary', 'btn-danger')
    $('share-btn-label').textContent = 'Parar transmissão'
    $('dock-title').replaceChildren(h('span', { class: 'live-tag' }, 'AO VIVO'), 'Você está transmitindo')
    $('dock-sub').textContent = 'Iniciando…'
    if (!watching) setWatching(lp.identity)
    restartStatsLoop()
    renderPeople()
  } catch (ex) {
    console.error(ex)
    stream.getTracks().forEach((t) => t.stop())
    toast('Não consegui iniciar a transmissão.', 'error')
  } finally {
    btn.disabled = false
  }
}

async function stopShare(silent = false) {
  const s = myShare
  if (!s) return
  myShare = null
  const lp = room?.localParticipant
  if (watching && lp && watching === lp.identity) setWatching(null)
  try {
    if (lp) {
      if (s.videoPub?.track) await lp.unpublishTrack(s.videoPub.track, true)
      if (s.audioPub?.track) await lp.unpublishTrack(s.audioPub.track, true)
      await lp.setAttributes({ 'spectra.layers': '' })
    }
  } catch {
    /* sala já desconectada */
  }
  s.stream.getTracks().forEach((t) => t.stop())

  const btn = $('share-btn')
  btn.classList.replace('btn-danger', 'btn-primary')
  $('share-btn-label').textContent = 'Transmitir tela'
  renderShareSummary()
  closeDrawer()
  if (room) {
    pickStream()
    renderPeople()
  }
  if (!silent) toast('Transmissão encerrada.')
}

// ---------------------------------------------------------------------------
// Início do app

window.addEventListener('beforeunload', () => {
  room?.disconnect()
})

if (!settings.server || !settings.accessKey || !settings.name) openSetup(true)
else openHome()
checkForUpdate()

// para depuração no console (F12)
window.spectra = { get room() { return room }, sharePlan, version: APP_VERSION }
