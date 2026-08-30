---
name: flyhub-deploy
description: >-
  Deploy, restart, inspect or triage the LiveOne usher hub — the Fly.io app `liveone-flyhub`
  (packages/usher) that WireGuards into the sheephouse (DeepSea generator) and kinkora (Fronius)
  site LANs and pushes readings to gusher. Use for "redeploy the flyhub", "restart the hub",
  "roll back the hub", "ship a usher/musher/fusher change", changing an usher poll cadence or
  usher.yaml, setting/rotating a Fly secret, checking whether the hub is alive, or debugging a
  site that has stopped reporting. There is NO CI for this app — every deploy is by hand, from
  this repo, with a flag that is easy to forget.
---

# Deploying the usher hub (`liveone-flyhub`)

## The one command

From the **repo root** (not `packages/usher` — the build context is the whole monorepo):

```bash
fly deploy . -c packages/usher/deploy/fly/fly.toml --ha=false
```

That is the whole procedure. Everything below is why, and what to check.

- **`--ha=false` is mandatory, every time.** One machine, one volume — it cannot roll. Without the
  flag Fly tries to stand up a second machine and the deploy fails.
- **No `--dockerfile` flag.** The path comes from `[build]` in `fly.toml` and is resolved relative
  to the fly.toml's own directory. A stale comment at the top of `deploy/fly/Dockerfile` shows the
  wrong form (no `--ha=false`, redundant `--dockerfile`) — ignore it.
- **There is no CI, no npm `deploy` script, no GitHub workflow.** `git push` deploys the *web app*
  to Vercel and does nothing to the hub. If you changed `packages/usher/**`, merging is not
  shipping — you must run the command above.
- **Deploys build from the working tree**, not from a git ref. Check `git status` first: whatever is
  on disk is what ships.
- Takes roughly 3–6 minutes (remote builder does `npm ci` + `next build` for the monorepo).

## What this app actually is

One Fly machine in `syd` running **one usher** (`packages/usher`, a Next.js `output: standalone`
app) that is simultaneously a **multi-peer WireGuard hub**. `deploy/fly/entrypoint.sh` brings up
`wg0`, starts `cloudflared`, sleeps 5 s for the peers to re-handshake, then execs the server bound
to `127.0.0.1`.

| | sheephouse | kinkora |
|---|---|---|
| gateway | UniFi behind Starlink CGNAT | UniFi on DSL |
| collector | `musher` — DeepSea DSE7410 generator | `fusher` — two Fronius inverters |
| peer WG IP | `10.9.0.2/32` | `10.9.0.3/32` |
| device CIDRs | `SHEEPHOUSE_DEVICE_CIDRS` (`[env]`) | `KINKORA_DEVICE_CIDRS` (**secret**) |
| gusher key | `MUSHER_API_KEY` | `KINKORA_API_KEY` |

**Both sites use `10.0.1.0/24`.** The hub keeps them apart only by routing distinct device `/32`s —
**never route a whole `/24`**, and check for overlap before touching a peer.

Only **UDP 51820** is published on the Fly IP. There is no `[http_service]`; the inspector at
`https://usher.liveone.energy` is reachable solely through the cloudflared tunnel behind Cloudflare
Access. There is no public origin to bypass.

## The files (all under `packages/usher/`)

| path | what |
|---|---|
| [`deploy/fly/fly.toml`](../../../packages/usher/deploy/fly/fly.toml) | app name, region, `[env]`, `[mounts]`, WG service, VM size. Its header comment is the authoritative secrets list. |
| [`deploy/fly/Dockerfile`](../../../packages/usher/deploy/fly/Dockerfile) | 2-stage `node:22-alpine`; builds the standalone, installs `wireguard-tools` + `cloudflared`, bakes the config |
| [`deploy/fly/entrypoint.sh`](../../../packages/usher/deploy/fly/entrypoint.sh) | wg0 → cloudflared → `node server.js` |
| [`deploy/fly/Dockerfile.dockerignore`](../../../packages/usher/deploy/fly/Dockerfile.dockerignore) | keeps local DB dumps out of the build context — a deploy once uploaded ~4.1 GB at ~1 MB/s |
| [`usher.example.yaml`](../../../packages/usher/usher.example.yaml) | 🚨 **this IS production config** (see below) |
| [`docs/deploy-fly.md`](../../../packages/usher/docs/deploy-fly.md) | full procedure: volume, secrets, on-site UniFi, Cloudflare Access |
| [`docs/operations.md`](../../../packages/usher/docs/operations.md) | liveness signals, store/spool triage table, gotchas |
| [`docs/architecture.md`](../../../packages/usher/docs/architecture.md) | the model — durability, remote control, deploy-target independence |

Web-app side (Vercel env, not Fly): `USHER_CONTROL_URL`, `USHER_CF_ACCESS_CLIENT_ID`,
`USHER_CF_ACCESS_CLIENT_SECRET` — see `lib/vendors/deepsea/hub-client.ts`.

## 🚨 `usher.example.yaml` is the live config

`packages/usher/usher.yaml` is gitignored and does not exist in the repo. The Dockerfile copies
**`usher.example.yaml` → `/app/usher.yaml`**, so whatever is committed there becomes production on
the next deploy — real hosts, unit ids, poll cadences and `control.maxRuntimeSec` included. It is
not an example.

Consequences:

- **Editing it is a production change**, even though it looks like a template. Review it before any
  deploy — someone else's in-flight cadence experiment ships with your unrelated fix.
- Cadence changes (`pollSec`, `activeSec`, `pushSec`, `activePushSec`, `transitionSec`) need
  **no code change** — edit the yaml, redeploy.
- Secrets stay out of it: `apiKeyEnv` / `control.passkeyEnv` name env vars, resolved at runtime.

## Secrets

Set with `fly secrets set NAME=… -a liveone-flyhub` — **setting a secret triggers its own restart**,
so you do not also need a deploy. Never in `fly.toml`. Full table with descriptions:
[`docs/deploy-fly.md § Secrets`](../../../packages/usher/docs/deploy-fly.md).

`WG_PRIVKEY` · `SHEEPHOUSE_PEER_PUBKEY` · `KINKORA_PEER_PUBKEY` · `KINKORA_DEVICE_CIDRS` ·
`TUNNEL_TOKEN` · `MUSHER_API_KEY` · `KINKORA_API_KEY` · `SHEEPHOUSE_CONTROL_KEY` ·
`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` (optional)

- ⚠️ The sheephouse gusher key is **`MUSHER_API_KEY`**, not `SHEEPHOUSE_API_KEY`. Nothing reads the
  latter, so provisioning it yields silent no-auth.
- ⚠️ A secret **shadows a same-named `[env]` value** in fly.toml (e.g. `MUSHER_DIAGNOSTICS`).
  If an `[env]` change appears to have no effect, run `fly secrets list -a liveone-flyhub`.
- ⚠️ **Control-passkey rotation is two-sided**: `scripts/deepsea/set-control-passkey.ts` (Clerk
  private metadata, LiveOne side) **and** `fly secrets set SHEEPHOUSE_CONTROL_KEY` (hub side).
  Mismatch/missing = the control route 503s; collection is unaffected.

## Verify after a deploy

```bash
fly status -a liveone-flyhub                                                          # one machine, started
fly ssh console -a liveone-flyhub -C "wg show wg0"                                    # BOTH peers with a recent handshake
fly ssh console -a liveone-flyhub -C "ping -c3 10.0.1.244"                            # DeepSea over the sheephouse tunnel
fly ssh console -a liveone-flyhub -C "df -h /data"                                    # volume mounted, headroom
fly ssh console -a liveone-flyhub -C "wc -l /data/usher/blackbox/$(date -u +%F).jsonl" # journal growing = really alive
fly ssh console -a liveone-flyhub -C "ls -la /data/usher/spool"                        # should be empty
fly logs -a liveone-flyhub                                                             # stream; look for "stored N readings (200)"
```

Then open `https://usher.liveone.energy` (Access SSO) and confirm both sources are ticking, and that
readings are landing in LiveOne. **If the generator control path matters, also run the probe** — it
exercises Access → passkey → registry → supervisor → Modbus → DSE with FC3 reads only:

```bash
curl -X POST https://usher.liveone.energy/api/usher/control/sheephouse/probe \
  -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "x-usher-passkey: …"
```

## Gotchas that have each cost real time

- **The Fronius inverters do not answer ICMP.** A failed `ping` to `10.0.1.190/.191` is *not* a
  fault. The DeepSea *does* answer. Validate kinkora from a `[kinkora] stored N readings (200)` log
  line or a growing journal instead.
- **`fly logs --no-tail` returns a stale buffered window.** Stream `fly logs`; a big backlog also
  replays slowly.
- **First 1–2 fusher ticks after any restart log `no readings this tick (all n/a)`** while the
  inverters are discovered. Normal — confirm recovery on the next tick.
- **The volume must pre-exist**, or the deploy fails on the mount:
  `fly volumes create usher_data --size 1 --region syd -a liveone-flyhub`. The volume survives
  deploys, so an outage backlog is never lost to a redeploy.
- **Redeploying mid-generator-run is safe but not free.** The RunSupervisor persists an absolute
  `stopAt`, so a restart resumes the deadline rather than dropping the latch — but the machine does
  go down for the swap. Re-probe afterwards, and prefer not to deploy while latched.
- **Don't remove `export HOSTNAME=127.0.0.1` from entrypoint.sh.** Fly sets `HOSTNAME` to the
  machine name, so the old `${HOSTNAME:-127.0.0.1}` fallback never fired. Without the explicit line
  the server binds beyond loopback, and `wg0` routes both site LANs — any LAN device could reach the
  **generator control API** with only the passkey in the way.
- **`MUSHER_DIAGNOSTICS = "1"` is on** (in `[env]`, deliberately visible in-repo — it was once set
  out-of-band and nobody knew capture was off, losing the 2026-07-26 run). ~52 MB/day raw, ~0.5 MB/day
  once gz-rolled, dir capped at 100 MB oldest-purged. To disable: set `"0"`, redeploy, prune
  `/data/usher/diag`.
- **Spool non-empty and *static*** means pushes are being rejected (4xx: bad key/site/body) — a
  redeploy will not fix it. Growing-but-draining is just a receiver outage and self-heals. Full
  symptom→action table: [`docs/operations.md § Store triage`](../../../packages/usher/docs/operations.md).

## Other operations

```bash
fly status -a liveone-flyhub          # machine state + current image
fly releases -a liveone-flyhub        # version history
fly machine restart <id> -a liveone-flyhub   # restart without rebuilding (config/secret already changed)
fly ssh console -a liveone-flyhub     # interactive shell
```

**Roll back** by redeploying a previous image rather than rebuilding — get the ref from
`fly releases --image -a liveone-flyhub`, then:

```bash
fly deploy -c packages/usher/deploy/fly/fly.toml --ha=false --image <registry.fly.io/liveone-flyhub:deployment-…>
```

## Not this app

`liveone-poll` / `liveone-relay` / `liveone-sse` appear in `docs/plans/live-dashboard-roadmap.md` as
**planned** Fly apps. They do not exist. `liveone-flyhub` is the only Fly app in this project.
The alternative (unused) deploy target for usher is a Raspberry Pi —
[`docs/deploy-pi.md`](../../../packages/usher/docs/deploy-pi.md).
