# Collector hub on Fly.io (`liveone-flyhub`)

Permanent Fly WireGuard hub that runs the **musher** collector. The sheephouse UDM (Daylesford farm,
behind Starlink CGNAT) dials in as a WireGuard _client_; the hub routes the LAN-only DeepSea
DSE7410 (`10.0.1.244:502`) over the tunnel and the collector POSTs readings to `/api/gush`.

On-site (UDM / firewall) detail and the canonical network runbook live in the sheephouse network
knowledgebase: `hac-admin/…/farm/infrastructure/network/_network.md`. This is the code/deploy source
of truth (the knowledgebase keeps a backup kit).

## Build

```bash
npm run build:collector      # esbuild → scripts/collector/fly/collector.cjs (gitignored)
```

The bundle externalises `modbus-serial`; the image installs it (TCP only, `--omit=optional`).

## Deploy (first time — the probe → permanent migration)

> `liveone-flyhub-probe` already runs the hub on IP `149.248.222.4`. Fly can't rename an app or move
> a dedicated IP, so this stands up a **new** app with a **new** IP. We **reuse the hub WG keypair**
> so the hub's public key is unchanged — the only farm-side change is the UDM's `Endpoint`.

```bash
npm run build:collector
fly apps create liveone-flyhub --org personal
fly ips allocate-v4 -a liveone-flyhub                 # new dedicated IPv4 (the new endpoint, ~$2/mo)

# Reuse the probe's secrets so the hub keypair (⇒ public key) and push credential are identical.
# WG_PRIVKEY + MUSHER_API_KEY are read from the running probe machine; PEER_PUBKEY is the UDM's
# public key (not secret). Piped via `fly secrets import` so values never hit argv/disk.
#   (see the "reuse secrets" snippet in the migration notes)

fly deploy -c scripts/collector/fly/fly.toml --ha=false
```

Then, off-Fly:

1. **DNS (Cloudflare):** add `flyhub.liveone.energy` → the new IPv4 (A record).
2. **UDM (on-site, the one farm change):** UniFi → Settings → VPN → VPN Client `fly-liveone` → set
   `Endpoint = flyhub.liveone.energy:51820`. The peer `PublicKey` is unchanged (keypair reused).
3. **Verify** the new hub (below), then release the old app + IP.

## Verify

```bash
fly ssh console -a liveone-flyhub -C "wg show wg0"          # UDM peer handshaking?
fly ssh console -a liveone-flyhub -C "ping -c3 10.0.1.244"  # ~30 ms over the tunnel
# then confirm system 14 point_readings keep flowing (LiveOne View Data / gush sessions)
```

## Tear down the old hub (only after the new one is verified)

```bash
fly ips release 149.248.222.4 -a liveone-flyhub-probe
fly apps destroy liveone-flyhub-probe
```

## Config

- **Env** (`fly.toml`, non-secret): `COLLECTOR_INTERVAL_SEC=300` / `COLLECTOR_ACTIVE_INTERVAL_SEC=60`
  (boundary-aligned: 5-min idle, 1-min while running), `DEEPSEA_HOST`, `GUSH_ENDPOINT`, `MUSHER_SITE_ID`.
- **Secrets** (`fly secrets`): `WG_PRIVKEY`, `PEER_PUBKEY`, `MUSHER_API_KEY`.
- **WG** (from `entrypoint.sh`): hub `10.9.0.1/24`, UDP `51820`, MTU `1280`, peer AllowedIPs
  `10.9.0.2/32, 10.0.1.244/32`, keepalive `25`.
