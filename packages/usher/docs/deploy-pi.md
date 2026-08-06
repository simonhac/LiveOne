# Deploy: usher on a Raspberry Pi (on-LAN, no tunnel)

> **Status:** current recipe, not currently exercised. The Pi was the original deploy target (for the
> predecessor, FroniusPusher); today the live deployment is the Fly hub —
> [deploy-fly.md](deploy-fly.md). The application code is target-agnostic
> ([architecture.md](architecture.md#deploy-target-independence)), so this path is
> tested-by-construction rather than continuously in use.

The simplest deployment: the usher runs on a Pi **on the site LAN**, polls devices directly (no
tunnel), and pushes to gusher over HTTPS. Same code and same `usher.yaml` as the Fly hub — only the
deploy target and whether a tunnel is needed differ.

Choose this when the site already has an always-on box on the LAN and you would rather not maintain a
tunnel. Choose the Fly hub when the site is behind CGNAT, when you would rather not own hardware on
site, or when one host should serve several sites.

**Portability note:** everything is JavaScript. The one heavyweight dependency, `modbus-serial`,
pulls `serialport` (native) only as an _optional_ dependency — needed for real serial ports, never
for Modbus TCP — so an `npm ci` that skips it is fine on arm.

## Build

On the Pi (arm), or cross-build and copy the standalone output. Node 22, as pinned in `.nvmrc`:

```bash
npm ci
npm run --workspace @liveone/usher build
# standalone output: packages/usher/.next/standalone (+ packages/usher/.next/static)
```

Deploy the standalone to `/opt/usher` so `server.js` lands at `/opt/usher/packages/usher/server.js`:

```bash
sudo mkdir -p /opt/usher
sudo cp -r packages/usher/.next/standalone/. /opt/usher/
sudo cp -r packages/usher/.next/static /opt/usher/packages/usher/.next/static
sudo cp packages/usher/usher.yaml /opt/usher/usher.yaml   # real hosts for this site (LAN IPs)
```

## Configure

```bash
sudo useradd --system --home /opt/usher usher || true
sudo mkdir -p /etc/usher
sudo tee /etc/usher/usher.env >/dev/null <<'ENV'
USHER_CONFIG=/opt/usher/usher.yaml
USHER_DATA_DIR=/var/lib/usher      # blackbox journal + outage spool
PORT=3000
HOSTNAME=127.0.0.1
KINKORA_API_KEY=gk_...             # the site's gusher key(s), named by usher.yaml apiKeyEnv
ENV
sudo chmod 600 /etc/usher/usher.env
sudo install -d -o usher -g usher /var/lib/usher
```

`USHER_DATA_DIR` matters: it is where the blackbox journal and the outage spool live, and it is what
makes "cannot lose a batch" true across a restart. Put it on persistent storage the `usher` user can
write. Without it the collector still runs, but readings survive only within a single push attempt —
see [architecture.md](architecture.md#the-durability-model).

## Run (systemd)

```bash
sudo cp packages/usher/deploy/pi/usher.service /etc/systemd/system/usher.service
sudo systemctl daemon-reload
sudo systemctl enable --now usher
journalctl -u usher -f     # watch it configure inverters + push
```

## Inspector access (Cloudflare Access)

Same Zero Trust model as the Fly hub — run `cloudflared` on the Pi so the inspector is reachable at
`usher.liveone.energy` behind Access (the server binds `127.0.0.1`, so nothing is exposed on the LAN
or the internet except through the tunnel):

```bash
# install cloudflared for your arch, then:
sudo cloudflared service install <TUNNEL_TOKEN>   # tunnel → http://127.0.0.1:3000
```

Point the same Access application's public hostname at this tunnel (or use a per-site hostname). For
a purely local inspector you can instead skip cloudflared and reach it via the LAN by setting
`HOSTNAME=0.0.0.0` — but then gate it another way; do not expose it to the internet ungated.

## Discovering inverters

Run the ARP setup helper on the LAN once to get the inverter hosts for `usher.yaml`:

```bash
npm run --workspace @liveone/usher discover:fronius
```

## Verify

```bash
systemctl status usher
journalctl -u usher -f                                   # expect: stored N readings (200)
wc -l /var/lib/usher/blackbox/$(date -u +%F).jsonl       # journal growing = collecting
ls -la /var/lib/usher/spool                              # should be empty
```

Triage for a non-empty spool or a disabled journal: [operations.md](operations.md#store-triage).
