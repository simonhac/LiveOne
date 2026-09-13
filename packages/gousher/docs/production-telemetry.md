# Production telemetry and the four-vendor trial

Permanent production metrics cover Fronius and Deep Sea on Usher, and scheduled
Selectronic and Sigenergy cloud polls in LiveOne. The Go shadow collector retains
its separate `gousher.*` metrics. Telemetry creates no LiveOne energy-data points.

The trial has one shared **14-day** observation period, starting only after all
four vendors pass preflight. Require seven consecutive clean days on the final
build; extend qualification after failures or material changes. Generator control
remains with production. A successful decoder replay or VPN handshake is not live
coexistence evidence.

## Metric contract

| Metric | Type | Unit | Event or observation |
| --- | --- | --- | --- |
| `liveone.read.attempts` | Counter | `{read}` | Logical read started |
| `liveone.read.completions` | Counter | `{read}` | Logical read finished, by outcome |
| `liveone.read.duration` | Histogram | `s` | Time from start through read cleanup, excluding delivery |
| `liveone.read.last_started` | Gauge | `s` | Unix timestamp of last start |
| `liveone.read.last_completed` | Gauge | `s` | Unix timestamp of last completion |
| `liveone.read.last_success` | Gauge | `s` | Unix timestamp of last successful completion |
| `liveone.data.last_measurement` | Gauge | `s` | Latest valid live measurement in the bounded export |
| `liveone.data.last_received` | Gauge | `s` | Latest receipt of a valid live measurement in that export |
| `liveone.data.coverage` | Gauge | `1` | Occupied valid reporting slots / expected slots |
| `liveone.data.observed_at` | Gauge | `s` | Completion time of the successful data observation |
| `liveone.trial.supervision.healthy` | Gauge | `1` | Every required check passed (1), otherwise 0 |
| `liveone.trial.supervision.evidence_at` | Gauge | `s` | Oldest current read-metric/data observation supporting the decision |
| `liveone.trial.shutdown.requests` | Counter | `{request}` | Watchdog shutdown requests, including retries |

Read attributes: `service`, `environment`, `vendor`, `device.id`, `reader.id`,
plus `service.instance.id` duplicated from the resource so concurrent serverless
processes have distinct cumulative series even if resource labels are not exposed.
Completions and duration add `outcome` (`success`, `partial`, `error`, `cancelled`).
Unsuccessful completions additionally carry `error.type`: `timeout`, `connection`,
`authentication`, `rate_limit`, `invalid_response`, `device_error`, `cancelled`, `other`.
Raw messages, credentials, addresses, site names and serials are never labels.

Data observations add `point.id`. Supervision carries `poller.id`, `revision` and
`policy.id`; shutdown requests add `reason`. Resources carry `service.name`,
`service.version` and `service.instance.id`. Set `SERVICE_VERSION` for standalone
deployments; Vercel commit/Fly image identity is used when available.

Timestamps advance only on their events. They are absent before the first event.
Repeated exports of an old timestamp do not refresh the event. Read state is capped
at 512 identities per process; exceeding the cap yields missing telemetry and must
not be interpreted as healthy. Cloud process counters start anew on cold start.

Histogram upper boundaries in seconds: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
1, 2.5, 5, 10, 30, 60, 120`, plus overflow. Compute p95 from merged bucket counts,
never by averaging percentiles. Failure rate is `(partial + error) / (success +
partial + error)`; cancellation is separate. An empty window is insufficient evidence.

### Synthetic acceptance examples

Use synthetic UUIDs and a non-production source for these checks:

- A first read starts at Unix time `1800000000` and times out at `1800000030`:
  attempts = 1, completions = 1 (`error`, `timeout`), duration = 30 seconds,
  last_started = `1800000000`, last_completed = `1800000030`, and last_success
  remains absent. A hung second read increments attempts and last_started only
  until it actually completes or acknowledges cancellation.
- In a window containing 90 successes, 5 partials, 5 errors and 2 cancellations,
  the failure rate is `10 / 100 = 10%`. Cancellation durations remain queryable
  separately and are excluded from the qualification distribution.
- In separate processes, cumulative completion counts `10 → 12` and `4 → 7`
  contribute five new completions. A restarted process with count 1 contributes
  one more, not a negative delta. Verify the backend handles process identity,
  cumulative start timestamps and repeated exports before combining streams.
- At a 60-second reporting cadence, 100 samples confined to three slots of a
  completed 15-minute window give coverage `3 / 15 = 0.2`. Repair arrivals do
  not fill those live slots. A failed export observation leaves observed_at
  unchanged; a successful empty observation gives zero coverage and no invented
  measurement or receipt timestamp.
- For a histogram with 100 samples, 90 in buckets at or below one second and
  ten in the `(1, 2.5]` bucket, a backend using linear bucket interpolation
  estimates p95 as 1.75 seconds. Check the backend's actual interpolation and
  overflow behavior; never average this percentile with another stream's p95.
- A Sigenergy live fetch that refreshes once and succeeds records one success.
  A recognized vendor rate-limit response records one `error` / `rate_limit`,
  including when HTTP status is 200. A historical-statistics request records no
  live attempt. Three successful live reads still fail a 20-sample evidence gate.

## Instrumentation boundaries

- Fronius: each configured inverter's power-flow fetch, not site harvests or metadata discovery.
- Deep Sea: scheduled collection including mutex wait, connection, register reads
  and cleanup. Page/field errors count as partial, unsupported sentinels alone do
  not. Control/probe reads do not count as scheduled telemetry.
- Selectronic/Sigenergy: scheduled live vendor fetches after scheduling admits them;
  authentication and existing retries are included. Dry runs, manual reads,
  historical statistics and repair/backfill jobs are excluded.
- Sigenergy: HTTP 429 and recognized vendor rate-limit errors classify as
  `rate_limit`; login/refresh failures classify as `authentication`, even if the
  HTTP status itself is 200. The trial minimum remains 300 seconds.

Read hooks update memory only. Flyhub uses its existing 60-second exporter, with
bounded export timeouts. LiveOne registers a bounded flush with Next's `after()`
inside the request. Export failure cannot change the read result or create a disk
queue. Existing runtime, disk and spool instruments retain their names and behavior.

## Configuration

Flyhub keeps `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_METRICS_ENDPOINT`. Supply
opaque UUIDs in its private source configuration (no need to alter device addresses):

```yaml
# Deep Sea source entry
telemetry:
  deviceId: 11111111-1111-4111-8111-111111111111
  readerId: 22222222-2222-4222-8222-222222222222
# Fronius: place a telemetry object on EACH inverter entry instead.
```

Use the assigned device UUID for `deviceId`; mint a stable reader UUID per physical
inverter/controller. Missing/invalid optional telemetry identities disable those
metrics without stopping production. Verify identities are unique before rollout.
Cloud readers use the existing device UUID for both identifiers, with no extra DB
lookup. Private configuration must map the same IDs into observer targets.

LiveOne uses `LIVEONE_METRICS_ENDPOINT` and `LIVEONE_METRICS_TOKEN`, scoped to the
appropriate deployment environment. The independent supervisor and watchdog use
`GOUSHER_METRICS_ENDPOINT` and `GOUSHER_METRICS_TOKEN` for their dedicated source.
Endpoints must be the source-specific Better Stack ingesting hosts.

## Independent observer and baseline

Copy `production-supervisor.example.json` outside the repository and replace its
synthetic identities. Supply the collector's scoped token and read-only Better
Stack SQL connection username/password through the configured environment variables.
Better Stack query credentials are distinct from ingest tokens.

```sh
# Repository root; no device requests are made by this command.
npx tsx scripts/gousher/production-supervisor.ts /private/supervisor.json --once
npx tsx scripts/gousher/production-supervisor.ts /private/supervisor.json
```

For a dedicated Linux operations host, install the repo and npm dependencies at
`/opt/liveone`, create the service account, private config/environment files and
persistent state directory, then use `deploy/production-supervisor.service`. It
requires Node 22 and starts independently of both production and trial collectors.
A reverse proxy supplies HTTPS for its loopback health endpoint.

Without `policyPath`, this is baseline-only: the health endpoint always refuses
activation. It observes every 30 seconds after the previous pass, journals private
JSONL evidence (64 MiB / 45 daily files), and publishes data metrics. Archive the
baseline before hitting the size budget. A single-process lock prevents concurrent
writers; after a crash inspect the process/state before removing the stale lock.

Data observation uses `/api/collectors/me/readings` with fixed cutoff, revision,
point and scope validation across at most eight 1000-row pages / 20 seconds. The
export now adds nullable `sessionCause`, through a bounded session join in
ReadingsDao. Only `good` finite values from configured live causes count (`PUSH`
for LAN collection, `CRON` for cloud). Missing session provenance is unqualified.
Coverage uses the latest completed UTC 15-minute window after 120 seconds of
settling, with slots based on **reporting** cadence. Bursts cannot fill gaps.
Receipt and measurement timestamps remain distinct. Queries also cover the period
after that window through the fixed cutoff for freshness. Events older than this
bounded lookback are absent, not reconstructed from a heartbeat.

The SQL adapter uses the documented Better Stack metric schema, validated source
identifiers and exact production/vendor/device/reader/service filters. Histogram
counts stored by Better Stack are deltas; it merges them for sample counts, failure
rate and p95. It independently checks recent timestamps from all three read gauges.
Statistical windows are aligned and complete, with the same 120-second settling.

**Backend verification is a deployment gate:** send synthetic successes/errors,
known durations, concurrent instances and a process restart to a test source;
verify label retention, bucket counts, percentile results, counter-reset handling
and missing-data behavior. The queries are not certified against a live account
merely because local fake-server tests pass. See [Better Stack SQL API](https://betterstack.com/docs/logs/query-api/connect-remotely/)
and [histogram queries](https://betterstack.com/docs/logs/querying-histograms/).

## Reviewed policy and activation

After 24–48 hours of production-only baseline, create a private policy JSON with
`version: 1`, `backendVerified: true`, `baselineStart`, `baselineEnd`, and `targets`.
Each target repeats its observer/source identity and explicitly supplies:

- `readCadenceSec` (distinct from `cadenceSec`, which is reporting cadence).
- `statWindowSec` (900–21600, divisible by 900), `minimumSamples` (at least 20).
- `maxFailureRate`, `maxP95Sec` (seconds), `maxMetricAgeSec` (60–120).
- `maxReadAgeSec`, `maxDataAgeSec`, `minimumCoverage`.

There are no approved default thresholds. Set them from retained baseline evidence,
with explicit review. Slow readers need larger statistical windows: at five-minute
cadence Sigenergy cannot supply 20 samples in 15 minutes. At two hours it can supply
24. This longer statistical window does not relax immediate freshness checks.

Set `policyPath` in the supervisor config. Its SHA-256 over exact policy bytes is
the `policyId`; use it in the watchdog config and collector bootstrap
`trialPermitPolicyId`. Policy changes require a new managed revision. The supervisor
persists consecutive statistical-window decisions before exposing healthy evidence.
Two distinct consecutive breaches fail health; duplicate queries do not advance
the count. Missing, stale, malformed or insufficient inputs fail immediately.

Serve `/health/POLLER_UUID` on the supervisor's loopback port, behind authenticated
HTTPS for the remote watchdog. Never expose it as an unauthenticated public port.
The endpoint preserves actual observation timestamps when serving cached evidence.
Deploy the supervisor and watchdog separately from both collectors.

The watchdog validates evidence every five seconds, then obtains the collector's
boot challenge and renews a permit for at most 15 seconds, further capped by evidence
expiry. A renewal error latches shutdown. New inspector endpoints:

- `GET /api/trial/permit-state`: authenticated boot ID and policy identity.
- `POST /api/trial/permits`: inspector-authenticated `pollerId`, `revision`,
  `policyId`, `bootId`, `expiresAt`; expiry must advance and be within 30 seconds.

Permits are memory-only and use monotonic local deadlines. Startup waits for a new
permit; cached configuration never grants permission. Expiry cancels the reader
and background discovery, persists `supervision-unavailable`, and cannot be undone
by late healthy evidence. A new revision is required. Expiry checking runs at most
50 ms apart while the process is scheduled; actual cancellation also depends on
transport/process scheduling. Fault-test that bound on the deployment host.

## Qualification record

Before starting the common trial clock, retain:

1. Four-vendor replay/integration results and production telemetry overhead results.
2. Backend synthetic verification and the measured production baseline/policy.
3. Trial-only evidence-loss, watchdog-death, inspector-loss, restart and persistence-failure tests.
4. Fronius low-rate coexistence followed by target cadence; the managed validator
   now allows intervals of at least two seconds for gradual qualification.
5. Deep Sea concurrent-reader coexistence without starting the generator for the
   test. If natural running-state evidence is absent, record that limitation.
6. Selectronic and Sigenergy session coexistence, refresh/re-login behavior and
   combined request budgets. If either cannot support another reader, it remains
   unqualified and the shared four-vendor clock does not start.

Then record a single shared start, deployed build/revisions, daily comparison and
health reports, and seven clean final-build days. The 14-day trial and production
cutover are separate decisions; this implementation does not certify either.
