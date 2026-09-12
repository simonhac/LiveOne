# Shadow qualification record

This change prepares a trial. It does not certify a 30-day soak or production control cutover.
Keep replay qualification and independent live qualification separate for each vendor.

## Known behavior pinned for review

- Selectronic `Number()` coercion treats empty strings and booleans as numeric readings. The Go
  decoder preserves that current behavior, with a regression fixture. Fixing it is a separately
  reviewed vendor behavior change.
- Selectronic's fault-zero omission checks tails ending `/fault_code` and `/fault_ts`, while the
  current metadata uses unprefixed `fault_code` and `fault_ts`. Zero faults therefore remain in both
  replay implementations. Do not silently alter identities or omit them during this port.
- Fronius suppresses its first energy report to establish a baseline and carries fractional Wh
  through subsequent rounded reports. Its fault timestamp is a formatted local-time string despite
  the declared `epochMs` unit. Preserve that discrepancy until explicitly reviewed.
- Timestamped cloud baseline exports retain the original measurement time when supplied by the
  vendor. Their revision is the export assignment revision; pre-existing production sessions did
  not capture managed configuration revisions. Unknown session payload shapes are reported unmatched.

## Rollout gates

| Period | Required evidence |
| --- | --- |
| Days 1–7 | Four-vendor replay, offline CRUD/restart tests, real gusher integration on a disposable database, actual volume consumption |
| Days 8–14 | Gradual Fronius reads; DSE concurrent-connection test before a second reader |
| Days 15–21 | Shared cloud account session/request-budget checks; trial-only fault injection |
| Days 22–30 | Daily comparisons and seven consecutive clean days on the final build |

If a vendor cannot safely support a second reader, leave it on replay. A passing decoder fixture is
not evidence of live coexistence. Stop the affected shadow reader immediately after session eviction,
connection disruption or an attempted device write. Also stop it if production failure rate rises by
more than one percentage point, or p95 read latency doubles, in two consecutive 15-minute windows.
The current runtime stops a cloud reader on unexpected 401/session eviction; revision change is
required to resume it. The authenticated `/api/trial/windows` endpoint now enforces consecutive windows, ignores duplicate windows, cancels an in-flight read on a breach, and persists the disabled revision across restarts. `/api/trial/incidents` handles immediate session, connection and write-attempt incidents. The independent `trial-ops` runner connects production feeds to these endpoints; local end-to-end tests verify cancellation and persisted shutdown. Deployment and measured baseline configuration remain required.

## Outstanding acceptance work

- Apply the migration to the intended LiveOne environment before deployment. Migration verification
  and real gusher/point-minting/outbox integration pass against disposable PostgreSQL 18.3.
  The downstream observations materializer is outside this integration suite.
- Qualify Fronius discovery responses on the trial devices and the dedicated outbound telemetry destination.
  The state envelope, default SSE messages, DSE diagnostics, Fronius power/SOC and 20-report history,
  stale health (including readers with no first sample), authenticated duration histograms and bounded outbound OTLP/HTTP JSON export are implemented. Background discovery now supplies inverter identity and battery/meter details through bounded read-only requests; failed discovery leaves metadata absent.
- Generator API/state simulator parity is implemented and checked by shared TypeScript/Go traces:
  detailed start gates, ownership/SCF probe responses, persisted deadline and defensive boot recovery,
  origin JWT verification, serialized concurrent commands, monotonic deadline protection and fractional
  deadline wake-ups. See [control.md](control.md) for the tested scope and deliberate stricter behavior.
  Live control remains disabled; field qualification and any control cutover are separate operations.
- Enable and qualify the optional asynchronous TypeScript DSE/Fronius input capture in production.
  Hooks now preserve input order, integration timestamps, harvest boundaries, revisions and expected
  readings, within a bounded gzip journal. They remain disabled unless explicitly configured.
  Cloud baselines are available through the scoped API.
- Deploy and qualify the implemented daily export/comparison runner and independent production
  monitoring feeds. Configure measured baselines and an external stale-health watchdog using
  [automation.md](automation.md). Local tests cover feed-to-shutdown and receiver-to-daily-report
  behavior; live monitoring has not been enabled.
- Measure receiver receipt growth and backup/restore behavior in the trial environment. The bounded,
  non-expiring receipt journal now preserves acknowledgements beyond capture retention and refuses
  new IDs at capacity. Already-pruned captures from before this upgrade cannot be reconstructed.
- Live credential refresh-token/session coexistence qualification and real failure injection.
- Separate Fly machine/receiver/monitoring, authenticated hub forwarding, actual storage measurements
  in week one, month-long soak and seven clean days on the final build.

Do not call the full attached plan complete until these are checked. Extend the trial as needed.
Cutover is a separate operation: stop the old owner, exclude shadow backlog, and transfer generator
control only while idle with no latch or deadline outstanding.
