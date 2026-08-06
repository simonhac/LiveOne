# Deploy: the usher hub on Fly.io (`liveone-flyhub`)

> **Status:** current — this is the live production deployment. The alternative target is a
> Raspberry Pi on the site LAN: [deploy-pi.md](deploy-pi.md).

A permanent Fly machine that is both a **multi-peer WireGuard hub** and a single **usher** serving
two sites:

- **sheephouse gateway** (primary site, behind Starlink CGNAT) dials in as a WG client → the
  **DeepSea** generator (`musher`).
- **kinkora gateway** (standard DSL) dials in as a WG client → the two **Fronius** inverters
  (`fusher`).

The usher itself is target-agnostic (see [architecture.md](architecture.md#deploy-target-independence));
WireGuard is brought up by `deploy/fly/entrypoint.sh` before the server starts, outside the app.

It polls the devices over the tunnels and POSTs self-describing readings to gusher (`/api/gush`).
The inspector dashboard is fronted by **Cloudflare Access** (cloudflared) at `usher.liveone.energy` —
the Fly IP exposes **only** the WireGuard UDP port.

## Persistent store volume (create BEFORE deploying)

The usher journals every collected batch to a **blackbox** (daily JSONL, gzipped on roll) and buffers
undelivered batches in a **spool** (drained when the receiver recovers), both under
`USHER_DATA_DIR=/data/usher` on a persistent volume (`fly.toml [mounts]`). One-time setup — the
deploy **fails** if the mount's volume doesn't exist:

```bash
fly volumes create usher_data --size 1 --region syd -a liveone-flyhub   # ~$0.15/GB/mo
```

Sizing: ~1 MB/day compressed journal → 1 GB holds years; the spool may grow to 75% of the disk during
a liveone outage (weeks of buffer). Blackbox archives are GC'd oldest-first below 10% free. Without a
volume/writable dir the usher still runs — journaling and buffering degrade with a warning (readings
then only survive within a single push attempt).

## Build & deploy

From the **repo root** — the build context is the whole monorepo, because the standalone build traces
across workspaces:

```bash
fly deploy . -c packages/usher/deploy/fly/fly.toml --ha=false
```

**`--ha=false` is required.** A single machine with a single volume cannot roll; without the flag Fly
tries to stand up a second machine and the deploy fails. The Dockerfile path comes from `fly.toml`'s
`[build]` section, so no `--dockerfile` flag is needed.

The Dockerfile builds the Next.js standalone in-image (`npm ci` + `next build`), installs
`wireguard-tools` and `cloudflared`, and bakes `usher.example.yaml` as `/app/usher.yaml`. **Edit that
config's hosts for the real deployment** (or bake a real `packages/usher/usher.yaml` and copy it
instead); `apiKeyEnv` keeps secrets out of the file.

## Secrets (`fly secrets set …`)

| secret                   | what                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `WG_PRIVKEY`             | hub WireGuard private key (reuse the probe's so the hub pubkey is unchanged) |
| `SHEEPHOUSE_PEER_PUBKEY` | sheephouse gateway WG public key                                             |
| `KINKORA_PEER_PUBKEY`    | kinkora gateway WG public key                                                |
| `KINKORA_DEVICE_CIDRS`   | the two Fronius inverter `/32`s, comma-separated                             |
| `TUNNEL_TOKEN`           | cloudflared tunnel token (Access → `usher.liveone.energy`)                   |
| `MUSHER_API_KEY`         | gusher `gk_` key for the sheephouse device                                   |
| `KINKORA_API_KEY`        | gusher `gk_` key for the kinkora device                                      |

> ⚠️ The sheephouse key really is **`MUSHER_API_KEY`** — that is the name `usher.example.yaml`
> declares in `apiKeyEnv`, and the name set on the deployed app. Earlier revisions of this document
> said `SHEEPHOUSE_API_KEY`; provisioning that name silently yields no auth, because nothing reads it.

Non-secret WireGuard addressing lives in `fly.toml` `[env]`.

## On-site (the UniFi gateways)

Each gateway is a WireGuard **client** dialling `flyhub.liveone.energy:51820` — UniFi → Settings →
VPN → VPN Client. (UniFi's native site-to-site does only OpenVPN/IPsec, which is why the gateway is a
client rather than a peer; see
[architecture.md](architecture.md#transport-why-wireguard-not-tailscale).)

Routes: sheephouse → the DeepSea `/32`; kinkora → the two inverter `/32`s. **Check the Kinkora
inverter subnet does not overlap the primary site's** before wiring the second peer — both sites use
the same private range, and the hub keeps them apart only by routing distinct device `/32`s, never a
whole `/24`.

## Verify

```bash
fly ssh console -a liveone-flyhub -C "wg show wg0"          # both peers handshaking?
fly ssh console -a liveone-flyhub -C "ping -c3 <dse-ip>"    # DeepSea over the sheephouse tunnel
fly ssh console -a liveone-flyhub -C "df -h /data"          # volume mounted, headroom
```

> The **Fronius inverters do not answer ICMP** — do not use ping to check the kinkora tunnel. Confirm
> it from a `[kinkora] stored N readings (200)` log line or a growing journal instead.

Then open `https://usher.liveone.energy` (Cloudflare Access SSO), confirm both sources are live, and
confirm readings keep flowing in LiveOne. More signals and triage: [operations.md](operations.md).

## Cloudflare Access (cloudflared)

Create a **Tunnel** in the Zero Trust dashboard → public hostname `usher.liveone.energy` →
`http://127.0.0.1:3000`; copy the token to `TUNNEL_TOKEN`. Add an **Access application** on that
hostname with a policy allowing the owner identity only. Nothing is reachable without passing Access;
there is no public Fly HTTP origin to bypass. See the `cloudflare-one` skill for exact steps.
