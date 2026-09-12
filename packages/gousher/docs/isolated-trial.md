# Trial without production hub instrumentation

This supersedes the Fronius production-capture and hub-forwarding setup. The original
`liveone-flyhub` remains responsible only for its existing production work. Do not enable
trial capture, trial monitoring feeds, SSH forwarding or additional listeners there.
The Go collector and ops staging machines remain stopped until the gates below pass.

## Production recovery

The normal production configuration was restored on 2026-09-12 at about 22:27 UTC.
At 22:39:49 UTC both inverter samples were less than two seconds old, both source
loops had zero consecutive errors, Fronius uploads succeeded, the generator supervisor
was idle/unlatched without a deadline, and the delivery spool was empty. The most recent
100 log lines contained no device-fetch, tick, telemetry-export or background-drain
errors. These are recovery observations, not evidence of a completed long soak.

## Separate the two verification questions

1. **Same-input correctness:** run TypeScript and Go against shared saved fixtures and
   simulators, entirely outside production. Check parsing, units, signs, missing fields,
   energy integration, startup/reset behavior, retries and delivery. Preserve the existing
   control simulator tests; live generator control stays disabled.
2. **Independent live behavior:** compare the Go collector's separately stored output with
   readings already received by LiveOne. Different sampling times are expected. This tests
   coverage, trends, energy totals and operational reliability; it cannot prove that both
   implementations interpreted an identical raw response identically.

No production raw recorder is required for either stage. Investigate discrepancies using
retained trial-side inputs and isolated reproductions. A trial-side raw input is not evidence
of what the production collector saw at that instant.

## Production reference export

Implement the export in LiveOne or a separate read-only worker using its established
ReadingsDao access boundary. Do not add work to the hub's collection or delivery path.
Scope access to the assigned device and bounded time pages; do not give the trial runner
an administrator credential or unrestricted database credential.

Export stable point identity/physical path, metric type, unit, measurement timestamp,
value and relevant transform semantics. Preserve a fixed cutoff for each export and record
point metadata with the report. Distinguish absent data from a numeric zero.

The existing admin device point-readings route confirms these readings are available,
but it is not a drop-in trial feed: it requires admin access, supports display transforms
and has pagination semantics that need explicit adaptation. Verify energy storage semantics
before comparing cumulative counters with increments; never difference or sum blindly.

## Comparison contract

- Join points by explicit device/physical-path mappings and validated units, not display names.
- Report expected cadence, observed coverage, duplicates, timestamp gaps and arrival lag
  separately from value differences. Missing on both sides is still a coverage gap.
- Compare power and SOC over aligned UTC windows with documented aggregation and coverage
  requirements. Never treat an unmatched two-second sample as an implementation failure.
- Compare energy over common interval boundaries; exclude each collector's startup baseline
  and flag resets. Account for rounding and partial intervals explicitly.
- Set numerical tolerances before qualification using fixture error bounds and observed
  normal variability. Do not choose thresholds retrospectively to make results pass.
- Retain source exports, point mappings, report version and trial-side discrepancy fixtures
  in trial storage. Keep replay results separate from live comparison results.

The existing trial-ops fixture comparator cannot be enabled unchanged: it expects production
raw fixtures and close sample matching. A readings exporter and interval comparator are
required, with tests for shifted timestamps, gaps, resets, unit/sign mismatches and pagination.

## Independent access and supervision

Provision a dedicated trial route to Kinkora that does not traverse or require changes to
`liveone-flyhub`. A separately configured site VPN peer or site-side trial machine is a
candidate, subject to actual network configuration and credentials. No route is qualified yet.
Restrict destinations to the two Fronius HTTP endpoints; enforce read-only requests and budgets.
No DSE reads or generator control are part of this first live stage.

Use the hub's existing exported telemetry, existing logs and LiveOne arrival/freshness data
for production supervision. Run the supervisor and its stale-health watchdog separately from
both collectors. Prove stale/missing supervisor evidence stops or inhibits the trial; process
uptime alone is insufficient. Test shutdown with trial-only fault injection.

The old failure-rate/p95 gate used the now-disabled trial feed. Do not substitute minutely
harvest duration or upload success for per-inverter read latency. Inventory existing telemetry
first. If those exact measurements are unavailable, record the gap and approve a replacement
qualification gate before enabling live reads; do not fabricate a baseline or silently waive it.

## Execution order and activation gate

1. Confirm recovery and empty spool using existing production surfaces (observed above).
2. Implement and test the bounded LiveOne reference export and interval comparisons.
3. Configure the independent network path and supervisor using existing production evidence.
4. Validate replay and trial-only delivery/restart/shutdown failures with no device traffic.
5. Establish a representative production baseline and predeclare coverage/value/health gates.
6. Start low-rate, read-only Fronius qualification; stop on production deterioration or missing
   supervision. Increase cadence only after coexistence is demonstrated.
7. Run daily reviews, the month-long trial and seven consecutive clean days on the final build.

Device coexistence still matters even with a separate network path: both readers ultimately
share the same inverters and site network. No existing successful fixture test waives that gate.

## Implemented reference export and offline comparison

`GET /api/collectors/me/readings` uses the existing collector bearer credential.
It checks the active assignment, its revision and ownership of the requested point;
there is no administrator or arbitrary device access. A paused assignment can export
reference data without starting device reads. The endpoint reads through ReadingsDao.

Required query parameters: `pollerId` (UUID), `revision`, `pointId` (point UUID),
`start`, `end`, `asOf` (UTC ISO timestamps). Windows are half-open, at most one hour,
and must end no later than the fixed past ingestion cutoff. Optional `limit` is
1–1000 (default 500); `cursor` is the exact `nextCursor` from the preceding page.
Preserve the same parameters across pages. Paging uses the full microsecond timestamp,
not a JavaScript millisecond round-trip. The response contains raw untransformed
values, quality/error fields, receipt and ingestion times, session identity and point
metadata. No rows is an empty array; a missing numeric value remains null.

The cutoff excludes subsequently ingested rows. It is **not** a database snapshot:
retention or in-place corrections may affect later reads. Retain exported pages as
immutable evidence, wait for normal delivery to settle, and repeat suspect exports.
Point metadata is current export-time metadata, not historical metadata. The downloader
rejects metadata changes between pages; it cannot reconstruct historical configuration.

Save an export (the output directory must not already exist):

```sh
# Supply LIVEONE_COLLECTOR_TOKEN through the runner's secret environment.
npx tsx scripts/gousher/export-readings.ts https://liveone.energy \
  POLLER_UUID REVISION POINT_UUID \
  2026-09-13T00:00:00Z 2026-09-13T01:00:00Z .context/reference-hour
```

Only directories with `complete.json` are complete exports. This command has not
been run against production as part of implementation; the endpoint needs deployment.

`npx tsx scripts/gousher/compare-readings.ts input.json > report.json` compares
explicitly mapped series offline and exits 1 for differences or insufficient evidence.
The input contains `start`, `end`, `windowMs`, `minimumCoverage`, `absoluteTolerance`,
`relativeTolerance`, and `reference`/`trial` objects. Each series contains `deviceId`,
`physicalPath`, `metricType`, `unit`, `transform`, `cadenceMs` and `samples`.
Samples contain `timestamp`, numeric-or-null `value`, optional `receivedTime`,
`sessionId`, `counterEpoch`, `error` and `dataQuality`. Assemble reference samples from retained
pages and trial samples from the separate receiver; retain this input with the report.
The retained-export adapter described below assembles this input; scheduled review is not wired up yet.

Supported metrics are power (W), SOC (%) and cumulative energy (Wh, transform `d`).
The two sides must declare matching unit/transform semantics. Power/SOC use the mean
of occupied cadence-slot means in each UTC window. Coverage is occupied valid slots
out of expected slots, so bursts cannot fill missing slots. Energy differences use
common boundaries, linearly interpolated only across gaps of at most 1.5 cadences;
startup extrapolation, falling counters and explicit counter-epoch changes invalidate the window.
Ingestion session IDs are per-upload identities and do not identify counter resets.
The current exports have no counter epoch: a reset that catches up between samples
cannot be detected from values alone. This remains a limitation of live energy evidence.
Incremental energy is deliberately unsupported until its interval semantics are verified.
Windows must be complete, UTC-aligned and divisible by both cadences. Duplicate
millisecond timestamps invalidate qualification. Reports include arrival lag (unknown
when receipt times are absent), maximum gaps, coverage, duplicates, resets and value
differences separately. Missing on both sides never passes.

Tolerance is `absoluteTolerance + relativeTolerance * abs(reference)` and is supplied
before comparison. No default qualification thresholds are asserted. This offline
report does not establish coexistence, supervisor health, or permission to activate
live reads. Independent networking, production baseline and supervision gates above
remain outstanding.

### Comparing retained reference and receiver exports

The existing trial receiver `/export` supplies batches in receipt-file order, with
an immutable cutoff across pages. Download using its separate receiver credential:

```sh
# Supply GOUSHER_RECEIVER_TOKEN through the runner's secret environment.
# Use the same AS_OF cutoff saved in the reference export's complete.json.
npx tsx scripts/gousher/export-trial.ts https://RECEIVER_HOST/export \
  POLLER_UUID REVISION SITE_ID \
  START END AS_OF .context/trial-hour
npx tsx scripts/gousher/compare-exports.ts policy.json \
  .context/reference-hour .context/trial-hour .context/comparison-hour
```

All output directories must be new. The comparison command requires complete
manifests and validates page order, continuation markers, assignment, revision,
point identity, physical paths, units, transform semantics and cutoff consistency.
A missing trial point contributes null; ambiguous repeated paths are rejected.
It writes `input.json`, `report.json` and `sources.json` with SHA-256 hashes of the
policy, manifests and pages. Keep the original directories with these outputs.
The receiver does not export per-batch receipt times, so trial arrival lag is
unknown; export time is never substituted for arrival time.

The policy JSON contains:

```json
{
  "pollerId": "11111111-1111-4111-8111-111111111111",
  "revision": 2,
  "vendorSiteId": "REPLACE_WITH_ASSIGNED_SITE",
  "deviceId": "22222222-2222-4222-8222-222222222222",
  "pointId": "33333333-3333-4333-8333-333333333333",
  "referencePath": "REPLACE_WITH_PRODUCTION_PHYSICAL_PATH",
  "trialPath": "REPLACE_WITH_TRIAL_PHYSICAL_PATH",
  "metricType": "power",
  "unit": "W",
  "transform": "n",
  "start": "2026-09-13T00:05:00Z",
  "end": "2026-09-13T00:55:00Z",
  "windowMs": 300000,
  "referenceCadenceMs": 60000,
  "trialCadenceMs": 60000,
  "minimumCoverage": 1,
  "absoluteTolerance": 0,
  "relativeTolerance": 0
}
```

These zero-tolerance example values are placeholders, not qualified live thresholds.
Set cadence to the exported **reporting** cadence, not the two-second device read
cadence. For cumulative energy, export extra readings before and after the comparison
range so both interval boundaries are supported; for example compare 00:05–00:55
using 00:00–01:00 exports. The comparison tool never extrapolates a missing boundary.
Exporting a whole hour and comparing its final boundary without following data will
correctly leave that energy window unqualified.
