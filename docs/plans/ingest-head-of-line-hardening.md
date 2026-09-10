# Ingest: head-of-line blocking on the observations queue

**Status:** in progress · written from a live incident on 2026-09-09, revised the same day once the
cause was understood, and again on 2026-09-10 to match what shipped.

**Landed:** delivery bounding + batch cap + the lane-keyed publish path behind
`OBSERVATIONS_PUBLISH_MODE` (#432), the SDK bump to 2.11.3 (#433), the flow-control control plane
(#434), and the `liveone queue --lane` CLI. **Not yet done:** retiring the admin `info`/`messages`
twins, the cutover itself (`OBSERVATIONS_PUBLISH_MODE=flow`, dev then prod), and deleting the queue.

🛑 **The CLI must ship BEFORE the cutover, and did — this ordering is load-bearing.** The route
requires `lane` to set parallelism once `mode` is `flow`, so the moment the cutover flips, a build
of `liveone queue parallelism` that sends no lane starts returning 422. That is the primary incident
lever. The CLI now resolves its write body against the origin's reported `mode`, so one command line
is correct on both sides of the flip.

🛑 **Keyed by LANE, not by device — this doc's original headline was revised.** See the section
below.

## The incident

A 64-day Amber backfill (device 10002, 2026-07-07 → 09-08) published through
`POST /api/admin/amber-sync` **stopped all observation ingest for every device for ~2h20m**, and did
not materialise its own data.

Measured, from `/api/admin/observations/{info,stats}`:

```
per-minute ingest:  10:34 47 · 10:35 35 · 10:36 61 · 11:10 13 · 11:42 13   ← a 2h20m hole
lag 199 → 217 → 236 → 279 → 336 → 450 → 682 → 1053   (monotonic)
paused false · parallelism 1 → 5 (no effect) · DLQ 0 · queued messages retried: 0
outbox backlog 4–6, oldestUnpublished seconds old — publishing was never the problem
receiver answered an unsigned probe in 0.16 s (403) — never hung, never broken
```

The receiver log that named the culprit, emitted at **11:11** for a batch created at **10:36:44**:

```
[ObservationsReceiver] Received: systemId=10002, observations=1650, session=yes,
                       batchTime=2026-09-09T20:36:44+10:00
```

One message took 34 minutes. Recovery was: empty the queue from the Upstash console, then replay
516 rows from `observations_outbox` (`published_at = NULL`) excluding `device_rid = 10002`. Verified
complete: Daylesford Selectronic and Kinkora Fronius 135/135 minutes of the window, Tesla and the
generator matching a pre-stall control window exactly.

## Cause

**Queues are strictly FIFO, and that is the whole problem.** From the QStash docs:

> Messages are sent sequentially, with each message waiting for the previous one to complete
> delivery **or exhaust retries** before becoming active.

So one message that keeps timing out holds the lane for its entire retry schedule. Three factors
combined:

1. **Oversized messages.** The backfill emitted one message per 7-day window: ~1650 observations
   each, ~128 of them. Normal traffic is ~13 readings per message (`[gush] … readings=13 stored=13`).
2. **The receiver is not bounded for that size.** `app/api/observations/receive/route.ts` has **no**
   `export const maxDuration` — `vercel.json` raises it explicitly for six other routes but not this
   one — and it commits the whole message in **one transaction** (route ~line 327).
3. **FIFO.** Raising `parallelism` 1 → 5 did **nothing**, because five strictly-ordered lanes still
   deliver in order. That is the observation that identifies the queue *type*, not the tuning, as the
   defect.

Self-inflicted and reproducible: any large historical backfill through the current path repeats it.

## The fix: publish with Flow Control instead of enqueueing to a Queue

QStash's own console banner says it, and the Queues doc confirms the direction:

> Setting parallelism with queues **will be deprecated at some point**.

Flow Control caps concurrency **without** ordering, so a slow message occupies one slot and the rest
keep flowing. It is a strict superset of what we use Queues for:

| | Queue (today) | Flow Control |
| --- | --- | --- |
| pause / resume | ✅ | ✅ `flowControl.pause/resume(key)` |
| set parallelism | ✅ — deprecating | ✅ `flowControl.pin(key, {parallelism})` |
| rate limiting | ✗ | ✅ `rate` + `period` |
| backlog | `lag` | `waitListSize` |
| **in-flight count** | ✗ | ✅ `parallelismCount` |
| list | ✅ | ✗ — **no `list()` in the SDK** at any version (see below); `get(key)` per known key |
| ordering | **FIFO** | none — which is what we want |
| how many | one named queue | unlimited keys, no quota |

`flowControl.get(key)` returns `flowControlKey, waitListSize, parallelismMax, parallelismCount,
rateMax, rateCount, ratePeriod, ratePeriodStart, isPinnedParallelism, isPinnedRate, isPaused`.

**`parallelismCount` is the observability that was missing.** During the stall `lag` was climbing but
nothing showed what was *in flight*; `parallelismMax: 5, parallelismCount: 5, waitListSize: 1000`
states the diagnosis in one line. `lag` alone was misread as a throughput deficit twice.

### 🛑 Key by LANE — superseding this doc's original "key by device"

```ts
flowControl: { key: observationsFlowKey(lane), parallelism: laneParallelism(lane) }
// obs:live (5) · obs:backfill (2) — `obs-dev:` in dev. lib/qstash.ts, lib/observations/publish.ts
```

**What shipped is two fixed keys per environment, `live` and `backfill`, not one key per device.**
Per-device keying was the original headline here and it does not survive contact with the API: key
cardinality grows with the fleet, `GET /v2/flowControl` is unpaginated, there is no atomic global
pause, and total in-flight becomes `devices × parallelism`, which passes the Postgres pool long
before "thousands of devices". The lane is a property of the MESSAGE, not the device — the same
device emits live poll messages and (during a backfill) bulk ones, and it is those that must not
contend.

**What that buys, and what it doesn't.** Backfill-vs-live is fully fixed: a 64-day Amber replay can
no longer delay minutely ingest for anyone, which is the property that actually failed on
2026-09-09. What remains is that one slow *live* device can still delay other *live* devices —
bounded now by parallelism 5 rather than the queue's strict FIFO 1, and by the ~5-minute worst-case
slot occupancy the delivery options impose. That is a latency ceiling measured in minutes, not the
2h20m total-ingest outage.

Ordering loss is a non-issue: the receiver is an idempotent UPSERT keyed on `(point, interval)`, so
observations may land in any order. We have been paying for a guarantee we do not use, and its price
was total ingest availability.

### Code changes

Four enqueue sites move from `queue.enqueueJSON` to `client.publishJSON({ …, flowControl })`:

- `lib/observations/outbox.ts:150` — the relay, the main path
- `lib/observations/publisher.ts:135`
- `lib/observations/poll-collector.ts:183`
- `app/api/cron/monitor-observations/route.ts:530`

`OBSERVATIONS_QUEUE_NAME` becomes a key *prefix* (`OBSERVATIONS_FLOW_PREFIX`); the env split must
survive, and the two prefixes must be **disjoint under prefix matching**, not merely different —
`"obs:dev:live".startsWith("obs:")` is `true`, `"obs-dev:live".startsWith("obs:")` is `false`. That
is why the environment goes in the prefix and not in a middle segment.

`liveone queue` survives the migration — the verbs map 1:1 (`status`→`get`, `pause`/`resume`→same,
`parallelism n`→`pin({parallelism: n})`) and only the client calls behind `/api/v4/queue` change.

🛑 **There is no `flowControl.list()`** — `FlowControlApi` has no `list` method at any SDK version,
contrary to the table above. It does not matter: with two fixed lanes, two `get()` calls cover the
whole view. And they MUST be enumerated rather than discovered — a key with nothing waiting, nothing
in flight and no pin may not exist at all, so "the keys QStash returns" renders a totally stopped
fleet as zero lanes and reads as healthy.

### 🛑 Traps

- **Publish-time settings are overridable.** Parallelism passed on a publish can be replaced by the
  *next* published message. An operator raising it during an incident must `pin` it or it silently
  reverts. `liveone queue parallelism` must pin, and say so.
- **Do not conclude "throughput deficit" from a rising `waitListSize`/`lag`.** That is what a stall
  looks like too, and it was wrong twice here. The discriminator is `lastIngestedAt` aged against
  now — a busy queue still ingests — with `parallelismCount` to confirm.
- **An empty DLQ is not "nothing is wrong."** With one message retrying and everything behind it
  unattempted, the DLQ stayed at 0 for the whole outage.
- **The data was never lost.** The durable `observations_outbox` tee (payload kept 30 days,
  `OUTBOX_GC_DAYS ?? 30`) plus the idempotent receiver mean a stalled queue is a latency problem.
  Recover by resetting `published_at`, never by republishing from the vendor.

## Region: Sydney is not available for QStash

Checked, because the app runs in `syd1` while QStash is in `eu-central-1`:

> QStash operates in **two** independent regions: **EU Central** and **US East**.
> EU `https://qstash.upstash.io` (default) · US `https://qstash-us-east-1.upstash.io`

There is no `ap-southeast-2` for QStash. (Redis *does* offer Sydney — `liveone-redis` already runs
there — which is where the expectation came from; the region lists are not the same.)

**Recommendation: do not migrate regions.** Frankfurt→Sydney is ~250–280 ms RTT and
Virginia→Sydney ~200–220 ms, so US East buys perhaps 50–80 ms per delivery. At ~3.6 messages/min that
is irrelevant to throughput, and it was not a factor in this incident — the stalled message was
consuming *minutes*. Against that, a region switch costs a new `OBSERVATIONS_QSTASH_TOKEN`, new
signing keys, and leaves message logs and DLQ contents behind in the old region.

🛑 If it is ever done: `withQstashSignatureVerification` accepts `OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY`
+ `…_NEXT_SIGNING_KEY`, **both from one region**. Switching the env mid-flight makes every in-flight
message from the old region fail signature verification. Drain the old region first (pause publishing,
let it empty, then switch), or teach the receiver to accept two key pairs for the cutover.

## 🛑 The data loss had a SECOND, unrelated cause — PK collisions in one statement

Found 2026-09-10, reading the 8 DLQ messages the incident left behind. The head-of-line analysis in
this doc is correct but **incomplete**: wedging the queue is what stopped ingest, and it is what the
lanes fix. It is not what destroyed the data.

Every one of the 8 messages failed with HTTP 500 on `insert into point_readings_agg_5m`, and each
carried ~215 rows whose `(point_rid, interval_end)` duplicated another row **in the same statement**.
Postgres refuses that outright:

> ON CONFLICT DO UPDATE command cannot affect row a second time — SQLSTATE 21000

It refuses the WHOLE statement, so one collision discards every row travelling with it.

**It is not a size limit.** The statement was 181 kB with ~19,800 bind parameters — under a third of
Postgres's 65,535 ceiling. Two colliding rows fail exactly as 1,652 did. No batch cap, delivery
bound, lane or Flow Control setting in this document prevents it, and slicing a message into
producer-cap transactions does not either: at ~13% collision density nearly every slice still
contains a pair.

**Where the duplicates come from.** `usagePointFilter` and `pricingPointFilter`
(`lib/vendors/amber/client.ts`) overlap on exactly one suffix — `/perKwh`. The usage sync and the
pricing sync are two API fetches that share one `PollCollector`, so a backfill emits that channel's
rate twice for every interval the two windows share: identical value, graded `b` (billable) by
`usage` and `a` (actual) by `pricing`. Measured on the real payload — one topic at 551 rows where
the others sat at 336 (= 336 real half-hours + 215 collisions), the 215 matching the pricing fetch's
coverage exactly, the two fetches 417 ms apart.

**Why only backfills.** A live poll carries one interval per point, so it cannot collide with
itself. Only a multi-day window is long enough to span a settlement boundary where Amber holds two
gradings.

**The fix** is `collapseByKey` in `lib/readings/dao.ts`: collapse rows sharing a PK before the
statement, keeping the highest `qualityRank` (`lib/data-quality.ts`), last-wins on a tie. It lives in
the DAO deliberately — it is the single writer, it protects every vendor, and it is the only place
that can help a REPLAY, because the outbox payloads already contain the duplicate pairs. Amber's
private `QUALITY_RANK` now delegates to the shared ordering.

**The producer overlap is fixed too, and NOT by changing the filters.** Both endpoints are entitled
to report `perKwh`: only `pricing` has current/forecast intervals, and only `usage` carries the
billed grading — the live poll path (`lib/vendors/amber/adapter.ts`) reads the rate from prices, so
narrowing either filter would lose a series. What the two fetches lack is any view of each other,
and the one thing they share is the `PollCollector`. So `add()` now merges on
`(pointUid, interval, measurementTime)` — the serving store's own key — resolving exactly as the
store would: FIRST wins for `raw` (`ON CONFLICT DO NOTHING`), highest `qualityRank` for `5m`/`1d`
(upserts). No stored value changes; the redundant row simply never gets built, and the flush log
reports `N merged` so an overlap appearing on a vendor that should have none is visible.

### Consequence: five weeks of Amber data are missing, and recoverable only until ~2026-10-05

Device handle 10002 (Amber – CitiPower) reports `firstData: 2026-09-08` on every series. The
backfill that would have populated **2026-07-07 → 2026-08-11** is the batch that failed. Three
recovery routes, all needing a deliberate action — none self-heals, and the coverage-repair cron
cannot see it because its window floor is `commissioned_on`:

| Route | Expires | Note |
| --- | --- | --- |
| QStash DLQ payload | unconfirmed | Retention not verified; likely the tightest. |
| `observations_outbox` replay | ~2026-10-09 | Rows exist (the tee precedes publish) but `published_at` is set, so the relay will never re-send. Needs it cleared. |
| Amber `/usage` re-fetch | ~2026-10-05 | Rolling ~90-day window against the oldest needed day. |

🛑 Do **not** attempt recovery before the collapse fix is deployed — the stored payloads still carry
the duplicate pairs and would fail identically.

## Secondary fixes

Still worth doing; Flow Control reduces their urgency but does not replace them.

1. **Chunk publishes to poll-sized batches.** The *message* is the unit that matters, not the API
   request. Amber's 7-day API cap and a safe message size are different numbers and the sync path
   conflates them. Owner of this property: the generic `liveone sync` verb — see
   `ops-cli-queue-and-vendor-sync.md`.
2. **Bound the receiver.** Give `observations/receive` an explicit `maxDuration`, and cap the
   accepted batch size so an oversized publish fails **fast at the producer** instead of silently
   wedging the consumer.
3. **Make "inserted" mean received.** `amber-sync` reports `numRowsInserted` from the publish step,
   so ten consecutive `Rows inserted: 1008 / Success: YES` accompanied a backfill that materialised
   **zero** rows. A sync that reports success while its data is unqueryable is worse than one that
   fails.

## Sequencing

1. Receiver bound + batch-size cap (2) — cheap, independent, stops the worst input.
2. Flow Control migration behind the existing `OBSERVATIONS_QSTASH_TOKEN`, dev first
   (`observations-dev` keys), then prod.
3. Re-point `/api/v4/queue` at `flowControl.*` (`lib/observations/flow-control.ts`, shared with the
   monitor cron and `scripts/qstash-health.ts`); `liveone queue` verbs unchanged.
   🛑 The control plane must read **both** transports for the whole coexistence window. It ships
   before the cutover, so while `OBSERVATIONS_PUBLISH_MODE` is still `"queue"` the lanes are
   genuinely empty and reporting them alone would blind the very surface this step exists to fix.
   Writes go to the transport actually in use, for the same reason.
4. Chunking + received-not-published (1, 3) with the `liveone sync` verb.
5. Retire the `observations` queue once nothing enqueues to it.

Rollback at any point is reverting the publish call sites: the queue still exists and the outbox is
the system of record either way.

## Verification

- Replay a multi-week backfill against a device on `liveone-dev` and assert `lastIngestedAt` never
  ages beyond one poll interval **for other devices** while it runs. That is the property that
  actually failed, and per-device keys are what make it hold.
- Assert emitted message size stays within the poll-sized bound (a unit test on the publisher — the
  bound is the contract, not an integration detail).
- After a sync reports success, read the serving store for the synced range and assert non-empty.
- ✅ `liveone queue status` reports `waitListSize` **and** `parallelismCount` — per lane, as a table —
  and still exits 1 on a stall. It now also exits 1 on `STUCK`, which is the stronger signal: the
  stall exit needs five minutes of silence to fire, `stuck` is true from minute one.
