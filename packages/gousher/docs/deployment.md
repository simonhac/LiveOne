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
