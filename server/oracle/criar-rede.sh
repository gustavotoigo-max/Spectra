#!/usr/bin/env bash
# Spectra — cria a rede da VM na Oracle (VCN + internet + subnet pública) e já
# libera as portas do Spectra. Para rodar no Cloud Shell da Oracle:
#   bash criar-rede-oracle.sh
set -eu
T=${OCI_TENANCY:?Rode no Cloud Shell da Oracle}
say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }

say "Criando a rede (VCN) spectra"
VCN=$(oci network vcn create -c "$T" --cidr-blocks '["10.0.0.0/16"]' --display-name spectra \
  --dns-label spectra --wait-for-state AVAILABLE | jq -r .data.id)

say "Ligando a rede à internet"
IGW=$(oci network internet-gateway create -c "$T" --vcn-id "$VCN" --is-enabled true \
  --display-name spectra-internet --wait-for-state AVAILABLE | jq -r .data.id)
RT=$(oci network vcn get --vcn-id "$VCN" | jq -r '.data."default-route-table-id"')
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null

say "Liberando as portas do Spectra (SSH 22; TCP 80, 443, 7881; UDP 3478, 50000-60000)"
SL=$(oci network vcn get --vcn-id "$VCN" | jq -r '.data."default-security-list-id"')
tcp() { printf '{"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":%s,"max":%s}}}' "$1" "$2"; }
udp() { printf '{"source":"0.0.0.0/0","protocol":"17","udpOptions":{"destinationPortRange":{"min":%s,"max":%s}}}' "$1" "$2"; }
ICMP='{"source":"0.0.0.0/0","protocol":"1","icmpOptions":{"type":3,"code":4}},{"source":"10.0.0.0/16","protocol":"1","icmpOptions":{"type":3}}'
RULES="[$(tcp 22 22),$(tcp 80 80),$(tcp 443 443),$(tcp 7881 7881),$(udp 3478 3478),$(udp 50000 60000),$ICMP]"
oci network security-list update --security-list-id "$SL" --force --ingress-security-rules "$RULES" >/dev/null

say "Criando a subnet pública"
oci network subnet create -c "$T" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 \
  --display-name spectra-publica --dns-label publica --wait-for-state AVAILABLE >/dev/null

say "Rede pronta. Agora a VM: workflow "Criar VM na Oracle" no GitHub, ou bash server/oracle/criar-vm.sh"
