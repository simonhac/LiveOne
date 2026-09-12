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

The current runs pass 45 top-level Go tests (plus fixture subtests), 303 TypeScript unit tests and
five PostgreSQL integration tests. The integration suite verifies the real gusher handler, registry,
point minting and durable outbox boundary using computed Go batches. Only external credential lookup,
queue delivery and cache services are substituted. It does not exercise the downstream materializer
or any live device. Integration was verification, not claimed as test-first product development;
its initial failures were corrected harness assumptions.

This evidence does not qualify live account/session coexistence, Fly deployment or the month-long
soak. See [trial.md](trial.md) for the outstanding acceptance work.
