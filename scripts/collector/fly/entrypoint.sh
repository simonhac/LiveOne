#!/bin/sh
# LiveOne collector hub (musher) entrypoint.
#
# Brings up the WireGuard hub tunnel (the sheephouse UDM dials in as a WG client), routes the
# DeepSea DSE /32 over it, then runs the collector. Prefers kernel WireGuard (Fly's Firecracker
# host provides it), falls back to userspace wireguard-go.
set -eu
log() { echo "[flyhub] $*"; }

: "${WG_PRIVKEY:?set WG_PRIVKEY (hub WireGuard private key)}"
: "${PEER_PUBKEY:?set PEER_PUBKEY (sheephouse UDM WireGuard public key)}"
: "${MUSHER_API_KEY:?set MUSHER_API_KEY (gusher push credential)}"

DSE_IP="${DEEPSEA_HOST:-10.0.1.244}"
WG_ADDR="${WG_ADDR:-10.9.0.1/24}"     # hub tunnel address (peers: UDM = .2)
PEER_WG_IP="${PEER_WG_IP:-10.9.0.2/32}"

# datapath: prefer kernel WireGuard; else userspace (wireguard-go needs /dev/net/tun)
if ip link add wgk type wireguard 2>/dev/null; then
  ip link del wgk 2>/dev/null || true
  log "datapath: kernel WireGuard"
else
  export WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
  [ -c /dev/net/tun ] || { mkdir -p /dev/net; mknod /dev/net/tun c 10 200 2>/dev/null || true; }
  log "datapath: userspace (wireguard-go)"
fi

mkdir -p /etc/wireguard
cat >/etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $WG_PRIVKEY
ListenPort = 51820
Address = $WG_ADDR
MTU = 1280

[Peer]
PublicKey = $PEER_PUBKEY
AllowedIPs = $PEER_WG_IP, $DSE_IP/32
PersistentKeepalive = 25
EOF

log "bringing up wg0 (peer=sheephouse UDM, route ${DSE_IP}/32)…"
wg-quick up wg0
wg show || true

sleep 5   # let the UDM (re)handshake so the first DSE read reaches the LAN
log "starting collector → ${GUSH_ENDPOINT:-?}  site=${MUSHER_SITE_ID:-sheephouse}  dse=${DSE_IP}"
exec node /app/collector.cjs
