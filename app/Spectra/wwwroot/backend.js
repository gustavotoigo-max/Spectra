// Spectra — descobre qual tipo de servidor o grupo usa.
//
// O app funciona com dois servidores:
//   cloudflare  Worker na Cloudflare (pasta server/worker) + Cloudflare Realtime SFU
//   livekit     LiveKit próprio numa VM (pasta server, ex.: Oracle Always Free)
// Os dois respondem em /api/health; o Worker diz "backend": "cloudflare".

const KEY = 'spectra.backend'

/** Tipo do servidor em `server`, ou null se não deu para descobrir (sem internet, endereço errado). */
export async function detectBackend(server) {
  if (!server) return null
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${server}/api/health`, { cache: 'no-store', signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    if (data?.backend === 'cloudflare') return 'cloudflare'
    if (data?.status === 'ok') return 'livekit'
  } catch {
    /* sem resposta */
  }
  return null
}

export function savedBackend() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveBackend(kind) {
  try {
    localStorage.setItem(KEY, kind)
  } catch {
    /* sem armazenamento */
  }
}

/** O tipo de servidor que esta janela carregou. */
export const currentBackend = () => window.spectraBackend

/**
 * Chamado pela tela de configuração antes de testar o servidor novo. Se ele for de
 * outro tipo, guarda as configurações e recarrega a janela com o código certo.
 * Devolve true quando vai recarregar.
 */
export async function switchIfNeeded(server, saveSettings) {
  const kind = await detectBackend(server)
  if (!kind || kind === currentBackend()) return false
  saveSettings()
  saveBackend(kind)
  location.reload()
  return true
}
