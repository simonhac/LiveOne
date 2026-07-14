# usher hub on Fly.io (`liveone-flyhub`)

Permanent Fly WireGuard hub that runs **one usher** managing both sites over WireGuard:

- **sheephouse UDM** (the primary site, behind Starlink CGNAT) dials in as a WG client → the **DeepSea**
  generator (`musher`).
- **kinkora UDM** (standard DSL) dials in as a WG client → the two **Fronius** inverters (`fusher`).

The usher is a Next.js app (standalone build); it polls the devices over the tunnels and POSTs
self-describing readings to gusher (`/api/gush`). The inspector dashboard is fronted by **Cloudflare
Access** (cloudflared) at `usher.liveone.energy` — the Fly IP exposes **only** the WireGuard UDP port.

> This replaces the old esbuild `collector.cjs` image (`scripts/collector/fly/`). It also folds in the
> Kinkora Fronius feed, so the Kinkora FroniusPusher Pi is retired after cutover.

## Persistent store volume (create BEFORE deploying)

The usher journals every collected batch to a **blackbox** (daily JSONL, gzipped on roll) and
buffers undelivered batches in a **spool** (drained when the receiver recovers), both under
`USHER_DATA_DIR=/data/usher` on a persistent volume (`fly.toml [mounts]`). One-time setup — the
deploy **fails** if the mount's volume doesn't exist:

```bash
fly volumes create usher_data --size 1 --region syd -a liveone-flyhub   # ~$0.15/GB/mo
```

Sizing: ~1 MB/day compressed journal → 1 GB holds years; the spool may grow to 75% of the disk
during a liveone outage (weeks of buffer). Blackbox archives are GC'd oldest-first below 10% free.
Without a volume/writable dir the usher still runs — journaling+buffering degrade with a warning
(readings then only survive within a single push attempt, as before).

## Build & deploy (from the repo root — monorepo build context)

```bash
fly deploy -c packages/usher/deploy/fly/fly.toml \
           --dockerfile packages/usher/deploy/fly/Dockerfile
```

The Dockerfile builds the standalone in-image (`npm ci` + `next build`), installs `wireguard-tools`

- `cloudflared`, and bakes `usher.example.yaml` as `/app/usher.yaml`. **Edit the config's hosts for
  the real deployment** (or bake a real `packages/usher/usher.yaml`); `apiKeyEnv` keeps secrets out.

## Secrets (`fly secrets set …`)

| secret                   | what                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `WG_PRIVKEY`             | hub WireGuard private key (reuse the probe's so the hub pubkey is unchanged) |
| `SHEEPHOUSE_PEER_PUBKEY` | sheephouse UDM WG public key                                                 |
| `KINKORA_PEER_PUBKEY`    | kinkora UDM WG public key                                                    |
| `KINKORA_DEVICE_CIDRS`   | the two Fronius inverter `/32`s, comma-separated                             |
| `TUNNEL_TOKEN`           | cloudflared tunnel token (Access → `usher.liveone.energy`)                   |
| `SHEEPHOUSE_API_KEY`     | gusher `gk_` key for system `sheephouse`                                     |
| `KINKORA_API_KEY`        | gusher `gk_` key for system `kinkora`                                        |

Non-secret WG addressing is in `fly.toml` `[env]`.

## On-site (UDMs)

Each UDM is a WG **client** dialing `flyhub.liveone.energy:51820` (UniFi → Settings → VPN → VPN
Client). Routes: sheephouse → the DSE `/32`; kinkora → the two inverter `/32`s. **Check the Kinkora
inverter subnet does not overlap the primary site's `10.0.1.0/24`** before wiring the second peer.

## Verify

```bash
fly ssh console -a liveone-flyhub -C "wg show wg0"            # both UDM peers handshaking?
fly ssh console -a liveone-flyhub -C "ping -c3 10.0.1.244"    # DSE over the sheephouse tunnel
fly ssh console -a liveone-flyhub -C "ping -c3 <kinkora-ip>"  # inverter over the kinkora tunnel
# then: open https://usher.liveone.energy (Cloudflare Access SSO) and confirm both sources are live;
# and confirm system 14 (sheephouse) + kinkora point_readings keep flowing (LiveOne View Data).
```

## Cloudflare Access (cloudflared)

Create a **Tunnel** in the Zero Trust dashboard → public hostname `usher.liveone.energy` →
`http://127.0.0.1:3000`; copy the token to `TUNNEL_TOKEN`. Add an **Access application** on that
hostname with a policy allowing the owner identity only. Nothing is reachable without passing Access;
there is no public Fly HTTP origin to bypass. See the `cloudflare-one` skill for exact steps.
