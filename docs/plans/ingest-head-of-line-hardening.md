# Ingest: head-of-line blocking on the observations queue

**Status:** proposed, not started · written from a live incident on 2026-09-09, revised the same day
once the cause was understood

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
| list | ✅ | ✅ `flowControl.list()` |
| ordering | **FIFO** | none — which is what we want |
| how many | one named queue | unlimited keys, no quota |

`flowControl.get(key)` returns `flowControlKey, waitListSize, parallelismMax, parallelismCount,
rateMax, rateCount, ratePeriod, ratePeriodStart, isPinnedParallelism, isPinnedRate, isPaused`.

**`parallelismCount` is the observability that was missing.** During the stall `lag` was climbing but
nothing showed what was *in flight*; `parallelismMax: 5, parallelismCount: 5, waitListSize: 1000`
states the diagnosis in one line. `lag` alone was misread as a throughput deficit twice.

### 🛑 Key by DEVICE — this is the headline, not the mechanism

```ts
flowControl: { key: `obs:${deviceRid}`, parallelism: 3 }
```

Keys are per-publish and unlimited. Keying by device means a slow Amber backfill message can only
ever contend with **other Amber messages**. On 2026-09-09 that would have confined the incident to
one device instead of taking out all six — Selectronic, Fronius, Tesla and the generator would never
have noticed. Nothing else in this plan comes close to that as a blast-radius reduction.

Ordering loss is a non-issue: the receiver is an idempotent UPSERT keyed on `(point, interval)`, so
observations may land in any order. We have been paying for a guarantee we do not use, and its price
was total ingest availability.

### Code changes

Four enqueue sites move from `queue.enqueueJSON` to `client.publishJSON({ …, flowControl })`:

- `lib/observations/outbox.ts:150` — the relay, the main path
- `lib/observations/publisher.ts:135`
- `lib/observations/poll-collector.ts:183`
- `app/api/cron/monitor-observations/route.ts:530`

`OBSERVATIONS_QUEUE_NAME` (`lib/qstash.ts:15`) becomes a key *prefix*; the env split
(`observations` / `observations-dev`) must survive as `obs:{env}:{deviceRid}` or dev and prod will
share flow-control keys.

`liveone queue` survives the migration — the verbs map 1:1 (`status`→`get`, `pause`/`resume`→same,
`parallelism n`→`pin({parallelism: n})`) and only the client calls behind `/api/v4/queue` change.
`list()` then makes `status` genuinely better: a wait list **per device**.

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
3. Re-point `/api/v4/queue` at `flowControl.*`; `liveone queue` verbs unchanged.
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
- `liveone queue status` reports `waitListSize` **and** `parallelismCount`, and still exits 1 on a
  stall.
