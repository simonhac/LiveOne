# Turso → Postgres migration — status, plan & reference

The **single source of truth** for LiveOne's Turso→Postgres migration: current status, locked
decisions, the phased forward plan, risks, and the durable dev/ops reference. (Consolidates the
former `postgres-primary-migration-plan.md` and the two `observations-pg-*` docs.)

> **Keep this doc tight.** State each fact once. Resolved work goes to the one-line
> [History log](#history-log) at the bottom — don't re-narrate it in the status/plan sections.

## Goal

LiveOne records energy data into **Turso** (libsql/SQLite, Tokyo) as the system of record, with a
**Postgres** mirror (PlanetScale-hosted Postgres, not MySQL) fed asynchronously via an Upstash
**QStash** queue (publisher → receiver route). Goal: **make Postgres the primary** (serve reads from
it; move the config tables to it), demote **Turso to a transitional best-effort backup**, then
**decommission Turso**. End-state is Postgres-only, with Vercel + PlanetScale in **Sydney
(ap-southeast-2 / `syd1`)**. Staged, flag-gated, multi-PR. The deeper reason is to cleanly separate the
data-collection **engine** from the **web/FE** — see [Direction of travel](#direction-of-travel--engineweb-separation).

## Current status (2026-06-10)

- **Phase 1 — config authority on PG: ✅ LIVE** (cut over 2026-06-07). PG is the system of record for
  config (`systems`, `point_info`, `users`, `user_systems`, `polling_status`, `share_tokens`); Turso
  config is a stale, no-longer-written mirror.
- **Phase 2 — readings & aggregation:**
  - **PR-11 (`AGG_COMPUTE_IN_PG`) ✅ enabled in prod** — PG computes its own raw-vendor 5m + 1d.
  - **Reconciler GREEN, all systems, over a settled window** (incl. the fresh post-midnight 1d):
    `agg_5m --days=2` 19966/19966, `agg_1d` clean, 0 value mismatches.
  - **PR-12 (readings reads shadow, `#19`) ✅ shipped; burn-in GREEN.** Ran `READINGS_READS_FROM_PG`
    ON = shadow (serve Turso, concurrently read PG, compare, log `[READINGS-SHADOW] DIVERGE`).
  - **PR-13a (serve readings FROM PG) ✅ LIVE** — merged `#24`; `READINGS_READS_FROM_PG` flipped true in
    prod 2026-06-09; PG serves `/api/history` + admin point-readings, Turso = fallback. See
    [Phase 2](#phase-2--readings--aggregation-on-postgres).
  - **PR-13 (trim raw-vendor 5m/1d double-write) ✅ LIVE** — merged `#26`; PG is the sole raw-vendor
    aggregator. Burn-in GREEN 2026-06-09 (queue resumed → lag 0; reconciler `agg_5m --days=2`
    20010/20010, `agg_1d` June 261/261, 0 mismatches).
- **Phase 3 — PlanetScale → Sydney: ✅ LIVE** (cut over 2026-06-10). Prod PG is now the 3-node HA
  `sydney` branch (`aws-ap-southeast-2`); us-east `main` is the hot-standby rollback for the burn-in.
  **Vercel compute → `syd1` ✅ LIVE 2026-06-10** (PR #31; confirmed by function region `syd1` on a live
  request) — engine co-located with PG; the still-live Turso inline write is now the cross-region hop
  (R8) until Phase 5.
- **Phase 4a — PG raw-durability outbox: ✅ DEPLOYED + SOAKING** (merged `#32`; migration `0004` applied
  to prod Sydney PG; `WRITE_OUTBOX=true` flipped on 2026-06-10; relay draining, backlog ~0; Slack alerts
  wired). ~30h soak in progress. See [Phase 4](#phase-4--pg-raw-durability-non-destructive-turso-untouched).
- **Live pipeline healthy:** QStash lag 0 / DLQ 0; PG mirror response-presence 100%, raw landing
  < 1 min old. (Aggregation is order-independent, so queue parallelism may be raised safely.)

**Whole-history parity (read-only sweep, all `TZ=UTC`, prod; first data 2025-08):**

| Check                                        | Window                               | Result                                   |
| -------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| Raw `point_readings` deficits (`gap-map`)    | 2025-01-01 → 2026-06-08              | ✅ 0 — PG ⊇ Turso on every (system, day) |
| `agg_5m` value parity, all systems (chunked) | inception → 2026-06-08 (~3.31M rows) | ✅ 0 mismatches                          |
| `agg_1d` value parity                        | all 2025 (5900) + all 2026 (6106)    | ✅ 0 mismatches                          |

"Complete" = complete **relative to Turso** (the gap-map flags only days where PG < Turso; a reading
that never reached Turso is a collection gap, invisible to a two-store diff). The `agg_5m` sweep is
chunked by month/quarter because one multi-month Turso response exceeds the libsql client's
`ERR_STRING_TOO_LONG` decode limit — a tooling limit, not a data issue.

## What's next (ordered by dependency)

1. **Phase 3 tail — close out the region move.** PlanetScale→Sydney ✅ live and **Vercel→`syd1` ✅ live**
   (both 2026-06-10). Remaining: finish the 24–48h burn-in green, then decommission us-east `main` (one-off
   `pscale backup create` first). `main` is purely the region-move rollback (rollback = repoint `DB_*` +
   redeploy, then heal `main` from Turso since it stopped receiving at cutover) — decoupled from Turso.
   _(Planned tomorrow, ~30h after cutover.)_
2. **Phase 4 — PG raw durability (non-destructive).** **4a outbox + relay ✅ DEPLOYED** (merged `#32`,
   `WRITE_OUTBOX=true` flipped on 2026-06-10); **soak in progress** — running ~30h alongside the Turso
   inline write, proving zero loss and an ≈0 relay backlog. Remaining: complete the green soak window,
   then Phase 5. Fully reversible (`WRITE_OUTBOX=false`). This is the gate for Phase 5.
3. **Phase 5 — Turso decommission (destructive).** Cut the ungated Turso writes (raw, sessions, local
   agg), fold in the deferred dead-publisher cleanup (`publishObservationBatch` + its no-collector arms,
   the gated 1d Turso→PG mirror — kept until now as the `AGG_COMPUTE_IN_PG=false` rollback path), retire
   the now-dead flags, drop the `*_backup`/archive tables, decommission `liveone-tokyo`.
4. **Decommission-time hardening (gated, not blockers):** PG FK rebuild, R4 Turso-FK drop, session-FK
   validation.

## Locked decisions

- **Reads** flip to Postgres (accept queue lag). **Raw** keeps the async dual-write (Turso inline
  best-effort backup + queue → PG).
- **Sessions** go through the queue, PG-mirrored (not synchronous in PG). _[done — PR-7]_
- **(E) Session id = UUIDv7, app-generated; (E1) text in both DBs** (`sessions.id`,
  `point_readings.session_id`, `agg_5m.session_id`) — historical = stringified ints, new = UUIDv7
  (time-ordered as text). _[done — PR-7]_
- **Enphase/Amber** (5m-native, no raw) keep flowing their 5m through the queue.
- **(A) Aggregation ported to Postgres** for raw vendors (Selectronic/Fusher) via deferred idempotent
  recompute; 5m-native vendors' 5m stays queue-fed. _[done — PR-11]_
- **(B) Config writes → Postgres only**; **drop the FK constraints on the Turso readings tables** so the
  Turso raw backup survives with config rows living only in PG. Config rollback relies on **PG PITR** +
  a pre-cutover Turso snapshot. _[config writes done; Turso-FK drop is decommission-time]_
- **(C) Dev = shared PlanetScale dev branch** + hard guardrails + PITR backstop.
- **(D) Move PlanetScale, then Vercel, to Sydney** — **separate windows** _(sequencing set 2026-06-09)_:
  PlanetScale moved first (✅ 2026-06-10); the Vercel compute→`syd1` window follows immediately _(brought
  forward 2026-06-10 to precede the Phase 4 outbox so its PG write is local)_. Turso stays in Tokyo,
  decommissioned at Phase 5.
- **(F) Turso = transitional backup of raw + sessions only** _(2026-06-06)_ — no lasting status. Config
  **and** all aggregates leave Turso entirely (PG is the sole aggregator); design as if **PG is the only
  store**, with the inline Turso write an extra best-effort backup deletable with zero architectural
  change. Retire Turso once **raw-durability-on-PG** is proven — not on any feature it provides.
- **(G) Engine/web separation is the end goal** _(2026-06-06)_ — two independently deployable units
  (collection engine vs web/FE); Postgres + KV + QStash + an engine Control API are the only
  cross-boundary contracts. See [Direction of travel](#direction-of-travel--engineweb-separation).

## Two table classes (until Turso decommission)

- **Config (authoritative in PG):** `systems`, `point_info`, `users`, `user_systems`,
  `polling_status`, `share_tokens`. Dev-only `clerk_id_mapping`/`sync_status` out of scope.
- **Readings (queue → PG; Turso best-effort backup):** raw `point_readings` (dual-write), sessions
  (queue), 5m-native 5m (queue). Raw-vendor `agg_5m`/`agg_1d` computed in PG (idempotent recompute),
  not mirrored to Turso.
- **Out of scope — legacy, never migrated:** the old `readings` / `readings_agg_5m` / `readings_agg_1d`
  tables (superseded, no longer read) are left behind and dropped when Turso is decommissioned. The
  migration concerns `point_readings*` only.

## Durability model (today vs end-state)

Answers "do we ever drop a reading before it's in PG?" — **not via QStash alone, and that's intentional
for now.** A poll writes **Turso inline (synchronous — the real durability anchor)** then **best-effort
enqueues to QStash** (`publishObservationBatch` swallows enqueue errors — "do NOT break the database
insertion"); there is **no synchronous PG write** (PG is fed only by the receiver). Once enqueued, QStash
is at-least-once with retries → **DLQ**; the receiver is idempotent and its aggregation is
**order-independent** (successor-recompute + per-system advisory lock), so parallelism > 1 is safe. So the
guarantee is **"Turso has it, and PG holes heal from Turso"** via idempotent `gap-map-raw-readings.ts
--apply` — exactly how 2026's ~9 mirror-down windows were repaired. Gaps QStash itself doesn't close
(swallowed enqueue, crash mid-poll before publish, stranded DLQ) are caught by the every-15-min
`monitor-observations` cron + the Turso backstop. **"Never drop until ingested into PG" is the Phase-4
goal** (the transactional outbox — a committed PG capture relayed at-least-once with monitoring) —
**4a now DEPLOYED + soaking (`WRITE_OUTBOX=true`, 2026-06-10)**; until that soak is green Turso can't be
decommissioned (decision F).

## Cutover pattern & flag semantics

**Every cutover:** take a fresh Turso snapshot first, land via a PR (never direct-to-`main`), stay
revertible by flag flip. If ingestion misbehaves, **pause the queue** from `/admin/observations` —
Turso keeps serving; backfill writes are idempotent (worst case `TRUNCATE` the PG table(s) and re-run).

- **Config flags** (`lib/db/config-shadow.ts`): READS on + SERVE off = **shadow** (serve Turso, read
  PG, compare, log `[CONFIG-SHADOW] DIVERGE`; PG errors swallowed). SERVE on = **serve PG** (Turso
  fallback on error, logged `[CONFIG-SERVE]`). WRITES on = config writes hit **PG only**. _Config cut
  over 2026-06-07 by flipping `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` together; rollback = flip
  both off + PG PITR (writes made to PG after cutover aren't in Turso)._
- **Readings flag** — a **single** flag `READINGS_READS_FROM_PG`, repurposed across the phase:
  - **Shadow (PR-12, shipped):** ON = serve Turso + concurrent PG read + compare + log
    `[READINGS-SHADOW] DIVERGE`.
  - **Serve (PR-13a, ✅ live):** ON = `serveReadings` serves PG, falls back to Turso (logged
    `[READINGS-SERVE]`) only on error / `SHADOW_SKIP`; OFF = serve Turso. Flipping shadow→serve is a
    **code change** (`readings-shadow.ts` → `readings-serve.ts`), not just a flag flip.

## Phased plan (detail)

### Phase 1 — Config authority → Postgres ✅ DONE (cut over 2026-06-07)

Config tables authoritative in PG; `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` flipped together.
Read/write/serve seam was PR-8/9/10 (`lib/db/config-shadow.ts`, `lib/db/routing.ts`). Pre-flight: fresh
snapshot, full Turso↔PG parity (`scripts/parity-config-turso-vs-pg.ts`), write-routing completeness
audit. Verify: `[CONFIG-SERVE]` ≈ 0, a real config edit (rename / add viewer) lands in PG,
`userHasSystemAccess` correct. Rollback: flip both flags off + PG PITR. See [History](#history-log).

### Phase 2 — Readings & aggregation on Postgres

_PR-11 (agg in PG) → PR-12 (reads shadow) → PR-13a (serve from PG) → PR-13 (trim publishers)._

**Goal:** serve all reads from PG and compute raw-vendor aggregates in PG; trim redundant Turso
publishers.

**PR-11 — PG aggregation** (`AGG_COMPUTE_IN_PG`, ✅ enabled). Idempotent recompute of raw-vendor 5m + 1d
keyed `(systemId, intervalEnd)` / `(systemId, day)` over landed PG data (`onConflictDoUpdate`).

- Per-point math is a **shared db-free module** `lib/aggregation/point-aggregates.ts`
  (`aggregate5mForPoint`, `aggregate1dForPoint`) called by **both** the Turso writers and the PG
  recompute → values identical by construction (the parity the reconciler proves).
  `dayToUnixRangeForAggregation` moved here too (fixed a latent negative-fractional-tz bug).
- **5m:** `lib/db/planetscale/aggregate-points-pg.ts` `recomputeAgg5mForIntervals`; the receiver
  recomputes the touched intervals from PG raw after the raw-insert tx commits (best-effort, awaited),
  matching Turso's granularity. `transform='d'` `previousLast` is read from PG raw. **Order-independent
  (parallelism > 1 safe):** the receiver also rebuilds each touched interval's immediate successor
  (`withSuccessorIntervals` — a 'd' delta depends on the previous interval's last) and the whole
  recompute runs under a per-system `pg_advisory_xact_lock`, so out-of-order / parallel delivery still
  converges to the correct value (whichever recompute runs last under the lock sees all committed raw).
  In-order delivery is byte-identical to before. Points absent from the PG `point_info` mirror are
  **skipped**.
- **1d:** `recomputeAgg1dForDay` from PG 5m; the daily cron computes 1d in PG **instead of** publishing
  the Turso 1d queue-mirror when the flag is on (else the async queue overwrites the PG-computed rows).
- **5m-native (Enphase/Amber) is disjoint** — no raw `point_readings`, so the recompute never touches
  it; their 5m stays queue-fed, and the receiver **upserts** 5m-native rows (`#15`) so Amber's late
  `updateUsage` refinements heal automatically.

**PR-12 — readings reads → PG (shadow): ✅ SHIPPED (`#19`).** Generic harness, single flag
`READINGS_READS_FROM_PG` (see [flag semantics](#cutover-pattern--flag-semantics)). Wired sites: the live
read path is the **raw SQL in `app/api/history/route.ts`** (extracted to `lib/history/build-series.ts`,
mirrored by `lib/history/readings-pg.ts`) + the two admin point-readings routes
(`lib/db/planetscale/readings-read-pg.ts`). PG `agg_1d` has no `data_quality` → emitted null; live-tail
lag + that gap are presence-only (never a hard divergence). "latest" stays on KV. **generator-events
DEFERRED** — unbounded full-history hack, rewrite to a bounded range before migrating it.
_Not the live path: `lib/history/point-readings-provider.ts` / `history-service.ts` (dead code);
`app/api/data/route.ts` (config + KV-latest, not readings)._

**PR-13a — serve readings FROM PG: ✅ DONE (merged `#24`, flag flipped true 2026-06-09).**
`readings-shadow.ts` → `readings-serve.ts`; `shadowServeReadings` → `serveReadings(label, pgServe,
tursoServe)` (one store read on the happy path; Turso fallback on error/`SHADOW_SKIP`, logged
`[READINGS-SERVE]`). Shadow comparators unwired from the request path (kept as exported, tested
helpers).
**Cutover sequence (executed):** set `READINGS_READS_FROM_PG=false` in prod → merge + deploy **dark**
(flag off = serve Turso) → fresh Turso snapshot + confirm PG PITR + re-run reconciler → flip flag
**true** (serve PG). Admin readings ~10× faster (PG < 1s vs Turso 10–13s). **Rollback:** flip false
(instant).

**PR-13 — trim publishers (cutover): ✅ DONE (merged `#26`, burn-in GREEN 2026-06-09).** Trimmed the
raw-vendor Turso→queue 5m/1d publish + the receiver's raw-vendor 5m / all-1d inserts (now straggler-safe
no-ops), gated behind `AGG_COMPUTE_IN_PG`; **kept** raw, sessions, and 5m-native 5m on the queue.
Turso still computes its own local 5m/1d (untouched) so the reconciler stays a valid gate. **Rollback:**
`AGG_COMPUTE_IN_PG=false` restores publish + intake exactly. Removed branches retained as no-ops until
the Phase-5 cleanup.

### Phase 3 — Region move to Sydney (PlanetScale ✅ DONE 2026-06-10; Vercel→`syd1` in progress)

Prod Postgres is the **`sydney` branch** of `liveone` (`aws-ap-southeast-2`): `PS-5-AWS-ARM`, `replicas: 2`
(3-node HA), `production`, PG 17.10, `TimeZone=Etc/UTC` — same compute tier as the old us-east node, HA
added. us-east `main` is kept hot as the burn-in rollback.

**Vercel→`syd1` (no longer deferred — decided 2026-06-10):** move compute to Sydney to co-locate the
engine with PG before the Phase 4 synchronous PG write. Mechanism: one-line `vercel.json`
`"regions": ["hnd1"]` → `["syd1"]` (no dedicated CLI command — region is deploy config; `vercel.json`
makes it durable across deploys, vs. a per-deploy `--regions syd1`), land via PR → `main` auto-deploy.
This relocates the crons (poller/daily/db-stats/monitor-observations) **and** `/api/history` serving to
Sydney. **Latency inverts:** PG reads/writes become local (the goal); the still-load-bearing **Turso
inline write becomes cross-region** (Sydney→Tokyo ~100ms, awaited) until Phase 5 deletes it — acceptable
for a minutely small write, and the reason the move precedes the outbox. **Verify:** runtime
`VERCEL_REGION=syd1`, crons firing from syd1, poll/PG-read latency. **Rollback:** revert the one line,
redeploy. The branch was created in one command (HA + production land at create —
no change-request / `promote`), and inherited PITR automatically since backup schedules are database-wide:

```
pscale branch create liveone sydney --region aws-ap-southeast-2 --cluster-size PS-5-AWS-ARM --major-version 17
```

**How the cutover was done** (reference for future region moves): **pause the queue** (collection keeps
writing Turso; QStash buffers for days) → **`pg_dump -Fc` → `pg_restore`** us-east→Sydney over the
**direct port 5432** (the 6432 pooler rejects `pg_dump`/`pg_restore`), excluding the platform-managed
`hypopg`/`pscale_extensions` → re-point prod `DB_HOST`/`DB_USERNAME`/`DB_PASSWORD` (the app uses discrete
`DB_*` via the pooler) to the Sydney Default role + `vercel redeploy` → **resume** → drain the backlog →
**recompute the boundary day** (`recompute-pg-range.ts --apply`, since its `agg_1d` was cloned mid-day) →
verify against Sydney (`gap-map-raw-readings` 0 deficits, `reconcile-agg-values` clean). Zero collection
downtime: the poll's only PG write, `polling_status`, is swallowed (`lib/polling-utils.ts`), so readings
land in Turso + queue regardless. **Rollback:** repoint `DB_*` to us-east + redeploy, then heal `main`
from Turso (`gap-map --apply` + `recompute`) since it stopped receiving at cutover.

### Phase 4 — PG raw durability (non-destructive; Turso untouched)

The exit-condition for dropping Turso: raw readings durable on PG **without** the inline-Turso safety
net. With session-id minting already off Turso (PR-7), this reduces to building + soaking the
**transactional outbox** of [`architecture/engine-web-separation.md`](architecture/engine-web-separation.md)
§6.4 — the chosen mechanism (decision 2026-06-08) over "accept queue-only at-least-once". Everything here
is additive and reversible while Turso still backs everything.

- **4a — outbox + relay ("the PG bin before the queue"). ✅ DEPLOYED (merged `#32`); `WRITE_OUTBOX=true`
  live 2026-06-10, soak in progress.** New `observations_outbox` table (PG, migration `0004`) holding each poll's built
  `QueueMessage` (env, session, observations) — the durable PG capture. The publish seam
  (`poll-collector.ts` `publishPoll`, `publisher.ts` `publishObservationBatch`) **tees**: when
  `WRITE_OUTBOX` is on it `persistOutbox()`s the same messages **in parallel with** the unchanged live
  direct enqueue. A **relay** (`app/api/cron/relay-outbox`, minutely; `lib/observations/outbox.ts`
  `drainOutbox`) drains unpublished rows → QStash → the existing idempotent receiver, marking rows
  published on ack (`FOR UPDATE SKIP LOCKED`, per-row short tx, GC of published rows after
  `OUTBOX_GC_DAYS`). The outbox row is the committed capture, retried until acked — closing the
  swallowed-enqueue (`lib/observations/publisher.ts`) and crash-at-session-close-publish windows. The
  receiver is **unchanged**; double-delivery (direct + relay) is safe (idempotent upserts +
  order-independent recompute). _**Locked decision (2026-06-10):** the outbox carries the **message**
  (the same `QueueMessage` put on the queue); **collection never writes the serving store**
  (`point_readings`/aggregates) directly — the queue + receiver materialise it, keeping data collection
  decoupled from the source of truth. §6.4's alternative direct `point_readings` write at poll time is
  **rejected** (couples collection to the source of truth; breaks the §6.1 single-writer invariant). The
  remaining step to full decoupling is the **relay-primary cutover** — drop the parallel direct enqueue so
  the outbox is the only on-ramp — done attended after the soak; if its relay-cadence lag matters, run the
  relay more often / inline, never a direct serving-store write._
  **Residual (accepted):** the tee fires at session close, so it inherits R3/R7's crash-mid-poll-before-
  close window (backstopped by the Turso inline write + `gap-map` through Phase 4). **Rollback:**
  `WRITE_OUTBOX=false` (instant) — direct enqueue + Turso unchanged throughout, so ingestion never
  depended on the outbox; the relay goes inert.
- **4b — "queue as sole path" hardening** (§6.5): a **monotonicity guard** on the 5m-native/1d upserts
  (today correctness leans on QStash `parallelism=1` ordering — a broker setting, not a data invariant;
  `aggregate-points-pg.ts` `previousLast`); **DLQ drain/replay-from-source** tooling (`monitor-observations`
  only alerts today); **SLOs + paging** on lag/DLQ/receiver-success/raw-landing-age
  (`OBSERVATIONS_ALERT_WEBHOOK_URL` now set in prod → Slack, tested 2026-06-10; the broader SLO set is
  still TODO); a **read-after-write** path for interactive "poll now & show result".
- **4c — soak.** Run outbox+relay alongside the Turso inline write; prove zero loss via the reconciler /
  `gap-map`, the outbox backlog stays ≈0 (`monitor-observations` now alerts on
  `outbox_backlog_high`/`outbox_stale`), and that PG heals _from itself_ (replay outbox/PG), not from
  Turso. **Rollback: `WRITE_OUTBOX=false`** — the Turso inline write still anchors durability.

### Phase 5 — Turso decommission (destructive; gated on Phase 4 soak green)

Once raw durability on PG is proven without the inline-Turso net:

- **Cut the ungated Turso writes:** raw `point_readings` inline (`lib/point/point-manager.ts`), sessions
  backup (`lib/session-manager.ts`), Turso local 5m/1d compute.
- **Dead-publisher cleanup + retire dead flags:** remove `publishObservationBatch` + its no-collector
  arms + the gated 1d Turso→PG mirror (kept until now as the `AGG_COMPUTE_IN_PG=false` rollback path);
  then retire `AGG_COMPUTE_IN_PG`, `CONFIG_WRITES_TO_PG`, `CONFIG_SERVE_FROM_PG`, `READINGS_READS_FROM_PG`,
  and the Turso read-fallback in `serveReadings`. (`CONFIG_READS_FROM_PG` + the config shadow-compare path
  are already inert — deletable any time as the smallest standalone cleanup.)
- **Decommission-time hardening:** PG FK rebuild (staged `0004`), R4 Turso-FK drop, optional session-FK
  validation, re-point the dev-seed (`db:sync-prod`) to seed from PG.
- **Drop Turso:** `sessions_archive` / `*_backup` / legacy `readings*` tables; decommission `liveone-tokyo`.

### Loose ends / hardening (independent of the phases)

- **Session FK validation (optional):** the FK is `NOT VALID` (enforces all new rows). To fully
  validate, NULL the ~4,165 unrecoverable orphan `session_id`s (the 2025-11-27 final purge-window block,
  ids 301,141–305,599 — ~59,730 orphan reading rows) then `VALIDATE CONSTRAINT`, or leave `NOT VALID`
  (preserves their dangling ids). NULL-then-VALIDATE mutates ~60K prod rows → needs explicit go-ahead;
  default is leave-as-is.
- **Dev-seed path:** `db:sync-prod` → `scripts/sync-prod-to-dev.js` (missing) and the `sync-database`
  seed from prod Turso go stale once PG is authoritative — re-point to seed dev from PG.

### PG foreign-key rebuild (decommission-time hardening)

PG was built FK-less for receiver throughput (only `point_readings.session_id → sessions.id` exists,
`NOT VALID`). This rebuild restores the relational graph. **Decommission-time, NOT a cutover blocker;**
runs _after_ the write-to-PG cutover is stable + the reconciler shows agg value-parity, and _before_
Turso/`*_backup` tables are dropped (so orphan-backfill stays possible). Creds stay in Clerk → nothing
here touches credentials; `users` stays a passive Clerk mirror (its inbound FKs deliberately **not**
enforced — see skips).

**Decisions (locked 2026-06-06).** `onDelete`: only trivial rows cascade; everything in the data lineage
is `NO ACTION`, so tearing down a system is always explicit + ordered — never a silent cascade over 13M
readings.

| #   | Constraint (DB identifiers)                                                | onDelete  |
| --- | -------------------------------------------------------------------------- | --------- |
| 1   | `polling_status.system_id → systems.id`                                    | CASCADE   |
| 2   | `user_systems.system_id → systems.id`                                      | CASCADE   |
| 3   | `users.default_system_id → systems.id`                                     | SET NULL  |
| 4   | `sessions.system_id → systems.id`                                          | NO ACTION |
| 5   | `point_info.system_id → systems.id`                                        | NO ACTION |
| 6   | `point_readings.(system_id, point_id) → point_info.(system_id, id)`        | NO ACTION |
| 7   | `point_readings_agg_5m.(system_id, point_id) → point_info.(system_id, id)` | NO ACTION |
| 8   | `point_readings_agg_1d.(system_id, point_id) → point_info.(system_id, id)` | NO ACTION |

**Skips:** the redundant single-column `point_readings.system_id → systems` (transitively guaranteed via
#5 + #6); the Clerk-mirror FKs `user_systems.clerk_user_id` / `share_tokens.owner_clerk_user_id →
users.clerk_user_id` (the mirror lags the Clerk webhook → would fail membership/token writes; 0 drift
today, but write-time lag is the risk). **Keep** the existing session FK. **GOTCHA:** `point_info`'s
per-system key is DB column **`id`** (the Drizzle TS field is named `index` → `integer("id")`); the
composite PK is `(system_id, id)`. FK target is `point_info(system_id, id)`, never `(…, index)`.

**Pre-flight audit (`scripts/audit-pg-fk-orphans.ts`, read-only, 2026-06-06 vs prod):** all 8 proposed
constraints are **0-orphan → add + validate cleanly**. Row counts: `point_readings` 13.4M, `agg_5m`
3.3M, `sessions` 870K, `agg_1d` 11.9K, `point_info` 73, `systems` 9. So #4/#6/#7 (large) use `ADD … NOT
VALID` + a separate `VALIDATE` (validating scan under non-blocking `SHARE UPDATE EXCLUSIVE`); the rest
validate inline. **Re-run the audit immediately before executing** — 0-orphan is a point-in-time fact.

**Execution (the `0003` precedent).** Update `lib/db/planetscale/schema.ts`
(`.references(…, {onDelete})` for #1/#2/#3, plain `.references()` for #4/#5, composite `foreignKey({…})`
in the `point_readings*` table callbacks). Then `db:pg:generate`, **hand-edit** the generated
`drizzle-planetscale/0005_*.sql` to split #4/#6/#7 into `NOT VALID` + `VALIDATE` and add `pg_constraint`
re-run guards, then `db:pg:migrate`. Snapshot Turso + confirm PG PITR first. **Forbidden:** `push`.
_(0004 is now the `observations_outbox` table — Phase 4a; the FK rebuild is the next migration, 0005.)_

Staged SQL (reference — do **not** drop into `drizzle-planetscale/` or apply until the gate above; add
`--> statement-breakpoint` between statements when promoting to a real migration):

```sql
-- 0005_fk_rebuild.sql (STAGED). Pre-flight 2026-06-06: all 0-orphan.
-- Group A — trivial rows → systems (CASCADE / SET NULL) + small tables, validate inline
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='polling_status_system_id_systems_id_fk') THEN
    ALTER TABLE polling_status ADD CONSTRAINT polling_status_system_id_systems_id_fk
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_systems_system_id_systems_id_fk') THEN
    ALTER TABLE user_systems ADD CONSTRAINT user_systems_system_id_systems_id_fk
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_default_system_id_systems_id_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_default_system_id_systems_id_fk
      FOREIGN KEY (default_system_id) REFERENCES systems(id) ON DELETE SET NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_info_system_id_systems_id_fk') THEN
    ALTER TABLE point_info ADD CONSTRAINT point_info_system_id_systems_id_fk
      FOREIGN KEY (system_id) REFERENCES systems(id); END IF;                 -- 73 rows
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_agg_1d_system_id_point_id_point_info_fk') THEN
    ALTER TABLE point_readings_agg_1d ADD CONSTRAINT point_readings_agg_1d_system_id_point_id_point_info_fk
      FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id); END IF;  -- 11.9K
END $$;

-- Large tables → NOT VALID first (brief lock), then VALIDATE (non-blocking scan)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sessions_system_id_systems_id_fk') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_system_id_systems_id_fk
      FOREIGN KEY (system_id) REFERENCES systems(id) NOT VALID; END IF;       -- 870K
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_system_id_point_id_point_info_fk') THEN
    ALTER TABLE point_readings ADD CONSTRAINT point_readings_system_id_point_id_point_info_fk
      FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id) NOT VALID; END IF;  -- 13.4M
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='point_readings_agg_5m_system_id_point_id_point_info_fk') THEN
    ALTER TABLE point_readings_agg_5m ADD CONSTRAINT point_readings_agg_5m_system_id_point_id_point_info_fk
      FOREIGN KEY (system_id, point_id) REFERENCES point_info(system_id, id) NOT VALID; END IF;  -- 3.3M
END $$;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_system_id_systems_id_fk;
ALTER TABLE point_readings VALIDATE CONSTRAINT point_readings_system_id_point_id_point_info_fk;
ALTER TABLE point_readings_agg_5m VALIDATE CONSTRAINT point_readings_agg_5m_system_id_point_id_point_info_fk;
```

**Rollback:** `ALTER TABLE <child> DROP CONSTRAINT IF EXISTS <name>;` — mutates no rows, no data risk
(adding a constraint never fires a cascade). Removal = a new forward migration.

## Top risks & how they're handled

- **R3 + R7 — combined message at close + session FK** _[done — PR-7]_: a poll buffers its readings and
  emits one combined QStash message at session close; the receiver inserts session-then-readings in one
  transaction; FK `NOT VALID` (orphan-tolerant for legacy rows). Readings chunked under QStash's ~1 MB
  limit; a crash mid-poll leaves readings in Turso but not the queue (rare, acceptable).
- **R4 — config FK CASCADE** (decommission-time): Turso readings tables FK→`point_info`/`systems` ON
  DELETE CASCADE. ⚠️ Live drift — prod FKs reference `*_2025_11_27_backup`, **not** the live tables, so
  the config cutover can't fire the cascade; the only guardrail is **do not drop the `*_backup` config
  tables until the readings tables are rebuilt** (or Turso is decommissioned wholesale). Drop those FKs
  0016-grade (snapshot, BEGIN TRANSACTION, row-count validation before DROP, recreate indexes, test on a
  copy) when scheduled.
- **R5 — no PG migration runner** _[done]_: prod was built by destructive `drizzle-kit push`; now
  baselined into `drizzle.__drizzle_migrations`; **`push` forbidden** (see `drizzle-planetscale.config.ts`).
- **R6 — pool bug** _[done — Stage 1]_: PG pool memoized unconditionally on `global`; budget `max` ×
  warm-instances ≤ PlanetScale connection limit (`PLANETSCALE_POOL_MAX`).
- **R8 — region latency (transitional):** the cross-region hop moves with the Vercel→`syd1` step. _Before
  it_ (PG Sydney, Vercel + Turso Tokyo): receiver→PG writes + PG reads cross Tokyo↔Sydney (~100ms), Turso
  inline write local. _After it_ (PG + Vercel Sydney, Turso Tokyo): PG writes/reads local, **the Turso
  inline write becomes the cross-region hop** (~100ms, awaited) — acceptable for a minutely small write,
  and fully resolved at Phase 5 (Turso gone).

## Cross-cutting prerequisites _(all done unless noted)_

- **Feature-flag seam** `lib/db/routing.ts`: `CONFIG_READS_FROM_PG`, `CONFIG_WRITES_TO_PG`,
  `CONFIG_SERVE_FROM_PG`, `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`. Cutover = flip env var.
- **PG migrations** via `drizzle-kit generate`/`migrate` (`db:pg:generate`/`db:pg:migrate`); baseline
  0000–0003 seeded; **never `push`**.
- **PITR backups:** backup **schedules are database-wide** — they "run for all production branches", so a
  new production branch (e.g. `sydney`) inherits them at create. Set in the PlanetScale dashboard (no
  CLI/API for the schedule). `liveone` has 12h-keep-2d (immutable) + 3-day-keep-6mo; `pscale backup create`
  makes one-off base backups.
- **Dev guardrails (C):** distinct `PLANETSCALE_DATABASE_URL` per env; startup `assertNotProdDbInDev`
  throws if dev resolves to `PLANETSCALE_PRODUCTION_HOST`; `ALLOW_PROD_DB_IN_DEV=true` is the escape hatch.
- **share_tokens PG schema:** bigint epoch-ms columns + text PK; write-port detects PG `23505`.
- **Seed hardening:** config upserts (`onConflictDoUpdate`); seed `polling_status` + `share_tokens`;
  count-shortfall is a hard abort.
- **Queue quiesce before any trim:** stop publishing a type, drain to lag 0 while the OLD receiver still
  handles all types, then deploy the trimmed receiver; keep removed branches as no-ops one release.
- **Value-level reconciler** `scripts/reconcile-agg-values.ts`: diffs avg/min/max/last/delta per
  system/point/interval within tolerance — gates the aggregation trim.

## Direction of travel — engine/web separation

> **Canonical doc:** [`architecture/engine-web-separation.md`](architecture/engine-web-separation.md)
> owns the target shape **and** the ingest-durability decision (one idempotent ingest contract per
> store, on-ramped by a **transactional outbox**; the queue is transport, not the durability/replay
> mechanism). Summary only here.

The PG migration is the enabler for splitting the data-collection **engine** (write/collect: crons →
vendor adapters → collector → store + KV + QStash, **plus the QStash receiver**) from the **web/FE**
(×N read/serve: pages + read-only API + Clerk auth + low-frequency config writes), so the FE can iterate
without ever risking data collection. **The only cross-boundary contracts:** (1) shared **Postgres**;
(2) **KV** latest-values (engine writes, web reads — engine is sole KV writer); (3) the **QStash**
receiver; (4) an engine **Control API** + job queue for web→engine commands ("web brokers, engine
executes" — sync for interactive vendor-adapter calls, async durable jobs for poll-now/recompute/resync).
Turso is **not** a contract — it's a disposable engine-internal backup. **Credentials stay in Clerk.**
Behaviour-preserving decouplings to do first (code, not deploy): split `lib/api-auth.ts` (Clerk-auth web
vs signature-auth engine); extract `pollAllSystems()` / daily aggregation / the receiver into
host-agnostic `async` functions; stop assuming cross-service cache coherence. **Sequence the deploy
split AFTER the store is on PG.**

## Dev Postgres wiring (shared PlanetScale dev branch)

Dev uses a **shared PlanetScale dev branch** (not a separate engine), with Postgres PITR as the backstop.

- **Env (`.env.local`):** `PLANETSCALE_DATABASE_URL` → dev branch (runtime); `PLANETSCALE_DATABASE_URL_MIGRATIONS`
  (or `DB_*`) → DDL creds for `db:pg:migrate`; `PLANETSCALE_PRODUCTION_HOST` → prod host (arms the
  guardrail); `PLANETSCALE_POOL_MAX` (optional, default 10).
- **`receive-dev`** (`app/api/observations/receive-dev/route.ts`) only logs (no PG writes), so the dev
  queue pipeline doesn't populate dev Postgres today. To exercise the PG ingest path in dev, point the
  publisher's receiver URL at a dev receiver that writes the dev branch, or extend `receive-dev` to write.

## Turso read/write-site inventory

Generated from importers of `@/lib/db/turso*`. A **scoping checklist** — exact tables per file are
confirmed during the relevant PR.

- **Config → Phase 1 _(done)_:** `lib/systems-manager.ts`, `lib/polling-utils.ts`, `lib/share-tokens.ts`,
  `lib/user-preferences.ts` (incl. `userHasSystemAccess`), `app/api/setup`, the admin
  systems/users/user-points routes, `app/api/systems`, `app/api/auth/{enphase,tesla}/{callback,disconnect}`.
- **Readings → Phase 2:** `app/api/history/route.ts` (**the** live read path; shadowed/served via
  `lib/history/build-series.ts` + `readings-pg.ts`); the two admin point-readings routes (via
  `lib/db/planetscale/readings-read-pg.ts`); `app/api/system/[systemId]/generator-events/route.ts`
  (**DEFERRED** — unbounded full-history hack); `lib/db/turso/aggregate-daily-points.ts` (1d),
  `lib/point-aggregation-helper.ts` (5m); `app/labs/kinkora-hws/page.tsx` (low priority).
- **Mixed:** `lib/point/point-manager.ts` (point_info CRUD = config **and** raw insert + 5m + KV =
  readings; split by concern); `lib/session-manager.ts` (**done — PR-7**);
  `app/api/system/[systemId]/point/[pointId]/route.ts`.
- **Vendor adapters:** `lib/vendors/enphase/*` (5m-native; read config from PG post-cutover);
  `lib/observations/publisher.ts` (point_info type only).
- **Ops / cron / sync:** `app/api/cron/daily/route.ts` (1d trigger); `db-stats`, `admin/storage`,
  `health` (port opportunistically); `app/api/admin/sync-database/*` (dev-seed — re-point to PG or
  retire); `app/api/enphase-proxy/route.ts`.
- **Tests:** `app/api/system/__tests__/point.integration.test.ts` — needs a PG-backed harness.

## Tools

> ⚠️ **Run every Turso/PG comparison or recompute script with `TZ=UTC`.** PG `point_readings`/`agg_*`
> use `timestamp without time zone` (UTC); node-postgres serializes JS `Date` params in the client's
> local tz, so on a non-UTC machine date-bounded queries silently shift ~tz-offset hours and mis-report.
> `gap-map-raw-readings.ts` and `recompute-pg-range.ts` also force `TZ=UTC` in-process as a backstop.

- `scripts/backfill-turso-to-postgres.ts` — historical backfill + `--verify`.
- `scripts/gap-map-raw-readings.ts` — READ-ONLY per-(system, UTC-day) raw-count diff Turso vs PG;
  `--apply` copies the missing raw rows (onConflictDoNothing).
- `scripts/recompute-pg-range.ts` — recompute raw-vendor 5m from PG raw + re-copy 5m-native 5m from Turso
  - recompute 1d, over `--from/--to` (optional `--system`); dry-run default, `--apply` to write. Idempotent.
- `scripts/seed-planetscale-refs.ts` — re-seed `systems` + `point_info` if metadata changes.
- `scripts/reconcile-agg-values.ts` — read Turso, compare aggregate values against PG (the gate).
- `scripts/audit-pg-fk-orphans.ts` — READ-ONLY FK pre-flight (existing constraints + row + orphan counts).
- `scripts/parity-config-turso-vs-pg.ts` — READ-ONLY config row-by-row parity (✅/⚠️ verdict).
- `scripts/purge-observations-queue.ts` — purge + recreate the QStash queue (paused).
- `scripts/qstash-health.ts` — READ-ONLY live mirror-health snapshot (queue lag/DLQ/paused/parallelism +
  PG response-presence + raw-landing age); CLI sibling of the `monitor-observations` cron.
- `app/api/cron/monitor-observations` — mirror-health monitor + alert (every 15 min, `vercel.json`);
  `/admin/observations` — live pipeline depth, ingestion rate, queue/DLQ controls.
- `lib/observations/outbox.ts` (`persistOutbox`/`drainOutbox`) + `app/api/cron/relay-outbox` — Phase-4a
  outbox + minutely relay (drains `observations_outbox` → QStash → receiver), gated `WRITE_OUTBOX`. Outbox
  backlog/oldest-unpublished age is reported by `monitor-observations` (alerts `outbox_backlog_high`/
  `outbox_stale`), `qstash-health.ts`, and `/admin/observations` stats.

## Verification & rollback

- **Per PR:** `npm run build:local && npm run type-check`; targeted `npm test`; shadow-diff logs
  Turso-vs-PG divergence with the flag on while reads still serve from Turso.
- **After the daily cron:** reconcile `--table=agg_1d` clean; dashboard lag ~0.
- **Additive / flag-gated PRs** (PR-8/9/11/12, PR-7): revert the PR or flip the env flag (instant);
  `DROP CONSTRAINT` removes the session FK.
- **CUTOVER PRs** (config, PR-13a, PR-13): flip the relevant flag back (instant). Config has no Turso
  dual-write soak (decision B) → config rollback relies on **PG PITR** + the pre-cutover Turso snapshot.
- Always take a fresh Turso snapshot + confirm PG PITR before each CUTOVER PR.

## History log

One line per completed milestone — detail lives in git + the sections above.

- **2026-06-10 — Vercel→`syd1` LIVE + Phase 4a outbox DEPLOYED + SOAKING.** Moved Vercel compute Tokyo→Sydney (PR #31,
  `vercel.json` `regions`; confirmed by function region `syd1` on a live request) — engine co-located with
  PG. Built the Phase-4a transactional outbox (gated `WRITE_OUTBOX`): `observations_outbox` (migration
  `0004`), `persistOutbox` tee at the publish seam (`poll-collector.ts`/`publisher.ts`) alongside the
  unchanged direct enqueue, minutely `app/api/cron/relay-outbox` draining → QStash → the unchanged
  receiver (`FOR UPDATE SKIP LOCKED`, per-row tx, GC), + outbox backlog/age monitoring. Additive +
  reversible (`WRITE_OUTBOX=false`). Merged as PR #32, deployed; migration `0004` applied to prod Sydney
  PG; `WRITE_OUTBOX=true` flipped on; relay draining (backlog ~0); Slack alert webhook
  (`OBSERVATIONS_ALERT_WEBHOOK_URL`) wired + tested. ~30h soak in progress.
- **2026-06-10 — Phase 3 Sydney cutover LIVE.** PlanetScale prod moved us-east→Sydney (3-node HA `sydney`
  branch, PS-5 ARM, PG 17.10). Paused queue → `pg_dump -Fc`/`pg_restore` (local PG-17 client, ~3.7 GB,
  direct port 5432) → repointed prod `DB_*` to the Sydney pooler + `vercel redeploy` → resumed → drained
  the 495-msg backlog → recomputed the boundary day. Verified vs Sydney: row-parity 12/12 tables, 38/38
  indexes, FK `NOT VALID` preserved, seq past max; `gap-map` 0 deficits, `agg_5m` 20016/20016, `agg_1d`
  clean. PITR auto-covered (DB-wide schedules) + manual base backup. us-east `main` kept hot for rollback;
  Vercel→`syd1` deferred. Also made the PG 5m recompute order-independent (successor recompute + per-system
  advisory lock) so queue parallelism >1 is safe.

- **2026-06-09 — PR-13 LIVE + burn-in GREEN.** Trimmed raw-vendor 5m/1d Turso→queue double-write (`#26`,
  gated `AGG_COMPUTE_IN_PG`); PG is sole raw-vendor aggregator. Post-resume verification: queue lag 0 /
  DLQ 0 / presence 100% / raw landing < 2 min; reconciler `agg_5m --days=2` 20010/20010 and `agg_1d`
  (June) 261/261, 0 value-mismatches. Also dropped the now-unreachable `publishSession` session-only
  branch (all `updateSessionResult` callers emit the combined `publishPoll` message); remaining
  dead-publisher cleanup deferred to Phase 5 (it's the `AGG_COMPUTE_IN_PG=false` rollback path).
- **2026-06-09 — PR-13a LIVE.** Readings served FROM PG (`#24`); `READINGS_READS_FROM_PG` flipped true in
  prod (Turso = fallback). Post-cutover verification sweep GREEN: `qstash-health` lag 0 / DLQ 0 /
  presence 100% / raw landing < 1 min; reconciler `agg_5m --days=2` and `agg_1d` (all 2026) 0 mismatches;
  raw `gap-map-raw-readings.ts` 0 deficits.
- **2026-06-08 — PR-12 burn-in GREEN.** Readings-reads shadow (`#19`) ran clean over a settled window
  incl. the fresh post-midnight 1d (reconciler `agg_1d` 150/150, `agg_5m` 19966/19966). Composite-system
  1d day-shift (serve-path: PG 1d fetch was unordered; data was fine) fixed in `#23` (ORDER BY +
  defensive series sort). Admin readings perf + 1d `data_quality` 500 — two **pre-existing** bugs fixed
  (`COUNT(*)` → `SELECT 1 … LIMIT 1`; 1d selects `NULL as data_quality`); PG served the same admin reads
  < 1s vs Turso 10–13s.
- **2026-06-07 — reconciler driven GREEN, all systems.** RED causes fixed: historical PG 5m never
  recomputed (queue-mirror gaps pre-`AGG_COMPUTE_IN_PG`) + Amber (sys 9) 5m staleness (late `updateUsage`
  dropped by the receiver's `onConflictDoNothing`). Fixed via `recompute-pg-range.ts --apply` + re-copying
  Amber's refined 5m; 16 pre-`#15`-deploy Amber stragglers cleaned up (snapshot
  `liveone-snapshot-20260607-215859`).
- **2026-06-07 — `#15` shipped.** Receiver upserts 5m for 5m-native systems (Amber refinements heal
  automatically — proven: 85 post-deploy refinements healed within seconds); `monitor-observations` cron
  (15 min) + `gap-map-raw-readings.ts` / `recompute-pg-range.ts` tooling landed.
- **2026-06-07 — Phase 1 config authority LIVE.** `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` flipped;
  pre-flight snapshot `liveone-snapshot-20260607-000847` + full parity + write-routing audit. Side fixes:
  Clerk middleware allow-lists `/api/observations(.*)`; the un-awaited `protect()` no-op (PR `#12`).
- **2026-06-06 — PR-11 (PG aggregation) enabled** + ms-precision fix (the QStash path was truncating
  `measurement_time` to whole seconds → Mondo dup rows; `formatTime_fromJSDate` gained `includeMillis`,
  publisher passes `true`; 2,664 sys-6 truncation dups deduped, precision restored).
- **2026-06-06 — PR-7 LIVE.** Session id → UUIDv7/text; combined QStash message per poll; transactional
  receiver; `point_readings.session_id → sessions.id` FK `NOT VALID`; dropped the `sessions` unique.
  Admin session reads served from PG.
- **2026-06-06 — data recoveries, nothing lost.** 36 deploy-window + 19 backfill-gap sessions; **118,613
  purged Sep–Nov 2025 sessions** recovered full-fidelity from snapshot `liveone-snapshot-20251126-195709`;
  **147,727 response blobs** restored from `sessions_archive`. ~4,165 orphans remain (the 2025-11-27 final
  purge-window block, in no snapshot) — tolerated under the `NOT VALID` FK.
- **Stage 1 (PR-0…PR-6) + prod PG hardening merged.** Flag seam, pool-memo fix, migration tooling +
  baseline, `share_tokens` table, seed hardening, value reconciler, dev guardrail, read-site inventory.
