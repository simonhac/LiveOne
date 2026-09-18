# Shadow qualification record

This change prepares a trial. It does not certify a 14-day shared trial or production control cutover.
Keep replay qualification and independent live qualification separate for each vendor.

## Current operational plan

The current [four-vendor telemetry and rollout contract](production-telemetry.md)
supersedes the historical 30-day schedule and permits permanent bounded production
read metrics. All four vendors must pass preflight before the common clock starts.

Follow [the isolated trial plan](isolated-trial.md). Production hub instrumentation
and forwarding were disabled after production degradation; the Go collector and ops
staging machines are stopped. Existing fixture-based automation is not yet suitable
for independent readings comparisons. Historical gates below do not authorize reactivation.

## Known behavior pinned for review

- Selectronic `Number()` coercion treats empty strings and booleans as numeric readings. The Go
  decoder preserves that current behavior, with a regression fixture. Fixing it is a separately
  reviewed vendor behavior change.
- Selectronic's fault-zero omission branch has been REMOVED from the TypeScript adapter (the event
  work, September 2026). It checked tails ending `/fault_code` and `/fault_ts` while the metadata
  uses the unprefixed `fault_code` and `fault_ts`, so it never matched and zero faults were written
  all along — which turns out to be the correct behaviour, because the zero is what clears a
  previous fault. Both implementations still emit the zero; only the dead branch is gone.
- 🛑 **Selectronic `fault_ts` diverges between the two implementations.** The TypeScript adapter now
  converts the vendor's Unix SECONDS to the epoch MILLISECONDS the point declares, and falls back to
  the Select.live Events page's newest *Created* time when the polled field is zero (a sticky "last
  fault time"). The Go leg still passes the raw seconds through and has no events leg at all, so a
  value comparison on `fault_ts` will differ by a factor of 1000 and by presence. Port it before the
  shared trial reaches that field; see `lib/vendors/selectronic/diagnostics.ts`.
- Fronius suppresses its first energy report to establish a baseline and carries fractional Wh
  through subsequent rounded reports. Its fault timestamp is a formatted local-time string despite
  the declared `epochMs` unit. Preserve that discrepancy until explicitly reviewed.
- Timestamped cloud baseline exports retain the original measurement time when supplied by the
  vendor. Their revision is the export assignment revision; pre-existing production sessions did
  not capture managed configuration revisions. Unknown session payload shapes are reported unmatched.

## Rollout gates

| Period | Required evidence |
| --- | --- |
| Before day 1 | Four-vendor replay/integration, telemetry backend verification, 24–48-hour production baseline, reviewed thresholds, permit-failure tests and all four coexistence preflights |
| Days 1–14 | One shared observation window; daily health and value/coverage comparisons for all four vendors |
| Final seven days | Seven consecutive clean days on the final build; extend the trial after failures or material changes |

If a vendor cannot safely support a second reader, leave it on replay. A passing decoder fixture is
not evidence of live coexistence. Stop the affected shadow reader immediately after session eviction,
connection disruption or an attempted device write. Also stop it if production failure rate rises by
more than one percentage point, or p95 read latency doubles, in two consecutive 15-minute windows.
The current runtime stops a cloud reader on unexpected 401/session eviction; revision change is
required to resume it. The authenticated `/api/trial/windows` endpoint now enforces consecutive windows, ignores duplicate windows, cancels an in-flight read on a breach, and persists the disabled revision across restarts. `/api/trial/incidents` handles immediate session, connection and write-attempt incidents. The independent `trial-ops` runner connects production feeds to these endpoints; local end-to-end tests verify cancellation and persisted shutdown. Deployment and measured baseline configuration remain required.

## Outstanding acceptance work

- Management migration 0067 and collector enrollment are deployed in LiveOne. Real
  gusher/point-minting/outbox integration also passes against disposable PostgreSQL 18.3;
  the downstream observations materializer remains outside that integration suite.
- Qualify Fronius discovery responses on the trial devices and the dedicated outbound telemetry destination.
  The state envelope, default SSE messages, DSE diagnostics, Fronius power/SOC and 20-report history,
  stale health (including readers with no first sample), authenticated duration histograms and bounded outbound OTLP/HTTP JSON export are implemented. Background discovery now supplies inverter identity and battery/meter details through bounded read-only requests; failed discovery leaves metadata absent.
- Generator API/state simulator parity is implemented and checked by shared TypeScript/Go traces:
  detailed start gates, ownership/SCF probe responses, persisted deadline and defensive boot recovery,
  origin JWT verification, serialized concurrent commands, monotonic deadline protection and fractional
  deadline wake-ups. See [control.md](control.md) for the tested scope and deliberate stricter behavior.
  Live control remains disabled; field qualification and any control cutover are separate operations.
- Replace production raw capture with a scoped LiveOne readings export and interval-based
  comparison outside the hub, as specified in [the isolated trial plan](isolated-trial.md).
- Qualify existing production telemetry/logs for independent supervision, explicitly resolve
  unavailable per-read metrics, and verify an external stale-health watchdog and shutdown path.
- Measure receiver receipt growth and backup/restore behavior in the trial environment. The bounded,
  non-expiring receipt journal now preserves acknowledgements beyond capture retention and refuses
  new IDs at capacity. Already-pruned captures from before this upgrade cannot be reconstructed.
- Live credential refresh-token/session coexistence qualification and real failure injection.
- Separate Fly machine/receiver/monitoring, an independent site network path, actual storage measurements
  in week one, 14-day shared trial and seven clean days on the final build.

Do not call the full attached plan complete until these are checked. Extend the trial as needed.
Cutover is a separate operation: stop the old owner, exclude shadow backlog, and transfer generator
control only while idle with no latch or deadline outstanding.

## First vendor selected

Fronius is the first selected vendor (2026-09-13). Site identities, network configurations
and operator runbooks are maintained outside this repository in private administration records.
Management API deployment and enrollment are complete. The original production hub is back
on its normal configuration. No live Go trial has begun; activation now depends on the isolated
reference export, comparison, network and supervision gates above.
