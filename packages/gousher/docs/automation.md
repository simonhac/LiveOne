# Independent trial operations

> **Fronius trial suspended:** the production capture/feed and hub-forwarding design
> is superseded by [the isolated trial plan](isolated-trial.md). Do not activate
> the former Fronius setup below. The implementation reference remains for review.

`trial-ops` runs separately from the shadow collector. It polls production evidence every 30 seconds,
posts incidents and completed 15-minute windows to the collector shutdown APIs, and compares each
full UTC day after 02:00 UTC. Comparison work runs every ten minutes independently of monitoring.
This implements trial automation; it is not evidence of deployed monitoring or a completed soak.

## Configuration and baseline

Copy `trial-ops.example.json` to a private configuration file. Replace all identifiers, endpoints,
dates and baseline metrics. Its zero-sample baseline intentionally fails validation. Secrets are
read from the named environment variables. Use HTTPS; plain HTTP is permitted only for local tests.
The receiver URL ends in `/export`; the inspector URL is the collector origin.

| Production source | Reference URL | Metrics URL | Authentication |
| --- | --- | --- | --- |
| DSE / Fronius Usher | `/api/usher/trial` | `/api/usher/trial` | Dedicated `USHER_TRIAL_MONITOR_TOKEN` |
| Selectronic / Sigenergy LiveOne | `/api/collectors/me/baseline` | `/api/collectors/me/production` | Collector token scoped to the assigned poller |

For Usher, configure `USHER_TRIAL_MONITOR_TOKEN`, `USHER_TRIAL_CAPTURE_DIR` and
`USHER_TRIAL_CAPTURE_REVISION` in the production process. `productionSiteId` is its Usher site ID;
`id` is the managed shadow poller ID. Capture revisions must match the configured trial revision.
A restart loses the in-memory monitoring window history: wait for a full baseline window after
startup. Missing or evicted incident history is reported unavailable, not as an empty incident list.

For LiveOne, explicitly enable `LIVEONE_TRIAL_READ_EVIDENCE=1` and set
`LIVEONE_TRIAL_READ_EVIDENCE_SINCE` to the actual activation timestamp (ISO 8601).
Set `productionSiteId` to the vendor site ID and `evidenceLagSec` to at least 120 so completed
sessions can settle. Metrics include only marked CRON reads, measured around the vendor fetch;
old session durations and historical imports are not substitutes. The feed rejects windows before
the activation timestamp. Evidence is stored in the existing session response JSON; this addition
requires no new schema migration.

Before enabling shadow reads, obtain a representative complete production window from the metrics
URL with authenticated GET parameters `kind=window`, `pollerId`, `revision`, `siteId`, `start`, `end`.
Use a 15-minute UTC-aligned window. Copy its measured `samples`, `failureRate` and `p95ReadMs` into
`baseline`; set `baselineEnd` to that window's end. Set `from` at or after `baselineEnd` and choose
`minSamples` appropriate to the production read cadence. Baseline values must describe the same
read operation and source as subsequent windows. For cloud feeds, allow the two-minute settlement
interval before querying. Keep monitoring active throughout coexistence qualification.

## Run and supervise

From `packages/gousher`:

```sh
go build -o trial-ops ./cmd/trial-ops
./trial-ops -config /etc/gousher/trial-ops.json -check
./trial-ops -config /etc/gousher/trial-ops.json -once
./trial-ops -config /etc/gousher/trial-ops.json
```

`-check` validates configuration and token presence without network calls. `-once` performs one
monitoring/comparison pass; it may have no daily report due yet. For a service, install
`deploy/trial-ops.service`, create the dedicated service user, install the binary and supply the
private environment/configuration files named there. The service owns its persistent data directory.
The container build also includes `/usr/local/bin/trial-ops`; run it on a separate machine/process
with its own volume and entrypoint, independent of the shadow collector.

Have an external watchdog run this at least once a minute and alert on failure:

```sh
trial-ops -config /etc/gousher/trial-ops.json -health
```

Health fails for missing, failed or stale passes (monitor: two minutes; comparison: twenty minutes).
Process uptime alone does not establish coverage. Missing evidence does not fabricate a shutdown
breach: it makes monitoring unhealthy and requires operator investigation. Typed 401/session
and connection-reset/refused signals are collected; this is not exhaustive detection of every vendor
session or connectivity failure. Other independent detectors can submit supported incidents to
`/api/trial/incidents`, including attempted device writes.

Acknowledged monitor cursors survive restarts; failed delivery retries without advancing. Monitoring
catches up at most four windows per assignment per pass. Configuration fingerprints reject changing
baselines or endpoints silently within a revision. Shutdown persists for the affected revision;
resume only after review and an intentional assignment revision change.

## Daily reports and retained evidence

Daily work starts with the first full UTC day on or after `from`, and catches up one day per
assignment per pass. It exports hourly pages from production and the receiver with fixed `asOf`
values per export. References use expected readings from the production TypeScript implementation.
Missing hours, mismatches and unmatched samples make a day nonclean; differing collection cadences
can therefore produce unmatched samples. This checks observed evidence, not a complete sample
manifest: absence from both feeds is not proof that every expected read occurred.

Reports and scheduler checkpoints persist in `dataDir`. Failed export or retention does not advance
the day. Completed nonclean reports advance the day but keep health unhealthy and reset the clean-day
count. Historical review counts remain unhealthy until addressed through a reviewed new trial revision;
there is no automatic review-clear operation. Investigate gaps rather than deleting checkpoints.

At most 20 selected differences are retained per report, with up to 200 captured context samples
from the preceding five minutes. Selection is bounded to 8 MiB and the retained fixture budget is
16 MiB; budget exhaustion is an error. Reports include unselected counts. Fronius energy replay may
need earlier integration state, so retained context is comparison evidence, not a promise of a
self-contained replay fixture. Exports have payload and sample caps; oversized days require review.
Run daily exports before the receiver's three-day capture retention expires.

## Receiver receipts

Captures retain their 128 MiB / 72-hour limits. The separate `.receipts/journal` retains acknowledged
ID/content hashes without age eviction: 88 bytes each, with a 32 MiB hard cap (about 381,000 receipts).
At capacity, new IDs are refused; known identical retries remain acknowledged. Conflicting payloads
are rejected, and exported captures must match their receipt hashes. Corrupt complete receipts or
missing existing journal history fail closed. An incomplete unacknowledged tail is recoverable.

Retained legacy captures are imported on upgrade. IDs whose captures were already pruned before
upgrade cannot be recovered. Back up the journal with the receiver state and monitor its growth;
do not delete it to reclaim space. A larger receipt budget requires an explicit reviewed change.
