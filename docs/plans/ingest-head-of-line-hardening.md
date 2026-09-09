# Ingest: head-of-line blocking on the observations queue

**Status:** proposed, not started · written from a live incident on 2026-09-09

## The incident

A 64-day Amber backfill (device 10002, 2026-07-07 → 09-08) published through
`POST /api/admin/amber-sync` **stopped all observation ingest for every device for ~50 minutes**,
and did not materialise its own data.

Measured, from `/api/admin/observations/{info,stats}`:

```
tail of per-minute ingest:  10:34 47 · 10:35 35 · 10:36 61 · 11:10 13   ← a 34-minute hole
lastIngestedAt 11:10:46 → stalled again 17.4 min by 11:28
lag 199 → 217 → 236 → 279 → 336 → 450     (monotonic)
paused false · parallelism 1 · DLQ 0 · queued messages retried: 0
outbox backlog 4–6, oldestUnpublished seconds old, published24h 5219
```

And the receiver log that named the culprit, emitted at **11:11** for a batch created at **10:36:44**:

```
[ObservationsReceiver] Received: systemId=10002, observations=1650, session=yes,
                       batchTime=2026-09-09T20:36:44+10:00
```

One message took **34 minutes**.

## Cause — three things, none sufficient alone

1. **Oversized messages.** The backfill emitted one message per 7-day window: **~1650 observations
   each**, ~128 of them. Normal traffic is ~13 readings per message (`[gush] … readings=13
   stored=13`), so each backfill message was ~125× the norm.
2. **The receiver is not bounded for that size.** `app/api/observations/receive/route.ts` has **no
   `export const maxDuration`** — `vercel.json` raises it explicitly for `cron/derivations`,
   `cron/minutely`, `cron/relay-outbox`, `cron/db-stats`, `history` and `cron/repair-coverage`, but
   not for the receiver, so it runs on the platform default. It also commits **the whole message in
   one transaction** (route ~line 327, `db.transaction(async (tx) => …)`, session inserted first).
   A 1650-row batch plus the real-time `agg_5m` upserts overruns, is killed, and QStash redelivers.
3. **`parallelism: 1`.** This is what turned an Amber problem into an everyone problem: the single
   lane is held by the slow message, so all six ingesting devices went dark.

The signatures fit exactly: **DLQ empty** (nothing failed permanently — one thing kept being
retried), **`retried: 0`** on everything queued behind it (never attempted), **outbox healthy**
(publishing was never the problem), and the receiver answering an unsigned probe in **0.16 s**
(`403 "Upstash-Signature header is missing"` — never hung, never broken).

It is **self-inflicted and reproducible**: any large historical backfill through the current sync
path will do it again.

## Fixes

In priority order. The first is mitigation; the rest are the actual fix.

1. **Raise `parallelism` above 1.** So no single slow message can starve every device. This is a
   QStash queue setting — the app exposes only pause/resume, which is why the incident could be
   watched and not touched. A setter is scoped in `ops-cli-queue-and-vendor-sync.md`.
2. **Chunk backfill publishes to poll-sized batches.** The message, not the API request, is the unit
   that matters. Amber's 7-day API cap and a safe *message* size are different numbers and the sync
   path currently conflates them.
3. **Bound the receiver.** Give `observations/receive` an explicit `maxDuration`, and reconsider
   wrapping an unbounded row count in a single transaction — chunk within the message, or cap the
   accepted batch size and reject (loudly) above it, so an oversized publish fails fast at the
   producer instead of silently wedging the consumer.
4. **Make "inserted" mean received.** `amber-sync` reports `numRowsInserted` from the publish step,
   so ten consecutive `Rows inserted: 1008 / Success: YES` accompanied a backfill that materialised
   **zero rows** — `firstData` for every Amber series stayed `2026-09-08`, and a direct query of
   2026-07-10..12 returned no points. A sync that reports success while its data is unqueryable is
   worse than one that fails.

## Traps

- 🛑 **Do not conclude "throughput deficit" from a rising `lag`.** That is what the rising lag looks
  like and it was wrong twice in this incident. The discriminator is `lastIngestedAt` aged against
  `now`: a busy queue still ingests, a blocked one does not. `perMinute` had a clean 34-minute hole
  in an otherwise steady 42.9/min, 60,527/24h series.
- 🛑 **An empty DLQ is not "nothing is wrong".** With one message retrying and everything behind it
  unattempted, the DLQ stays at 0 for the whole outage.
- 🛑 **The data was never lost.** The durable `observations_outbox` tee plus the idempotent
  upsert at the receiver mean a stalled queue is a latency problem, not a loss problem. Do not
  "fix" it by republishing — that just adds more oversized messages to the queue.

## Verification

- Replay a multi-week backfill against a device on `liveone-dev` and assert that `lastIngestedAt`
  never ages beyond one poll interval while it runs — the property that actually failed.
- Assert the emitted message size stays within the poll-sized bound (a unit test on the publisher,
  not an integration test — the bound is the contract).
- After a sync reports success, read the serving store for the synced range and assert non-empty.
  This is the check whose absence let a completely ineffective backfill look like ten clean passes.
