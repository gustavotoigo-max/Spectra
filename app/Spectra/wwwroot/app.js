// Spectra — ponto de entrada da interface.
//
// Escolhe o código do tipo de servidor configurado (Cloudflare ou LiveKit) e o
// carrega. Assim dá para trocar de servidor (por exemplo, da Cloudflare para a
// VM da Oracle) só mudando o endereço nas configurações do app.

import { detectBackend, savedBackend, saveBackend } from './backend.js'

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`Não consegui carregar ${src}`))
    document.head.append(s)
  })
}

let server = ''
try {
  server = JSON.parse(localStorage.getItem('spectra.settings') || '{}').server || ''
} catch {
  /* sem configurações ainda */
}

let kind = await detectBackend(server)
if (kind) saveBackend(kind)
else kind = savedBackend() || 'cloudflare'

window.spectraBackend = kind
if (kind === 'livekit') {
  await loadScript('vendor/livekit-client.umd.js')
  await import('./app-livekit.js')
} else {
  await import('./app-cloudflare.js')
}
