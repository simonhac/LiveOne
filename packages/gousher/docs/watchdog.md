# Independent supervisor-evidence watchdog

`trial-watchdog` closes the gap between detecting unhealthy supervision and requesting
collector shutdown. It runs separately from the production and trial collectors,
polls a bounded authenticated health endpoint every five seconds, and latches a
shutdown for exactly one poller revision when evidence is missing or invalid.
It never enables a collector or clears a shutdown. This is implemented and tested
locally, not deployed or qualified for live device access.

## Evidence contract

The supervisor must return HTTP 200 with this JSON shape:

```json
{
  "pollerId": "REPLACE_WITH_ASSIGNED_POLLER",
  "revision": 1,
  "policyId": "REPLACE_WITH_REVIEWED_POLICY_HASH",
  "observedAt": "2026-09-13T01:26:00Z",
  "healthy": true
}
```

`observedAt` is the timestamp of the completed production-health observation. A
process heartbeat or the time an HTTP response was served cannot refresh it. The
supervisor must evaluate existing production evidence under the exact policy
identified by `policyId`; missing upstream observations must produce unhealthy or
stale evidence. Every required upstream measurement needs its own freshness check
in that supervisor. The watchdog itself cannot infer production health from this
summary. Both host clocks must be synchronized; future observations fail closed.

The response must match the configured poller, revision and policy, explicitly
report healthy, and be no older than `maxAgeSec` (5–120 seconds). Invalid JSON,
null/missing fields, HTTP errors, redirects, responses above 8 KiB and request
timeouts all trip the watchdog. Remote endpoints require HTTPS and bearer tokens;
plain HTTP is allowed only for localhost development. Redirects are refused to
avoid forwarding credentials to a different destination.

## Shutdown behavior

Before sending a stop, the watchdog writes a latch to its private persistent data
directory, keyed by poller and revision. Any existing latch—including a corrupt
one—keeps that revision stopped. The latch survives process restarts; later healthy
evidence cannot undo it. Store the directory on persistent storage and retain it
through redeployments. Loss of watchdog storage is an operational fault.

The watchdog posts `supervision-unavailable` to the existing authenticated
`/api/trial/incidents` collector handler. That handler cancels the assigned reader
and persists the disabled revision. The watchdog requires an acknowledgement with
`disabled: true` and the exact revision. It retries on every pass, even after a
successful acknowledgement. A local persistence error does not suppress the stop
request, but remains an error. `-once` exits nonzero for a latched trial even when
the stop was acknowledged; the daemon logs errors and keeps retrying.

Requests each have a three-second timeout. Shutdown gets a separate timeout even
if evidence retrieval used up its context budget. The nominal polling interval is
five seconds, but network time adds to the worst-case stop delay. Do not treat
`maxAgeSec` as a hard deadline for completed cancellation.

## Run

Copy `trial-watchdog.example.json` and supply the two separate tokens via the
configured environment variables. The watchdog needs supervisor-health read access
and trial-inspector access only, not production collector or database credentials.

```sh
go build -o trial-watchdog ./cmd/trial-watchdog
./trial-watchdog -config /etc/gousher/trial-watchdog.json -check
./trial-watchdog -config /etc/gousher/trial-watchdog.json -once
./trial-watchdog -config /etc/gousher/trial-watchdog.json
```

`-check` does not contact endpoints. `-once` can issue a real stop request. The Fly
build includes the binary; the supplied systemd unit shows a separate service user,
persistent state and automatic restart. Provision the account and matching config
paths before installing it. Run only one instance for a given configuration.
Never configure the legacy production forwarding environment for this service.

## Remaining activation gates

- Implement the supervisor adapter using existing production telemetry and/or
  LiveOne readings. The legacy `trial-ops` health files do **not** satisfy this
  evidence contract and its raw-capture metrics feed remains unavailable.
- Measure a baseline and explicitly review a replacement for the unavailable
  per-device failure-rate/p95 metrics. No replacement thresholds are approved here.
- Add a collector-side expiring permit or independently tested host-stop fallback.
  If the trial inspector is unreachable, this watchdog cannot prove the reader
  stopped. Likewise, its own death cannot issue a stop. This component alone is
  insufficient to authorize live reads or inhibit startup before the first check.
- Qualify those failure modes on trial-only infrastructure before enabling device
  routes, and retain evidence separately from replay and comparison results.

Tests use simulated health endpoints and the real collector incident handler to
check stale/missing evidence, identity/policy mismatch, timeout, cancellation,
durable collector shutdown, failed acknowledgements, watchdog restart/retry and
local storage failure. No test contacts an inverter or production hub.
