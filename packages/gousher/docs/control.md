# Generator simulator qualification

Generator control remains unavailable in the replay/shadow collector. Its public control routes
return a trial refusal, and Modbus rejects every write function before connecting. None of this
qualification enables a live controller or changes TypeScript Usher's ownership.

## Shared contract

`tools/control-traces.ts` executes the real TypeScript `RunSupervisor` against a simulator with an
injected clock and temporary control files. It generates `testdata/control-traces.json`, consumed by
Go's `TestSharedTypeScriptControlTraces`. A Jest test independently reruns TypeScript and checks that
the committed results have not drifted. CI runs both sides and type-checks the trace generator.

The 22 scenarios compare complete request/probe results, status, synthetic readings, transition
state and start/stop counts. They cover starts, extensions, release attribution, panel lockouts
(including unreadable mode), external runs, controller/hub cool-down, unsupported control functions
in probes, unreadable controllers, ambiguous starts, failed stops, fractional remaining time,
invalid runtimes, future/overdue deadlines across restart and defensive missing/corrupt-state recovery.

`Ownership.wire` supplies nullable mode/engine-state fields and actual SCF support/map data. Start
uses a fresh ownership read and the same refusal clauses as TypeScript; the target's `Start` method
owns SCF verification, as TypeScript musher does. Stop never depends on a controller read. Probe
is read-only and does not overwrite the last poll observation.

`OpenSupervisor` reads persisted state; call `Resume` before accepting simulator requests. `Run`
calls `Resume` and supervises deadlines until cancellation. Missing/corrupt state causes a defensive
release and a mode read; Stop mode is reported without selecting Auto. A future persisted deadline
is preserved; an overdue deadline or persisted failed release is retried. Boot recovery is tested
through the trial Modbus transport to prove that even this path cannot write to a real device.

## Concurrency and time

A cancellable operation gate serializes requests, probes, resume and deadline reconciliation.
HTTP actions and status snapshots are captured within that operation, so simultaneous requests
cannot both report a fresh start or return another command's status. Tests issue 24 concurrent starts,
cancel requests queued behind a blocked probe and reconcile an overdue deadline behind a probe.
All injected targets must honor context cancellation; HTTP operations have a 12-second deadline.

Wall deadlines and a process-local monotonic backstop are checked independently. The monotonic
clock is reset on process restart, when the persisted absolute instant is authoritative. The run
loop wakes at new/extended fractional deadlines and retains a periodic reconciliation backstop.
Tests cover a backward wall-clock step and an actual fractional deadline in the running loop.

## Origin authentication

`SimulatorHandler` reads `CF_ACCESS_TEAM_DOMAIN` (hostname only) and `CF_ACCESS_AUD` when constructed.
Both unset allows local passkey-only simulator tests. If either is set, both must be valid; incomplete
configuration returns 503. `SimulatorHandlerWithAccess` allows an explicitly configured verifier,
including a private test HTTPS client; a nil verifier refuses requests.

Verification follows the [Cloudflare Access origin JWT contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):
read `Cf-Access-Jwt-Assertion`, verify the signature and require the configured issuer and audience.
The implementation uses `golang-jwt/jwt/v5` with RS256 restricted explicitly, requires expiration,
and checks not-before when present. It also requires the device passkey after JWT verification.

Keys are fetched only from the configured HTTPS issuer's `/cdn-cgi/access/certs`. Fetches have a
five-second timeout, refuse redirects, cap the response at 1 MiB and accept at most 16 keys. The
cache refreshes after ten minutes; unknown key IDs can trigger refresh no more than once per
30 seconds. Concurrent fetches coalesce. Tests use local TLS and generated RSA keys for accepted
requests, signature/algorithm/claim rejection, rotation, retired keys, unavailable/malformed/oversized
key sets, redirects and cancellation. No Cloudflare account configuration was changed.

## Deliberate differences from TypeScript

These are tested safeguards, not claims of identical behavior in failure cases:

- Go refuses a new start or extension when it cannot persist the deadline. TypeScript currently logs
  persistence failure and proceeds. A confirmed stop whose persistence fails stays retryable in Go.
- Failed release obligations, including idle and defensive boot releases, survive Go restarts.
  TypeScript's persisted format does not retain its stop-failure flag.
- Go serializes whole commands and their HTTP responses, beyond the source-level device mutex.
- Go rejects partial Access configuration and requires token expiration. TypeScript skips origin
  verification if either Access setting is absent and does not explicitly require an expiry claim.
- Invalid JSON object shapes are rejected with 400, and request bodies are capped at 8 KiB.

The shared trace oracle covers the common contract. Separate Go regressions cover these stricter
failure paths and concurrency; they do not qualify live-device behavior.

## Verification

From the repository root:

```sh
npx tsx packages/gousher/tools/control-traces.ts
npm test -- --runInBand packages/gousher/__tests__/control-traces.test.ts
npx tsc --noEmit -p packages/gousher/tsconfig.control.json
(cd packages/gousher && go test -race ./... && go vet ./...)
```

Regenerate traces only after reviewing the associated TypeScript behavior change. Live hardware,
Access deployment and production control cutover remain outside this simulator qualification.
