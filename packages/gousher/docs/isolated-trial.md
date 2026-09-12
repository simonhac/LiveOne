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
