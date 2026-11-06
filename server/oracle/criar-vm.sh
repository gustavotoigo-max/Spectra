#!/usr/bin/env bash
# Spectra — tenta criar a VM grátis da Oracle (Always Free: ARM ou AMD Micro).
#
# Roda sem perguntar nada: é chamado pelo workflow "Criar VM na Oracle" do
# GitHub Actions a cada 5 minutos, até a Oracle ter vaga. Também funciona no
# Cloud Shell da Oracle: `bash server/oracle/criar-vm.sh`.
#
# Variáveis (todas opcionais, menos a conta):
#   OCI_TENANCY       OCID da conta (o Cloud Shell já define)
#   SSH_PUBLIC_KEY    chave pública SSH (conteúdo); senão usa ~/.ssh/spectra_oci.pub
#   TEMPO_MAXIMO      segundos tentando nesta execução (padrão 240)
#   INTERVALO         segundos entre tentativas (padrão 30)
#   SHAPE             formato (padrão VM.Standard.A1.Flex; ou VM.Standard.E2.1.Micro, a AMD grátis)
#   OCPUS, MEMORIA    tamanho da VM ARM (padrão 1 OCPU, 6 GB; ignorado na Micro)
#   NOME              nome da VM (padrão spectra)
#   SUBNET_NOME       subnet a usar (padrão spectra-publica, criada pelo criar-rede.sh)
#
# Saída: código 0 quando a VM existe (criada agora ou antes), 2 quando ainda
# não houve vaga, 1 em erro de verdade. Grava "ip=..." em $GITHUB_OUTPUT.

set -u
TEMPO_MAXIMO=${TEMPO_MAXIMO:-240}
INTERVALO=${INTERVALO:-30}
OCPUS=${OCPUS:-1}
MEMORIA=${MEMORIA:-6}
NOME=${NOME:-spectra}
SUBNET_NOME=${SUBNET_NOME:-spectra-publica}
SHAPE=${SHAPE:-VM.Standard.A1.Flex}

diga() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
erro() { printf '::error::%s\n' "$*"; exit 1; }
saida() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >>"$GITHUB_OUTPUT"; return 0; }
resumo() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$1" >>"$GITHUB_STEP_SUMMARY"; return 0; }

command -v jq >/dev/null || erro "Precisa do jq."
TENANCY=${OCI_TENANCY:-$(grep -m1 '^tenancy' ~/.oci/config 2>/dev/null | cut -d= -f2 | tr -d ' ')}
[ -n "$TENANCY" ] || erro "OCI_TENANCY não definido."

ip_da_vm() {
  oci compute instance list-vnics --instance-id "$1" 2>/dev/null | jq -r '.data[0]."public-ip" // empty'
}

pronto() { # $1 = id da VM
  local ip=""
  for _ in $(seq 1 30); do
    ip=$(ip_da_vm "$1")
    [ -n "$ip" ] && break
    sleep 10
  done
  diga "VM pronta! IP público: ${ip:-ainda sem IP, veja no painel}"
  saida "ip=$ip"
  resumo "### ✅ VM do Spectra criada"
  resumo ""
  resumo "IP público: \`${ip}\`"
  resumo ""
  resumo "Entre pelo Cloud Shell da Oracle: \`ssh -i ~/.ssh/spectra_oci ubuntu@${ip}\` e rode o \`install.sh\` (veja o README)."
  exit 0
}

# ---- já existe? ----------------------------------------------------------------
EXISTENTE=$(oci compute instance list --compartment-id "$TENANCY" --display-name "$NOME" --all 2>/dev/null |
  jq -r '[.data[]? | select(."lifecycle-state" != "TERMINATED" and ."lifecycle-state" != "TERMINATING")][0].id // empty')
if [ -n "$EXISTENTE" ]; then
  diga "A VM '$NOME' já existe."
  pronto "$EXISTENTE"
fi

# ---- o que é preciso para criar ------------------------------------------------
ADS=$(oci iam availability-domain list --compartment-id "$TENANCY" | jq -r '.data[].name')
[ -n "$ADS" ] || erro "Não consegui falar com a Oracle (confira os segredos OCI_*)."

SUBNET_ID=$(oci network subnet list --compartment-id "$TENANCY" --all 2>/dev/null |
  jq -r --arg n "$SUBNET_NOME" '[.data[]? | select(."lifecycle-state" == "AVAILABLE" and ."prohibit-public-ip-on-vnic" == false)]
    | (map(select(."display-name" == $n)) + .)[0].id // empty')
[ -n "$SUBNET_ID" ] || erro "Nenhuma subnet pública. Rode antes o server/oracle/criar-rede.sh no Cloud Shell."

IMAGE_ID=$(oci compute image list --compartment-id "$TENANCY" --operating-system 'Canonical Ubuntu' \
  --operating-system-version '24.04' --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all |
  jq -r '[.data[] | select(."display-name" | test("Minimal") | not)][0].id // empty')
[ -n "$IMAGE_ID" ] || erro "Não achei a imagem do Ubuntu 24.04 para $SHAPE."

KEYFILE=$(mktemp)
if [ -n "${SSH_PUBLIC_KEY:-}" ]; then
  printf '%s\n' "$SSH_PUBLIC_KEY" >"$KEYFILE"
elif [ -f ~/.ssh/spectra_oci.pub ]; then
  cp ~/.ssh/spectra_oci.pub "$KEYFILE"
else
  erro "Sem chave SSH: defina SSH_PUBLIC_KEY ou crie ~/.ssh/spectra_oci.pub."
fi

# Só os formatos Flex (ARM) aceitam escolher OCPU/memória.
FORMATO=()
case "$SHAPE" in *Flex) FORMATO=(--shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORIA}") ;; esac

# ---- tentar ----------------------------------------------------------------------
FIM=$(($(date +%s) + TEMPO_MAXIMO))
TENTATIVA=0
while :; do
  for AD in $ADS; do
    TENTATIVA=$((TENTATIVA + 1))
    SAIDA=$(oci compute instance launch \
      --availability-domain "$AD" --compartment-id "$TENANCY" \
      --shape "$SHAPE" "${FORMATO[@]}" \
      --image-id "$IMAGE_ID" --subnet-id "$SUBNET_ID" --assign-public-ip true \
      --display-name "$NOME" --ssh-authorized-keys-file "$KEYFILE" \
      --wait-for-state RUNNING --max-wait-seconds 600 2>&1)
    if [ $? -eq 0 ]; then
      ID=$(echo "$SAIDA" | sed -n '/^{/,$p' | jq -r '.data.id')
      diga "Criada na tentativa $TENTATIVA."
      pronto "$ID"
    fi
    if echo "$SAIDA" | grep -qiE 'out of (host )?capacity|InternalError|TooManyRequests'; then
      diga "Tentativa $TENTATIVA: sem vaga ainda ($AD)."
    elif echo "$SAIDA" | grep -qiE 'LimitExceeded|QuotaExceeded|service limit'; then
      echo "$SAIDA"
      erro "Recusado por limite da conta grátis (talvez já existam VMs usando todo o limite grátis desse formato)."
    else
      echo "$SAIDA"
      erro "Erro inesperado (veja acima)."
    fi
  done
  [ "$(date +%s)" -lt $((FIM - INTERVALO)) ] || break
  sleep "$INTERVALO"
done

diga "Sem vaga por enquanto. Tenta de novo na próxima execução."
exit 2
