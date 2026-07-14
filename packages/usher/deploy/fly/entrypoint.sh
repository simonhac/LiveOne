#!/bin/sh
# usher hub (Fly.io) entrypoint.
#
# Brings up a MULTI-PEER WireGuard hub (the sheephouse UDM + the kinkora UDM each dial in as a WG
# client), routes each site's device /32s over its tunnel, starts the Cloudflare Access tunnel
# (cloudflared) in the background, then runs the Next.js usher server bound to localhost (no public
# HTTP ingress — cloudflared fronts it; only the WG UDP port is exposed on the Fly IP).
set -eu
log() { echo "[usher-hub] $*"; }

: "${WG_PRIVKEY:?set WG_PRIVKEY (hub WireGuard private key)}"

WG_ADDR="${WG_ADDR:-10.9.0.1/24}"

# ── datapath: prefer kernel WireGuard; else userspace (wireguard-go needs /dev/net/tun) ──
if ip link add wgk type wireguard 2>/dev/null; then
  ip link del wgk 2>/dev/null || true
  log "datapath: kernel WireGuard"
else
  export WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
  [ -c /dev/net/tun ] || { mkdir -p /dev/net; mknod /dev/net/tun c 10 200 2>/dev/null || true; }
  log "datapath: userspace (wireguard-go)"
fi

mkdir -p /etc/wireguard
{
  echo "[Interface]"
  echo "PrivateKey = $WG_PRIVKEY"
  echo "ListenPort = 51820"
  echo "Address = $WG_ADDR"
  echo "MTU = 1280"

  # Peer A — sheephouse UDM (primary site): routes the DeepSea DSE over the tunnel.
  if [ -n "${SHEEPHOUSE_PEER_PUBKEY:-}" ]; then
    echo ""
    echo "[Peer]"
    echo "# sheephouse UDM (primary site) → DeepSea generator"
    echo "PublicKey = $SHEEPHOUSE_PEER_PUBKEY"
    echo "AllowedIPs = ${SHEEPHOUSE_PEER_WG_IP:-10.9.0.2/32}, ${SHEEPHOUSE_DEVICE_CIDRS:-10.0.1.244/32}"
    echo "PersistentKeepalive = 25"
  fi

  # Peer B — kinkora UDM: routes the two Fronius inverters over the tunnel.
  if [ -n "${KINKORA_PEER_PUBKEY:-}" ]; then
    echo ""
    echo "[Peer]"
    echo "# kinkora UDM → Fronius inverters"
    echo "PublicKey = $KINKORA_PEER_PUBKEY"
    echo "AllowedIPs = ${KINKORA_PEER_WG_IP:-10.9.0.3/32}, ${KINKORA_DEVICE_CIDRS:?set KINKORA_DEVICE_CIDRS (the two inverter /32s, comma-separated)}"
    echo "PersistentKeepalive = 25"
  fi
} > /etc/wireguard/wg0.conf

log "bringing up wg0 (peers: ${SHEEPHOUSE_PEER_PUBKEY:+sheephouse}${KINKORA_PEER_PUBKEY:+ kinkora})…"
wg-quick up wg0
wg show || true

# ── Cloudflare Access tunnel (fronts the inspector at usher.liveone.energy) ──
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  log "starting cloudflared…"
  cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
else
  log "TUNNEL_TOKEN not set — inspector NOT exposed (WG-only)."
fi

sleep 5 # let the UDMs (re)handshake so the first device read reaches the LANs

log "starting usher server on ${HOSTNAME:-127.0.0.1}:${PORT:-3000} (config ${USHER_CONFIG:-usher.yaml})"
exec node /app/packages/usher/server.js
