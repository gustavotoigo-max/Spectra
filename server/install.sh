#!/usr/bin/env bash
# Spectra — instala o servidor numa VM Ubuntu (pensado para o nível gratuito da Oracle Cloud).
#
# Uso (na VM, dentro da pasta server/):
#   sudo ./install.sh                 # usa <ip>.sslip.io como domínio
#   sudo ./install.sh meu.dominio.com # usa um domínio próprio (registro A apontando para a VM)
#
# Pode rodar de novo a qualquer momento: as chaves do .env são mantidas.

set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo ./install.sh" >&2
  exit 1
fi

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

# ---- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando o Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

# ---- 2. Domínio ------------------------------------------------------------
IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ] && [ -f .env ]; then
  DOMAIN="$(grep -E '^SPECTRA_DOMAIN=' .env | cut -d= -f2- || true)"
fi
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
say "IP público: $IP — domínio: $DOMAIN"

# ---- 3. Chaves -------------------------------------------------------------
rand() { openssl rand -hex "$1"; } # $1 bytes → 2×$1 caracteres

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-API$(rand 6)}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-$(rand 24)}"
SPECTRA_ACCESS_KEY="${SPECTRA_ACCESS_KEY:-$(rand 5)}"

cat > .env <<EOF
SPECTRA_DOMAIN=$DOMAIN
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
SPECTRA_ACCESS_KEY=$SPECTRA_ACCESS_KEY
EOF
chmod 600 .env

# ---- 4. Configuração do LiveKit -------------------------------------------
cat > livekit.yaml <<EOF
# Gerado pelo install.sh — rode o script de novo em vez de editar à mão.
port: 7880
bind_addresses:
  - 127.0.0.1          # só o Caddy (HTTPS) fala com a sinalização
rtc:
  tcp_port: 7881        # alternativa quando o UDP está bloqueado
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
turn:
  enabled: true         # TURN embutido, para redes restritivas (4G, empresas)
  domain: $DOMAIN
  udp_port: 3478
room:
  empty_timeout: 300
  departure_timeout: 20
  max_participants: 25
logging:
  level: info
EOF

# ---- 5. Firewall da VM -----------------------------------------------------
# As imagens Ubuntu da Oracle vêm com iptables bloqueando tudo menos SSH.
say "Liberando portas no firewall da VM"
open_port() { # proto porta
  local rule=(-p "$1" -m state --state NEW -m "$1" --dport "$2" -j ACCEPT)
  iptables -C INPUT "${rule[@]}" 2>/dev/null || iptables -I INPUT 1 "${rule[@]}"
}
open_port tcp 80
open_port tcp 443
open_port tcp 7881
open_port udp 3478
open_port udp 50000:60000
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80,443,7881/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
  ufw allow 50000:60000/udp >/dev/null
fi

# ---- 6. Subir ---------------------------------------------------------------
say "Subindo os serviços (a primeira vez demora alguns minutos)"
docker compose pull --quiet livekit caddy
docker compose up -d --build

say "Aguardando o certificado HTTPS"
for _ in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 4
done

echo
if [ "${OK:-0}" = 1 ]; then
  printf '\033[1;32mServidor no ar!\033[0m\n'
else
  printf '\033[1;33mOs serviços subiram, mas https://%s ainda não respondeu.\033[0m\n' "$DOMAIN"
  echo "Confira se as portas estão liberadas também na Security List da Oracle (veja o README)."
fi
cat <<EOF

  Coloque estes dados no app Spectra (engrenagem → Servidor):

    Servidor:         https://$DOMAIN
    Chave de acesso:  $SPECTRA_ACCESS_KEY

EOF
