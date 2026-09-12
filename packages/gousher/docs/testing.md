# Test evidence

Initial implementation used tests after code. After the user's correction, subsequent behavior
changes used red–green cycles. This is not a claim that the whole port was developed test-first.

Observed failing tests drove these changes:

| Regression test | Observed red result | Fix |
| --- | --- | --- |
| `TestManagedDeletionWaitsForArmedDeadline` | Deletion acknowledged while armed | Persisted supervision guard |
| `TestSameRevisionCannotChangeSettings` | Changed settings accepted without a revision | Reject revision conflict |
| `TestMalformedSpoolDoesNotBlockDelivery` | Corrupt head stranded valid batches | Account for loss, discard corrupt head |
| `TestDeepSeaReconnectsBetweenPolls` | Socket remained open between polls | Close transport after each sample |
| `TestSSEUsesUsherDefaultMessageEvents` | Named event bypassed existing `onmessage` | Default SSE data frames |
| `TestSigenUsesExistingStableDeviceIdentity` | Device ID differed from TypeScript | Same username/region hash |
| `TestSigenRefreshesInsteadOfReloggingIn` | Password login used after expiry | Refresh-token grant |
| `TestSigenDefaultAuthDoesNotFallBackToAnotherSession` | Two login attempts by default | Legacy default; explicit auto fallback |
| `TestInspectorShowsLiveRegistersAndRunningState` | Missing live snapshot | Detached diagnostics and activity state |
| `TestFroniusInspectorShowsPowerAndBoundedHarvestHistory` | Missing Fronius inspector detail | Power, SOC and bounded report history |
| `TestTrialWindowsStopReaderOnceAndSurviveRestart` | Monitor route returned 404 | Authenticated window gate and durable shutdown |
| `TestSimulatorRunAcceptsFractionalSeconds` | HTTP 400 for 1.5-second run | Preserve fractional deadlines |
| `TestTrialIncidentDisablesWithoutWaitingForWindows` | Incident route returned 404 | Immediate durable trip |
| `TestInspectorBindFailureReturnsNonzero` | Occupied inspector port exited successfully | Nonzero exit after shutdown for service restart |
| `TestTrialWindowRequiresBothMeasurements` | Missing measurements accepted as healthy | Require baseline and current metrics |

The replay batch export, comparison/retention helpers and simulator APIs also began with missing-API
compile failures. TypeScript capture tests drove bounded asynchronous capture, production hooks,
temporary-file recovery and same-millisecond ordering. Detailed session notes are in the local,
gitignored `.context/gousher-tdd.log`.

Verification commands from repository root:

```sh
(cd packages/gousher && go test -race ./... && go vet ./...)
npm test -- --runInBand packages/usher lib/collectors packages/gousher/__tests__ lib/__tests__/route-matchers.test.ts lib/db/planetscale/__tests__/schema-shape.test.ts
packages/gousher/tools/integration.sh
npm run type-check
npm run knip
```

The preceding Fronius milestone passed 56 top-level Go tests (plus fixture subtests), 303 TypeScript unit tests and
five PostgreSQL integration tests. The integration suite verifies the real gusher handler, registry,
point minting and durable outbox boundary using computed Go batches. Only external credential lookup,
queue delivery and cache services are substituted. It does not exercise the downstream materializer
or any live device. Integration was verification, not claimed as test-first product development;
its initial failures were corrected harness assumptions.

This evidence does not qualify live account/session coexistence, Fly deployment or the month-long
soak. See [trial.md](trial.md) for the outstanding acceptance work.

After WIP commit `0e862b6f`, outbound telemetry tests initially failed to compile because the export
API did not exist. The implementation then passed tests for dedicated credentials, OTLP shape,
partial rejection and cancellation. A read-duration regression failed because the histogram was
missing; it now passes. A virtual-time watchdog test drove stale detection before the first sample.
A process-identity test failed because separate collectors would share one metric identity; exports
now carry a stable, distinct identifier for each process lifetime. All pass under the Go race detector.

After telemetry commit `1aaf0130`, `TestFroniusDiscoveryDoesNotDelayPowerAndPopulatesInspector`
failed because no discovered identity reached the inspector. Background discovery made it pass;
a separate cancellation check verifies shutdown waits for its requests. Two numeric-order tests
then failed: lexical sorting selected device `10` before `2`, unlike TypeScript `Object.values`.
Both metadata and power parsing now use numeric device-ID order and pass under the race detector.

`TestFroniusCollectionStopCancelsDiscovery` then failed because a disabled reader left its metadata request running. Collection now joins background shutdown before reporting completion; the test and race suite pass.

After Fronius commit `8c462528`, generator simulator parity used two observed red–green cycles:

| Regression test | Observed red result | Fix |
| --- | --- | --- |
| `TestFailedEarlyReleaseRetriesBeforeDeadlineAndAfterRestart` | Failed early stop was not retried, with either idle or armed persisted state | Retry persisted stop failures independently of the run deadline |
| `TestExtensionPreservesCommandAndFailureEvidence` | Extension erased the ambiguous-start error and changed the last write timestamp | Preserve command/error fields when only extending the deadline |
| `TestReleaseClearsRequestAndRecordsFailedCommand` | Failed stop had an old timestamp and no new transition window; release retained the request | Record attempted stops and clear the released request |
| `TestRemainingTimeMatchesTypeScriptRounding` | 60.4 seconds displayed as 61 seconds / 2 minutes | Round seconds first, then derive remaining minutes |
| `TestFirstObservationExtendsActiveTransitionOnly` | First post-command observation failed to extend the transition window | Refresh an existing command window on the first observation |
| `TestLatchedProbeReportsExtensionWithoutChangingObservation` | Probe advertised a fresh start and overwrote the poll observation | Report extension with the structured verdict and keep polling state unchanged |
| `TestSimulatorReleaseUsesLastPollWithoutAnotherRead` | Release performed another read and lost still-running attribution | Use the cached poll, including explicit unknown attribution |
| `TestSimulatorHTTPMethodsAndPasskeyParity` | Missing configuration returned 401, GET probe succeeded, run accepted header-only auth, empty probe key fell back to header | Match the TypeScript route's method and passkey behavior |

`TestFailedReleaseRetryCadenceSurvivesExtension` additionally verifies the 15-second retry cadence
and that extension cannot cancel a pending release retry. The existing ambiguous-start restart test
now advances virtual time by that retry interval before expecting the second stop.

Validation for this continuation: 65 top-level Go tests, `go test -race ./...`, `go vet ./...`,
Linux ARM64 build, and both existing TypeScript control suites (56 tests) pass. Other TypeScript and
database integration suites were not rerun for these Go-only behavior changes. These are simulator
regressions checked against TypeScript source semantics; there is no shared cross-language control
trace oracle yet. No live device writes or deployment occurred.

After parity WIP commit `3028f015`, the remaining generator work used these red–green checks:

| Regression | Observed red result | Implementation |
| --- | --- | --- |
| `TestSharedTypeScriptControlTraces` | Missing detailed request/probe/resume APIs and ownership fields | Full result maps and boot recovery match 22 production-TypeScript simulator traces |
| `TestSimulatorRichRequestAndProbeResponses` | HTTP dropped ownership, returned the wrong refusal status, invented SCF support and discarded map words | Pass through supervisor results with an atomic status snapshot |
| `TestControlAccess…` | Missing verifier dependency/API | Origin signature/issuer/audience validation with bounded, cached JWKS retrieval |
| `TestControlMonotonicBackstopSurvivesBackwardWallStep` | Backward wall step extended the run | Independent process-local monotonic deadline |
| `TestDefensiveBootPersistenceFailureRemainsRetryable` | Failed boot persistence abandoned the recovery retry | Retain a failed-release obligation until state is durable |
| `TestSupervisorRunWakesForNewFractionalDeadline` | Fractional deadline waited for the one-second periodic tick | Wake on new/extended deadlines and derive the next timer from both clocks |

Additional qualification passes for 24 concurrent HTTP starts, cancellation behind a blocked probe,
reconciliation after a probe, failed defensive stops across restart, trial transport write rejection,
JWT key rotation/coalescing/cancellation and invalid-token/key-server responses. Those checks qualify
existing behavior as well as the new implementation; they are not all claimed as initially failing.
See [control.md](control.md) for deliberately stricter Go behavior and the boundaries of this evidence.

Final validation for this milestone passes **78 top-level Go tests** (including shared trace
subtests), **304 TypeScript tests**, the Go race detector, vet, the root type-check, the dedicated
control-trace type-check, knip and the stripped Linux ARM64 build. The database integration suite
was not rerun because this milestone changes no management schema or ingestion behavior.

## Durable receipts and independent trial automation

Following WIP `5ae409ee`, observed red–green checks covered:

| Regression | Observed red result | Implementation |
| --- | --- | --- |
| Production fetch evidence | Missing measurement/summary module | Measure vendor fetch separately from total session duration; retain failures and typed incidents |
| Daily scheduling and health | Missing scheduler, evidence-selection and health APIs | Durable daily cursors, bounded selected discrepancies, independent loops and stale-health checks |
| Null scheduler checkpoint | JSON null accepted as empty state | Reject null persisted state |
| Evicted production incidents | Lost incident coverage appeared complete | Refuse ranges before the retained incident floor |
| Missing receipt history | Existing journal could be recreated empty | Fail closed when an existing receipt directory loses its journal |
| Corrupted receiver export | Modified valid JSON was exported with HTTP 200 | Verify capture SHA-256 against its durable receipt before export |

Additional qualification covers receipt retention/cap/torn-tail/checksum handling, authenticated
exports, config fingerprints, feed validation and retry checkpoints. Local end-to-end tests connect
production metrics to the actual runtime shutdown handler (including restart inhibition), and send
24 hourly batches through the actual receiver to a clean, non-duplicated daily report. These are
additional qualification, not all claimed as initially failing tests.

Validation passes: **89 top-level Go tests**, race detector, vet, Linux ARM64 command builds,
**311 TypeScript tests across 27 suites**, root/Usher/control type-checks and knip. After the final
export integrity fix, the full Go race/vet/build checks passed again. The disposable PostgreSQL
integration suite also passes **5 tests** covering managed CRUD and all four vendor ingestion paths;
it does not specifically qualify the new cloud production evidence query against real session data.
Cloud feed behavior has mocked API and evidence-unit coverage. No deployment, shared migration,
live device writes, production feed activation or live soak occurred.
