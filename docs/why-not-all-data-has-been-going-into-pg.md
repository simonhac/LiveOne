# Why not all data has been going into Postgres

_Status: 2026-06-07. Companion to [`turso-pg-migration.md`](./turso-pg-migration.md). This explains
**why the Postgres mirror is behind Turso** for some readings — the root causes, where they live in
the code, and what stops each one._

## TL;DR

Turso is still the system of record for readings; Postgres is fed a **copy**. That copy is behind in a
few specific, now-understood ways. None of these is a single "data loss event" — they're structural
properties of a **transitional, asynchronous, best-effort mirror**, plus a couple of bugs that have
since been fixed. Concretely, PG can be behind Turso wherever:

1. the async queue **dropped a message** during a mirror outage,
2. a **late 5m-native refinement** (Amber/Enphase) was discarded by the receiver, or
3. a historical **timestamp-truncation** artifact diverged the two stores,

and the **recomputed aggregates inherit any raw hole** by design.

---

## 1. The mirror is asynchronous and best-effort

Each poll writes raw readings to **Turso inline** (synchronous), then **publishes** them to an Upstash
**QStash** queue; a receiver route (`app/api/observations/receive/route.ts`) mirrors the queue into
Postgres.

The publish side is **fire-and-forget with swallowed errors**
(`lib/observations/publisher.ts`, `lib/observations/poll-collector.ts`): if the enqueue throws
(network blip, auth, receiver unreachable), the error is logged and **not re-thrown**, so the poll
still reports success. The reading is safe in Turso, but it **never enters the queue and never reaches
PG**.

That asymmetry — **Turso synchronous, PG best-effort** — is the root shape of every gap below. It was a
deliberate choice (the mirror must never break live ingestion), but it means PG completeness depends on
the queue + receiver being continuously healthy.

## 2. ~9 "mirror down" windows in 2026

The receiver was intermittently unreachable or erroring across roughly **9 windows in 2026**. Known
contributors:

- A **Clerk-middleware 404** on `/api/observations/receive` (the route wasn't allow-listed, so the auth
  middleware intercepted it) — since fixed by allow-listing `/api/observations(.*)`.
- An **un-awaited `protect()`** middleware no-op (`middleware.ts`) — fixed in PR #12.

QStash retries failed deliveries (at-least-once), but a **multi-hour** outage exhausts the retry budget
→ messages move to the **DLQ** and, past retention, are dropped. Turso still had those readings (the
inline best-effort backup); PG got the holes. **Live ingestion works again** — these are _historical_
holes, but they must be backfilled before PG readings can be trusted.

## 3. Late 5m-native refinements are dropped (Amber / Enphase)

Amber and Enphase are **5m-native**: they emit 5-minute aggregates directly and have **no raw
`point_readings`**. Amber additionally sends **late, multi-day `updateUsage` revisions** — e.g. an
interval first reported as `"estimated"` is later restated as `"billable"` with a corrected value.

On the Turso side this works: `updateUsage` → `storeRecordsLocally` → `insertPointReadingsAgg5m`
**upserts** the refined past interval **and re-publishes it** to the queue with the full aggregate
tuple (the publish at `lib/point/point-manager.ts:1129` fires because a session is present).

The break is in the **receiver**: `insert5mObservations` inserts 5m rows with
**`onConflictDoNothing`** (`app/api/observations/receive/route.ts:177-184`). So the re-published refined
values hit the existing key and are **silently discarded** — PG keeps the first, stale copy. The daily
1d rollup, which reads PG 5m, then inherits the stale value for that system.

> The receiver's own comment names this: _"Re-refined 5m intervals won't propagate; that drift is
> reconciled by the (deferred) Turso backfill while Turso remains source of truth."_

## 4. A historical whole-second duplication bug

The queue path once serialised timestamps **without milliseconds** (`formatTime_fromJSDate` in
`lib/date-utils.ts`), so a reading delivered via the queue landed on a **whole second**
(`…:00.000`), while the same reading written inline to Turso (or via the direct backfill) kept its
**sub-second** precision (`…:00.611`).

For millisecond-precision vendors (e.g. Mondo, system 6) PG therefore accumulated **two** copies of the
same reading as distinct rows under the unique index. This is a _divergence_, not a shortfall — and it's
been cleaned up by `scripts/dedupe-pg-truncated-readings.ts` (delete the truncated copy, keep the
sub-second one, then recompute the affected 5m/1d). Whole-second-native vendors (e.g. Selectronic) were
never affected. Included here for completeness of the "PG ≠ Turso" picture.

## 5. Aggregates inherit raw holes — by design

With `AGG_COMPUTE_IN_PG` enabled, Postgres **recomputes** its raw-vendor 5m and 1d aggregates from its
**own** `point_readings` (`lib/db/planetscale/aggregate-points-pg.ts`) — it does not copy Turso's
aggregates. That's the whole point: PG must be able to stand on its own once Turso is gone.

The consequence: anywhere PG raw is short (causes 1–2 above), the PG-computed aggregate has **fewer
samples** than Turso's for that interval. The value reconciler (`scripts/reconcile-agg-values.ts`)
compares `sampleCount` **exactly**, so it flags those intervals as mismatches and goes **RED**. The
aggregate "gap" is therefore **downstream of the raw gap**, not an independent problem — fix the raw and
the aggregate follows.

## What we actually found (2026-06-07)

When this was investigated against prod, the concrete picture was narrower than the headline "PG raw is
incomplete":

- **PG raw was complete.** The earlier "PG has 43–48% of Turso's rows" was a **measurement artifact**:
  node-postgres serializes JS `Date` query parameters in the client's local timezone, and on a non-UTC
  workstation that shifts a `WHERE measurement_time >= …` boundary against the UTC `timestamp` columns by
  the local offset (~10h here), making the first day of any window look ~45% short. Re-run with `TZ=UTC`,
  PG raw ⊇ Turso for all of 2026. **Always run cross-store scripts with `TZ=UTC`.**
- **The real divergence was at the 5-minute layer**, exactly as §2/§3 predict: a tranche of PG `agg_5m`
  was missing or stale (queue-mirror gaps before PG started computing its own aggregates; plus Amber's
  dropped late refinements), which made one day's `agg_1d` short and Amber's `agg_5m` stale.
- **Fix:** recompute PG 5m from PG's (complete) raw + re-copy Amber's refined 5m from Turso + recompute
  1d → the value reconciler went **green**. The receiver now upserts 5m-native data so it won't recur.

So §1–§5 below are the _mechanisms_; in this instance the damage had reached the aggregates, not the raw.

---

## What makes it stop

| Cause                                 | Remediation                                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical raw holes (§1, §2)         | **Backfill PG raw**, then **recompute** raw-vendor 5m/1d from PG raw, then **reconcile green** (`scripts/gap-map-raw-readings.ts` → `scripts/backfill-turso-to-postgres.ts` → `scripts/recompute-pg-range.ts` → `scripts/reconcile-agg-values.ts`). |
| Dropped 5m-native refinements (§3)    | **Re-backfill** the affected 5m (the backfill upserts agg_5m) to heal history, **and** make the receiver **upsert 5m for 5m-native systems** so future late data auto-heals.                                                                        |
| New "mirror down" windows (§1, §2)    | A **mirror-health monitor + alert** (response-presence + DLQ/queue-lag) so an outage is caught in minutes, not discovered weeks later.                                                                                                              |
| The best-effort asymmetry itself (§1) | End-state: a **synchronous PG raw write** (migration Phase 4) removes the asymmetry entirely; until then, at-least-once queue durability + the monitor cover it.                                                                                    |

See [`turso-pg-migration.md`](./turso-pg-migration.md) for the full phased plan and status, and
[`backfill-turso-to-postgres.md`](./backfill-turso-to-postgres.md) for backfill mechanics.
