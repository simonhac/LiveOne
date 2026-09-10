# Observations ingest stall — a poison backfill, head-of-line blocking a FIFO queue

## Summary

On **2026-09-09**, a 64-day Amber backfill (device handle `10002`, 2026-07-07 → 09-08) published
through `POST /api/admin/amber-sync` **stopped all observation ingest, for every device, for
~2h20m** — and did not materialise its own data.

Two **independent** defects, which is the thing this report exists to keep straight. They were
conflated for a day, and the conflation is what made the first round of fixes miss the one that
mattered:

| | Defect | Effect | Fixed by |
| --- | --- | --- | --- |
| **A** | Duplicate primary key inside one `ON CONFLICT DO UPDATE` — Postgres rejects the **whole statement** (SQLSTATE 21000) | The backfill's data never landed | #436 |
| **B** | A deterministically-failing message holds a **strictly FIFO** queue slot for its entire retry schedule | All ingest stopped, ~2h20m | #432 (bounds), lanes/Flow Control (isolation) |

**A is why the data was lost. B is why everyone else's ingest stopped.** Neither fixes the other:
lanes would have kept live ingest flowing while the backfill still failed; the collapse would have
let the backfill succeed with the queue still FIFO.

Availability was restored the same day. **The data is still missing** — see Action Items.

No data was corrupted, and nothing was silently overwritten: the failing statement rolled back
whole, and `observations_outbox` retained every payload.

## What Went Wrong

### The trigger

A newly-connected Amber device (added 2026-09-08) had no history, so a 64-day backfill was run with
`action: "both"` — usage **and** pricing. `updateUsage` and `updateForecasts` are separate API
fetches that share one `PollCollector`, and the point filters
(`lib/vendors/amber/client.ts`) overlap on exactly one suffix:

```
usageSuffixes   = ["/kwh", "/cost", "/perKwh"]
pricingSuffixes = ["/renewables", "/spotPerKwh", "/perKwh"]
```

Both are right to report `perKwh` — only `pricing` has current/forecast intervals, only `usage`
carries the billed grading, and the live poll path reads the rate from prices. But run together
over one window they emit that channel's rate **twice per interval**: identical value, graded `b`
(billable) by usage and `a` (actual) by pricing.

Measured on the surviving payload: one topic carried **551** rows where every other carried 336
(= 336 real half-hours + **215** collisions), and the 215 matched the pricing fetch's coverage
exactly. The two fetches were **417 ms apart** — this was never a settlement race.

### Defect A — the statement Postgres refuses

`point_readings_agg_5m`'s primary key is `(point_rid, interval_end)`, and the receiver builds one
multi-row `INSERT … ON CONFLICT (point_rid, interval_end) DO UPDATE`. Postgres refuses when a single
command proposes the same constrained key twice:

> ON CONFLICT DO UPDATE command cannot affect row a second time — SQLSTATE 21000

It refuses the **entire statement**, so one collision discards every row travelling with it, and
`processSlice` wraps raw + 5m + 1d in one transaction, so the slice rolled back whole.

🛑 **This is size-independent.** Two colliding rows fail exactly as 1,652 did. No batch cap,
delivery bound, lane or Flow Control setting prevents it, and slicing a message into
producer-cap transactions does not either — at ~13% collision density nearly every slice still
contains a pair.

### Defect B — FIFO charges the queue for the backoff

From the QStash docs:

> Messages are sent sequentially, with each message waiting for the previous one to complete
> delivery **or exhaust retries** before becoming active.

Every backfill message failed deterministically, so retrying could only fail again — and each
message held its slot through the full backoff. Replayed from QStash's delivery log on 2026-09-10:

```
  obs  tries   duration   occupancy  state        ← the backfill batches
 1650      2     4037ms    159924ms  RETRY          attempt 1 3871ms → ERROR
                                                    attempt 2 4037ms → ERROR
 1651      1     4142ms      4142ms  RETRY
 1647      1     4135ms      4135ms  RETRY
 1650      1     4078ms      4078ms  RETRY
 1652      1     3974ms      3974ms  RETRY
                                                  ← normal traffic, same window
  ~13    n=548  p50 666ms   max 1345ms  DELIVERED
```

A 1,650-observation batch carried **127× the rows** of a normal batch and took **6× the time**. The
receiver handled the volume comfortably. The one batch that retried did **7.9s of work** while
occupying its slot for **2m40s** — a ratio of 40×, i.e. ~97.5% backoff.

The outage ended because the queue was **purged**, not because it drained: the log shows a run of
`CANCELED` batches, and many others that never got past `CREATED`.

### Why it wasn't caught, and then misdiagnosed twice

- **The DLQ stayed at 0 for the whole outage.** With one message retrying and everything behind it
  unattempted, nothing reaches the DLQ — and `dlq_present` was the only queue alert. The monitor
  never fired; detection was a human noticing stale charts.
- **`lag` is ambiguous.** A busy path and a blocked one both grow. It was read as a throughput
  deficit **twice**, and `parallelism` was raised 1 → 5 in response — which did nothing, because
  five strictly-ordered lanes still deliver in order.
- **Nothing reported what was *in flight*.** `parallelismCount: 5, waitListSize: 1000` states the
  diagnosis in one line and was not being read.
- **A log line was misread as a duration.** `[ObservationsReceiver] Received: … observations=1650`
  logged at 11:11 for a batch created at 10:36:44 was taken to mean *"one message took 34 minutes"*.
  `Received:` is logged on **arrival** — that is queue **wait**, not work. Nothing in the original
  evidence measured processing at all.
- **That misreading became a hypothesis, and the hypothesis shaped a day of work.** "The messages
  were too big" survived for a day and drove the batch cap, the receiver bound and the lane split
  before anyone measured a batch. Those are all worth having, and none of them would have saved the
  data.

### The cutover attempt, 2026-09-10 — a third defect, found by trying

The flow-control cutover was attempted on prod at 13:00 AEST and **rolled back after 2m45s**. Zero
data lost: the outbox backlog rose to 19 with `oldestUnpublishedAt` pinned at the exact moment of
the flip, and drained itself once queue mode returned. The tee-before-publish design did exactly
what it exists for.

```
flow   13:00:09  stalled 0.1  lastIngest 03:00:02
flow   13:02:33  stalled 2.5  lastIngest 03:00:02   ← frozen
queue  13:03:21  stalled 0.5  lastIngest 03:02:48   ← recovered
```

The cause, from the Vercel runtime log:

```
[PollCollector] Failed to publish poll for system 5: Error [QstashError]:
{"error":"flowControlKey must be alphanumeric, hyphen, underscore, or period"}   status: 400
```

**The colon in `obs:live` is not a legal flow-control key character.** Every publish 400'd.

The colon was chosen deliberately, by the 🛑 in `lib/qstash.ts` arguing the environment must live in
the *prefix* so `"obs-dev:live".startsWith("obs:")` is false. That reasoning is sound; the separator
it picked is illegal. And the obvious repair is a trap — `-` gives prod `obs-live` and dev
`obs-dev-live`, where `"obs-dev-live".startsWith("obs-")` is **true**, silently reintroducing the
collision the prefix split exists to prevent. `.` satisfies both constraints, and both are now
asserted.

🛑 **An illegal key is invisible from the read side and fatal on the write side.**
`flowControl.get("obs:live")` returns 200 for a key `publishJSON` will not accept, so `readLane`
reported `idle: false` and `liveone queue status` showed two present, healthy lanes for the entire
outage — lanes that could never have received a message. This is the module header's own warning
("a key that may not exist at all … would read as healthy") in a worse form.

**And the test that should have caught it could not fail.** `publish.test.ts` asserted
`expect("obs-dev:live".startsWith("obs:")).toBe(false)` — a property of two string *literals*, true
regardless of what the code minted. It stayed green for the whole time the code was producing keys
QStash rejects. It now derives the separator from the real key.

## Detection

Manual, by a human noticing readings had stopped. No alert fired. `monitor-observations`' queue
check was DLQ-depth only, and the DLQ was empty throughout — the precise blind spot.

## Resolution

**Same-day (availability).** Empty the queue from the Upstash console, then replay 516 rows from
`observations_outbox` (`published_at = NULL`) excluding `device_rid = 10002`. Verified complete:
Daylesford Selectronic and Kinkora Fronius 135/135 minutes of the window; Tesla and the generator
matched a pre-stall control window exactly.

**Subsequent (code).** In order:

| PR | What |
| --- | --- |
| #432 | Bounded delivery (`retries 3`, backoff `5s/15s/45s`, timeout 65s), capped batch size at 500 observations, laned the publish path behind `OBSERVATIONS_PUBLISH_MODE` |
| #433 | QStash SDK 2.11.3 for the Flow Control API; require both signing keys |
| #434 | `lib/observations/flow-control.ts` — one ingest aggregate for the route, the monitor and `qstash-health`; adds the `stuck` predicate and `ingest_lane_stuck` |
| #435 | `liveone queue --lane` — per-lane status and lane-scoped levers, correct on both sides of the cutover |
| #436 | **`collapseByKey`** — the PK collapse, at the writer and at the producer. The fix for defect A |
| #437 | `liveone queue timing` — per-batch wait/duration/occupancy, which is what settled the diagnosis above |

The delivery bounds alone would have cut that 2m40s occupancy ~30×.

## Timeline (UTC, 2026-09-09 unless noted)

| Time | Event |
| --- | --- |
| 10:36:24 | Backfill publishes; usage and pricing fetches 417 ms apart into one collector |
| 10:36:35 – 10:37:31 | 8 messages fail `ERROR` on `point_readings_agg_5m`, ~4s per attempt; land in the DLQ |
| 10:36 → 11:10 | Ingest hole: per-minute 61 → 13. `lag` climbs 199 → 1053, monotonic |
| — | `parallelism` raised 1 → 5. No effect (FIFO) |
| — | DLQ observed at 0 throughout. Outbox backlog 4–6, seconds old — publishing was never the problem |
| ~13:00 | Queue purged; 516 outbox rows replayed |
| 2026-09-10 | Root cause A found by reading the DLQ payloads; #436 ships |
| 2026-09-10 | Delivery log replayed with #437; the size hypothesis disproved and this report written |

## Lessons Learned

1. **An empty DLQ is not "nothing is wrong."** It is what a *blocked* queue looks like: nothing has
   exhausted retries because nothing after the first message has been attempted.
2. **`lag` cannot distinguish busy from blocked.** `lastIngestedAt` aged against now can — a busy
   path still ingests. `stuck` (saturated AND backed up AND nothing landing) is the same question in
   its unambiguous form, and would have been true from minute one.
3. **A log line that says `Received:` measures arrival, not work.** If a duration matters, measure it
   explicitly. The receiver now logs `Processed in {N}ms`.
4. **Measure before building.** The size hypothesis was plausible, wrong, and expensive: it directed
   a day of work at blast radius while the actual defect — a duplicate key — went unexamined. One
   `ACTIVE → terminal` delta would have refuted it on day one.
5. **A slow message and a deterministically-failing one are indistinguishable from outside a FIFO
   queue**, and have different fixes. Retries only help a *transient* failure; against a deterministic
   one the retry budget is pure occupancy.
6. **Postgres rejects the whole statement on an intra-statement PK collision.** Multi-row upserts
   must dedupe on the conflict target first. Cardinality is a property of the batch, not its size.
7. **A read path that tolerates what the write path rejects will report health that cannot exist.**
   `flowControl.get()` answered 200 for a key `publishJSON` 400s on. Any identifier that crosses a
   service boundary needs its constraints asserted where it is MINTED, not inferred from whichever
   endpoint happens to be more forgiving.
8. **A test asserting a property of string literals cannot fail when the code is wrong.** The
   disjointness test hardcoded both keys and passed throughout. Assert against what the code
   produces.
9. **Two endpoints legitimately reporting one field is not a bug in either.** It has to be resolved
   where they meet — for us, the `PollCollector` — not by narrowing a filter and losing a series.

## Action Items

**Done**

- [x] Bound delivery and cap batch size (#432)
- [x] Lane the publish path, `live` / `backfill` (#432, #434)
- [x] `stuck` predicate + `ingest_lane_stuck` alert — the check that was missing (#434)
- [x] Collapse duplicate PKs at the writer **and** the producer (#436)
- [x] Per-batch timing, and a durable `Processed in {N}ms` in the receiver (#437)
- [x] Key the QStash environment off `VERCEL_ENV`, not `NODE_ENV` — a Vercel preview build has
      `NODE_ENV=production`, so it resolved prod's queue name, prod's `obs:` flow prefix and prod's
      receiver URL, with a live token in Preview scope. After the cutover a preview-targeted
      `liveone queue pause` would have paused **prod's** lane; a preview that published anything
      would have written into the **production** serving store.

- [x] Flow-control keys use a legal separator, with the charset AND the prefix-disjointness both
      asserted (`FLOW_KEY_CHARSET`); `liveone queue outbox` surfaces `observations_outbox.last_error`,
      which is where the cutover's cause was recorded and unreadable.
- [x] **Cut over** to flow control, 2026-09-10 03:39 UTC — `OBSERVATIONS_PUBLISH_MODE=flow` in the
      Production scope plus a redeploy. Twelve minutes of verification: ingest monotonic,
      `stalledMinutes` never above 0.4, `failing: 0` on the outbox, and batch durations p50 691 ms
      against a pre-cutover baseline of 684 ms. Lanes now carry the traffic they were named for.
- [x] **Retire the queue transport in code.** The `OBSERVATIONS_PUBLISH_MODE` switch, the FIFO
      publish branch, the `mode`/`legacyQueue`/compat fields on `/api/v4/queue`, and the admin
      `info`/`messages` twins are gone; the admin page reads `/api/v4/queue` and
      `/api/v4/queue/timing`, the same two endpoints `liveone queue` does. One aggregate is what
      stops the browser and the terminal disagreeing about whether ingest is healthy.

**Open**

- [x] **Recovered device 10002, 2026-07-07 → 2026-09-08**, on 2026-09-10 with
      `liveone sync 10002 --start=2026-07-07 --end=2026-09-08 --action=usage --apply` — 10 vendor
      windows, 12,096 observations published on the `backfill` lane, no failures and no duplicate
      collapses. **24 of 34 series** moved their first-data back and **+45,344 samples** landed
      (13,844 → 59,188): `import/value` and `import/energy.delta` from 2026-09-08 back to
      **2026-07-07** (96 → 3,120 samples each), and `import/rate` from 2026-07-11 back to
      2026-07-07 (800 → 3,216), the usage fetch filling in days the pricing fetch never had.
      Re-running the first window afterwards published **0** and reported the window already
      covered — the sync is idempotent, and that is the landing proof.
      ⚠️ The `export/*` series start **2026-08-18** and stop there. That is not a shortfall: the
      site had no export before then, which is also why the last three windows published double. Only the `/usage`-derived series are
      missing (energy and cost); the `/prices` half survived back to 2026-07-11. Run with
      `action: "usage"` — usage-only never calls the pricing endpoint, so it cannot collide.
      Routes: the Amber API (rolling ~90 days, so ~2026-10-05), an `observations_outbox` replay
      (~2026-10-09, and needs `published_at` cleared), or **a CSV from Amber support, which has no
      deadline** — the route already used for a 4½-month gap in 2025-11.
- [x] **There is no history below 2026-07-07 to recover, and no clock on finding out.** The
      recovery started at 2026-07-07 because that is where the *original* backfill started, which
      was never a statement about where Amber's data ends — Amber's rolling ~90-day window reaches
      back to ~2026-06-12, so ~3½ weeks looked recoverable and decaying by a day per day. It is
      not: `liveone sync 10002 --start=2026-06-12 --end=2026-07-06 --action=usage --apply` on
      2026-09-10 walked 4 windows and published **0**, and the archived audit says why —
      stage 1 `NO BILLABLE USAGE DATA held locally`, then stage 2 **`remote usage data for this
      interval is NOT AVAILABLE`**. It never reached the compare stage. The site's Amber data
      begins at 2026-07-07 and the store now covers it in full.
      🛑 `observations: 0` from `liveone sync` is TWO different outcomes and the number cannot tell
      them apart. `updateUsage` exits at stage 1 when local already holds billable data —
      *without calling the vendor at all* — and at stage 2 when the vendor returns nothing. A
      control re-run of the known-good 2026-07-07 → 2026-07-13 window also published 0, by the
      first path (`yay, we already have BILLABLE usage data locally`). What separates them is
      `landed.seriesCovering` (22 vs **0**) and the `discovery` strings archived in
      `sessions.response`; read those before concluding a vendor is empty.
- [ ] **Delete the `observations` queue object.** Nothing publishes to it as of the cutover, but the
      object still exists on the QStash account. 🛑 Deleting it destroys anything still waiting, and
      those messages' outbox rows are already marked `published_at`, so the relay would never
      re-send them. "Nothing enqueues" is not "nothing is waiting" — gate on a drained queue read
      from QStash, verified, not on the code change.
- [ ] **The DLQ retry path cannot choose a lane.** It calls `publishObservationMessage(row.payload)`
      and pre-lane payloads default to `live`, so retrying the 8 stored messages would put ~13,000
      observations on the live lane.
- [x] Report rows **received**, not published. `liveone sync` (`POST /api/v4/devices/{id}/sync`)
      replaces the browser-only SSE path: it reports `published` and `landed` as two separate
      numbers, never says "inserted", chunks to the VENDOR's window rather than a number we invented,
      and publishes on the `backfill` lane. A verification that timed out reports `UNKNOWN`, not a
      measured zero.

## Status

**Availability: resolved** 2026-09-09. **Data: recovered** 2026-09-10, and the recovery is
**complete rather than merely done** — the window below it was probed on the same day and Amber has
nothing there, so no further history is retrievable and nothing is expiring. See the Action Items
above.

The recovery also happens to be the plan's headline verification, run for real rather than on a
fixture: while 12,096 observations queued on the `backfill` lane (12 messages waiting at one
sample), live ingest never aged past **0.4 minutes** and the `live` lane never had anything
waiting. `queue timing` over the window: 23 batches, 23 delivered, **0 failed, 0 retries**, live
batches at 767 ms and a wait of 171 ms. Under the FIFO queue those 12 backfill messages would have
been ahead of every live poll — which is precisely what happened on 2026-09-09.

One thing worth noting about the gap that made this necessary: the coverage-repair cron could never
have found it. Its window floor is `commissioned_on`, and the device was only created 2026-09-08.

Working notes and the migration plan: `docs/plans/ingest-head-of-line-hardening.md`.
