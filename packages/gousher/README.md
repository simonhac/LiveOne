# Gousher

A database-free Go collector and isolated shadow-trial receiver. LiveOne owns poller settings;
local bootstrap settings restrict the allowed device hosts, receiver and storage. The runtime
only accepts `replay` and `shadow` modes. Every Modbus write is rejected at the transport boundary.
Existing collectors remain production writers and TypeScript Usher remains the live generator controller.

```sh
cd packages/gousher
go test -race ./...
go build -o gousher ./cmd/gousher
go build -o trial-receiver ./cmd/trial-receiver
go run ./cmd/gousher -replay internal/gousher/testdata/fronius.jsonl
```

`bootstrap.example.yaml` uses the JSON-compatible subset of YAML; the binary deliberately accepts
that subset only. It contains no managed poller settings or secrets. Supply these deployment secrets:

- `GOUSHER_COLLECTOR_TOKEN`: minted in LiveOne's `/admin/pollers` screen.
- `GOUSHER_RECEIVER_TOKEN`: a separate random secret shared only with the private trial receiver.
- `GOUSHER_INSPECTOR_TOKEN`: a separate random secret for state/SSE access.
- `GOUSHER_INSTANCE_KEY`: 32 random bytes encoded as 64 hex characters (AES-256-GCM cache encryption).

The trial receives **no production ingestion key or heartbeat URL**. Its receiver must have a
separate origin, matching the collector's immutable LiveOne destination and bootstrap restriction.
The encrypted recovery snapshot also pins that destination. Do not copy production control state
or production backlogs into the trial volume.

Create a collector and a paused poller on `/admin/pollers`, install its bootstrap and secrets, and
start `gousher -config /path/bootstrap.yaml`. Config refreshes every 30 seconds, with a five-minute
outage backoff ceiling. A valid cache permits offline restart. Credentials refresh separately, are
never put into delivery records, and changes rebuild only their affected reader. A second process
cannot own the same data directory.

The inspector serves embedded assets at `/`. `/api/usher/state` and `/api/usher/stream` require an
inspector bearer token. The stream sends default SSE messages every two seconds. The JSON state exposes the Usher envelope,
pollers, collection/delivery timestamps,
configuration errors, storage accounting, DSE registers, and Fronius power/SOC, inverter details and
the last 20 reports. Fronius hardware identity, battery and meter details are discovered in the background.
Generator HTTP requests return a trial-mode refusal. The simulator-tested supervisor retains
absolute deadlines, persists before starts, keeps ambiguous starts armed and retries failed stops
every 15 seconds, including early/idle release failures recovered after restart. Extensions retain
pending stop retries and command errors. Simulator probes and releases preserve poll observations.
Production control activation is intentionally unavailable. Shared TypeScript/Go simulator traces
now pin the detailed run/probe contract and boot recovery. See [control.md](docs/control.md) for
authentication, concurrency, deadline checks and the intentionally stricter failure behavior.

## Configure your UniFi UDM

Follow the [UDM setup walkthrough](docs/unifi-udm.md#configure-your-udm--quick-start)
for the exact clicks to add an independent WireGuard VPN client. It includes a
[reusable client template](deploy/wireguard/udm-client.conf.example), the required
DNS field, file-import troubleshooting and connection checks. Examples contain no
site-specific details; keep generated configs and credentials outside the repo.

## Management APIs

All admin endpoints use `requireAdmin`. Collector endpoints require dedicated `lo_col_…` bearer
tokens; only their hashes are stored in LiveOne. New SQL migration `0066` is verified against disposable PostgreSQL, and has not been applied to shared LiveOne databases.

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/admin/pollers` | Inspect/create pollers; creation defaults to paused |
| `GET/PATCH/DELETE /api/admin/pollers/{id}` | Revision-checked settings, pause/resume and tombstones |
| `POST/PATCH /api/admin/collectors` | Enroll, rotate token, disable |
| `GET /api/collectors/me/config` | Assigned configuration, ETags, retained tombstones |
| `GET /api/collectors/me/credentials?pollerId=…` | Assigned vendor credentials only |
| `POST /api/collectors/me/status` | Applied revisions and collection/delivery health |
| `GET /api/collectors/me/baseline?pollerId=…&start=…&end=…` | Scoped cloud baseline fixtures |

PATCH/DELETE require the last observed `revision`. A deleted poller remains pending until its
reader acknowledges shutdown. Deletion never removes devices/readings. Creating a replacement
requires confirmed deletion acknowledgement and completed supervision; offline ownership is never
replaced automatically. Disabling a collector token revokes API access, but does not remotely stop
a disconnected reader: pause/delete and wait for acknowledgement before transferring ownership.

## Storage and replay

A 1 GiB volume starts with a 128 MiB pending spool, 32 MiB size-only compressed blackbox, and
64 MiB free-space reserve. The collector fsyncs each batch before delivery. Overflow discards oldest
pending batches and persists dropped counts and lost time bounds. Blackbox history is pruned first
under free-space pressure. Blackbox records have **no age expiry** and dropped deliveries are not
promised recoverable from it. Files are private (0600; directories 0700).

The separate trial receiver uses 128 MiB / three-day capture retention. Its response acknowledges
durable captures and receipts. A separate 32 MiB append-only receipt journal preserves duplicate
acknowledgements after captures expire; conflicting bytes are rejected. At the receipt limit, new
IDs fail closed instead of evicting history. See [automation.md](docs/automation.md) for upgrade
limits, independent production monitoring and daily comparison operations.

Golden JSONL fixtures carry ordered vendor inputs, timestamps, revisions, harvest boundaries and
expected readings. All four vendors replay without network access. From the repository root:

```sh
TZ=UTC npx tsx packages/gousher/tools/fixtures.ts
npm test -- --runInBand packages/gousher/__tests__/metadata.test.ts lib/collectors/__tests__/api.test.ts
```

Expected readings come from the existing TypeScript implementations. See [trial.md](docs/trial.md)
for rollout gates and remaining qualification work, and [deployment.md](docs/deployment.md) for recipes.

Independent comparisons accept reference and actual gusher batches as JSONL, with an explicit
sampling window (zero for vendor timestamps). A sample matches at most once; missing samples are
reported separately. Daily summaries are bounded to 16 MiB / 45 days. The comparison library's
`RetainFixture` keeps selected discrepancy inputs within a separate 16 MiB budget and refuses a new
fixture when full rather than evicting previously selected evidence.

```sh
go run ./cmd/compare -reference reference.jsonl -actual trial.jsonl -window 2s -summary-dir ./trial-review
```

Optional production LAN capture is disabled by default. To enable the TypeScript Usher hooks, set
`USHER_TRIAL_CAPTURE_DIR` to a dedicated directory and `USHER_TRIAL_CAPTURE_REVISION` to the positive
configuration revision being captured. The asynchronous gzip journal has a 32 MiB size-only budget,
a bounded in-memory queue and a 64 MiB free-space reserve; capture failures do not fail collection.
DSE records include raw registers and expected readings; Fronius records include ordered integration
inputs and explicit harvest boundaries. Change the revision whenever the captured configuration changes.

## Verification and monitoring

Run the isolated database integration suite from the repository root:

```sh
packages/gousher/tools/integration.sh
```

It starts a private loopback PostgreSQL cluster, applies the migration, exports computed Go batches
for all four vendors, and exercises real gusher/point-minting/outbox and managed CRUD code. It shuts
the cluster down on success or failure. PostgreSQL server tools, Go, Python and installed npm
dependencies are required; set `PG_BINDIR` if PostgreSQL is outside the searched locations. No shared
DB or external credential/queue/cache service is used. See [testing.md](docs/testing.md) for TDD evidence.

An independent production monitor can POST JSON to `/api/trial/windows`, authenticated with the
inspector bearer token:

```json
{"pollerId":"assigned-poller-id","revision":1,"windowEnd":"2026-09-12T00:15:00Z","baseline":{"failureRate":0.01,"p95ReadMs":100},"current":{"failureRate":0.03,"p95ReadMs":210}}
```

`windowEnd` identifies a completed, aligned 15-minute window. Supply measured production baseline
and current production values, not trial read metrics. Two consecutive bad windows disable that
revision; a duplicate does not advance the count, and a missing window breaks the consecutive run.
For an immediate incident, POST to `/api/trial/incidents` with `pollerId`, `revision` and `reason`
(`session-evicted`, `connection-disruption` or `attempted-write`). Both endpoints persist the trip,
cancel the affected read, and reject stale assignment revisions. HTTP 503 means persistence failed:
the in-memory reader is stopped, but the monitor must retry to establish durable restart inhibition.
After investigation, a new managed revision permits resuming; unchanged revisions remain disabled.

Replay can also stream computed, credential-free wire batches to a new JSONL file:

```sh
cd packages/gousher
go run ./cmd/gousher -replay internal/gousher/testdata/deepsea.jsonl -replay-batches /tmp/deepsea-batches.jsonl
```

Optional outbound metrics use a **dedicated trial monitoring source**:

- `GOUSHER_METRICS_ENDPOINT`: the source's complete OTLP/HTTP JSON metrics URL.
- `GOUSHER_METRICS_TOKEN`: its bearer credential, separate from collector, receiver and inspector tokens.

With both unset, export is disabled. With both configured, the process exports the newest snapshot
every minute, independently of collection. Requests have a five-second deadline, redirects are
refused, and response bodies are bounded. Export errors and partial rejections appear as a sanitized
`telemetryError` in inspector state. A failed export does not add anything to the delivery spool.

Metrics include heap/runtime memory, goroutines, pending/dropped batches, storage usage, collection
and delivery timestamps, stale collection and read-duration histograms. Service identity is
`liveone-gousher`, with a separate stable identifier for each process lifetime. The authenticated
`/metrics` endpoint also exposes cumulative read-duration buckets and failed-read counts. These
histograms support p95 latency queries; an average alone would hide slow reads. A reader without
any successful sample becomes stale after twice its poll interval, with a one-minute minimum.

The encoding follows the [OTLP/HTTP JSON specification](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).
Configure the trial monitoring source to accept JSON; production Usher monitoring variables are not read.

Fronius performs one bounded background discovery pass per reader instance against the same three
read-only metadata endpoints used by TypeScript Usher. Discovery failures do not fail power sampling.
Each request has a two-second deadline and a 1 MiB response limit. Reader shutdown cancels and joins
outstanding discovery requests before acknowledging replacement. Discovery does not run during replay;
missing hardware identity stays absent. A fresh reader instance retries discovery after a failure.
