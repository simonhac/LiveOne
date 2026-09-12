# Isolated deployment recipes

The repository includes a container, Fly machine manifest and Pi systemd unit. No live deployment
has been performed by this change. Set the actual LiveOne origin, private receiver origin and LAN
forwarding addresses before deployment. Apply the generated LiveOne migration through the existing
migration workflow, first against a disposable database.

## Fly

Build from the repository root using `packages/gousher/deploy/fly/Dockerfile`. Create a **new** Fly
app and a **new** 1 GiB volume (`gousher_trial_data`) in Sydney. Use one machine; multiple replicas
must never share a collector token or assignment. Prepare `/data` owned by UID 10001, put the
bootstrap at `/data/bootstrap.yaml`, and mount the volume only on this machine. Put secrets in the
new app's deployment secret store. Leave mode `replay` until the vendor-specific coexistence gate
is approved and recorded. Deploy the receiver into another private app/volume using the same image
with its entrypoint changed to `trial-receiver -data /data/receiver -listen :8081`.

The runtime itself knows nothing about Fly. The receiver must be reached over authenticated private
HTTPS ingress; no public unauthenticated listener. Its bearer credential is distinct from the
collector and production keys. Check the durable acknowledgement and replay a duplicate before
enabling collection. Supply a dedicated trial monitor rather than a production heartbeat URL. Set `GOUSHER_METRICS_ENDPOINT` and `GOUSHER_METRICS_TOKEN` only for the new trial monitoring source; these optional settings export OTLP/HTTP JSON every minute with a five-second timeout. Do not copy production Usher monitoring variables.

## Authenticated LAN forwarding

Forward through the existing hub with a dedicated SSH key restricted to the required device ports.
An example *hub-side* authorized-key restriction is:

```
restrict,port-forwarding,permitopen="DEVICE_IP:502",permitopen="INVERTER_IP:80" ssh-ed25519 KEY trial-only
```

On the trial machine, a supervised SSH process can bind local-only forwarded ports:

```
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:1502:DEVICE_IP:502 -L 127.0.0.1:18080:INVERTER_IP:80 trial@HUB
```

Pin the hub's verified SSH host key; do not disable host-key checking. The private SSH key belongs
in deployment secrets. Configure Deep Sea at host `127.0.0.1`, port `1502`; configure Fronius host
`127.0.0.1:18080`. Match those exact hosts in bootstrap `allowedHosts`. Do not open new public LAN
proxies or change the production Usher's routing. The hub's actual SSH service/key provisioning is
an environment setup step, not something this repository assumes already exists.

## Raspberry Pi

Cross-build with `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o gousher ./cmd/gousher`.
Install under `/usr/local/bin`, create a dedicated `gousher` user, and prepare `/var/lib/gousher`
owned by that user. Install the sample service and create `/etc/gousher/bootstrap.yaml` and a
root-readable `/etc/gousher/secrets` EnvironmentFile. Set bootstrap `dataDir` to `/var/lib/gousher`.
Use the same private receiver and management APIs as the Fly build. Monitor service restarts,
collection freshness, delivery lag and volume consumption independently.

## Independent operations service

The daily comparison and production-monitor runner is implemented as `cmd/trial-ops` and included
in the container image. Use a separate process/machine and persistent volume, with the collector
inspector and receiver export credentials supplied through environment variables. A systemd template
is provided at `deploy/trial-ops.service`. Follow [automation.md](automation.md) to enable scoped
production feeds, measure a baseline, fill the example configuration and install an external health
watchdog. The template is preparation only: no service or production feed has been enabled by this
change. Existing coexistence and replay gates still apply before enabling shadow reads.

## Deployment preflight and binary smoke test

Run from the repository root:

```sh
python3 packages/gousher/tools/deployment-smoke.py
flyctl config validate --strict -c packages/gousher/deploy/fly/fly.toml
flyctl config validate --strict -c packages/gousher/deploy/fly/receiver.toml
flyctl config validate --strict -c packages/gousher/deploy/fly/operations.toml
```

The smoke test builds all three binaries, replays all four vendors, sends batches to a compiled
receiver on loopback, verifies authenticated export, removes captures while the receiver is stopped,
and verifies identical retries and conflicting retries after restart. It uses disposable storage and
random local credentials and cleans up its process and files. It does not contact vendor devices,
LiveOne or Fly. This is deployment qualification, not an initially failing TDD regression.

The receiver and operations manifests are separate app templates with no public ingress. Copy them
and replace app names before provisioning. Each requires its own new volume; make `/data` writable
by UID 10001 as described above. The receiver binds loopback and requires a separately provisioned
authenticated HTTPS forwarder before remote collectors can reach it. These manifests do not install
that forwarder or supply its credentials. Do not substitute a plaintext `.internal` URL: the clients
require HTTPS for remote destinations.

The operations manifest injects `/etc/gousher/trial-ops.json` from the base64-encoded app secret
`GOUSHER_TRIAL_OPS_CONFIG`. Set its `dataDir` to `/data/operations` and supply the separate token
environment variables named in that JSON. Follow the current [Fly configuration reference](https://fly.io/docs/reference/configuration/)
for file injection and entrypoint/CMD overrides. The collector manifest retains replay mode through
its bootstrap; prepare the managed collector identity and assignment before starting its management
polling. Production feed activation and measured baselines are prerequisites for the operations runner.

Read-only preflight found Fly authentication available and no existing trial apps on 2026-09-13.
No app, volume, secret, route or production configuration was created or changed. Before provisioning,
record the first trial site/vendor, LiveOne management origin, assigned poller and collector identity,
and authenticated forwarding destinations. Local tests and manifest validation do not satisfy these
operational gates or prove that a container can start on a newly provisioned volume.
