# Turso → Postgres migration — status, plan & reference

The **single source of truth** for LiveOne's Turso→Postgres migration: current status, locked
decisions, the phased forward plan, risks, and the durable dev/ops reference. (Consolidates the
former `postgres-primary-migration-plan.md` and the two `observations-pg-*` docs.)

## Goal

LiveOne records energy data into **Turso** (libsql/SQLite, Tokyo) as the system of record, with a
**Postgres** mirror (PlanetScale-hosted Postgres, not MySQL) fed asynchronously via an Upstash
**QStash** queue (publisher → receiver route). Goal: **make Postgres the primary** (serve reads from
it; move the config tables to it), demote **Turso to a transitional best-effort backup**, then
**decommission Turso**. End-state is Postgres-only, with Vercel + PlanetScale in **Sydney
(ap-southeast-2 / `syd1`)**. This is a **staged, flag-gated, multi-PR program**, adversarially
reviewed against the actual code. The deeper reason for all of this is to cleanly separate the
data-collection **engine** from the **web/FE** — see [Direction of travel — engine/web
separation](#direction-of-travel--engineweb-separation).

## ✅ What was not working — now fixed (reconciler GREEN, all systems, 2026-06-07)

Phase 1 (config) is **done and healthy**. The **readings + aggregation** reconciler was **RED**, which
gated all of Phase 2. As of **2026-06-07 it is GREEN over a settled window for all systems**: `agg_5m
--days=2` reconciles **19978/19978, 0 mismatch** and `agg_1d --days=2` is clean; raw `point_readings` is
complete (PG ⊇ Turso, `gap-map-raw-readings.ts`, `TZ=UTC`).
A 2026-06-07 re-verification initially found 16 system-9 (Amber) `agg_5m` mismatches — diagnosed as
pre-#15-deploy stale rows and **cleaned up the same day**; the _all-systems_ `agg_5m --days=2` and
`agg_1d --days=2` now both reconcile **0 mismatches** (see [Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift)).
What the investigation actually found and did:

1. **PG raw `point_readings` is NOT incomplete — that earlier reading was a measurement artifact.**
   node-postgres serializes JS `Date` params in the **client's local timezone**; on a non-UTC box (this
   workstation is AEST+10) a `WHERE measurement_time >= $date` against the UTC `timestamp without time
zone` columns shifts the boundary ~10h, so an ad-hoc per-day count looked ~43–48% short on the first
   day of any window. Re-run with **`TZ=UTC`**, `scripts/gap-map-raw-readings.ts` shows **PG raw ⊇ Turso
   for all of 2026 (zero deficits)**. Lesson: **always run these scripts with `TZ=UTC`** (the new scripts
   also force it in-process).

2. **The real blocker was historical PG _5m_ never recomputed.** Before `AGG_COMPUTE_IN_PG` was enabled
   (2026-06-07), raw-vendor 5m reached PG only via the queue mirror, which had gaps (the ON/OFF windows).
   PG raw was complete, but PG `agg_5m` had missing intervals for those days, so `agg_1d` `sampleCount`
   was short — concentrated entirely on **2026-06-06** (systems 1 & 6). **Fix applied:**
   `scripts/recompute-pg-range.ts --apply` recomputed raw-vendor 5m from PG's own (complete) raw, then
   the 1d, keyed by business key (idempotent).

3. **5m-native (Amber, system 9) 5m staleness — fixed + made durable.** Amber sends late multi-day
   `updateUsage`; Turso upsert-overwrites and **re-publishes** the refined 5m, but the PG receiver used
   `onConflictDoNothing`, dropping the refinement (264 stale `agg_5m` rows). **Fix applied:**
   `recompute-pg-range.ts` re-copied Turso's refined `agg_5m` into PG (5m-native can't be recomputed —
   no raw). **Durable fix (code):** the receiver now **upserts 5m for 5m-native systems**
   (`app/api/observations/receive/route.ts`, classified via `lib/vendors/native-intervals.ts`), so future
   re-published refinements heal automatically. Verified `AGG_COMPUTE_IN_PG`'s recompute is disjoint from
   5m-native points (it reads `point_readings`, which 5m-native vendors don't have).

4. **Mirror-pipeline reliability — monitor added (prevention).** A new cron
   `app/api/cron/monitor-observations` watches response-presence, raw-landing vs sessions, and QStash
   lag/DLQ, alerting via `OBSERVATIONS_ALERT_WEBHOOK_URL` (graceful no-op if unset). The synchronous-PG-
   raw-write end-state stays **Phase 4**; the monitor catches a "mirror down" window in minutes meanwhile.

_Residual (not a blocker, root-caused 2026-06-07):_ a verification re-run found 16 `agg_5m` mismatches,
all system 9 (Amber), in the day's recent intervals (06-07 07:30–10:00 UTC); `agg_1d` is unaffected.
**Diagnosed:** these are refinements the **old `onConflictDoNothing` receiver dropped in the ~2h before
#15 deployed** (~10:11 UTC) — **not** a recompute bug (system 9 has no raw at all). The #15 upsert is
proven (85 post-deploy refinements healed within seconds). Heal the 16 stragglers with a one-shot
`recompute-pg-range.ts --system 9 --from 2026-06-06 --to 2026-06-08 --apply`; full analysis in
[Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift).

_Minor / known (not blockers):_ auth-middleware `protect()` was a no-op → fixed in **PR #12 (merged
2026-06-07)**; session FK still `NOT VALID` (deferred decision, ~60K tolerated orphans); the
`db:sync-prod` dev-seed path is broken (`sync-prod-to-dev.js` missing).

## ▶️ What's next (and why)

Ordered by dependency. Phase 1 (config) is done; **the gate to all of Phase 2 was a green reconciler —
now met (2026-06-07).** The aggregation reconcile + recompute work above is done; remaining:

1. ✅ **DONE — shipped via #15** (the item-3 receiver upsert + item-4 monitor + the new tooling, merged
   2026-06-07). **Why it mattered:** the green only _held_ once the receiver upserts 5m-native
   (else the next Amber refinement re-stales PG); the monitor stops new mirror-down windows; the tooling
   landed for future use. **Verification window:** monitor-cron signal in ≤15 min (it runs every 15 min);
   full settled-window reconciler confidence ~48h — needs one daily 1d cron (14:05 UTC) **and** one Amber
   (sys 9) late-refinement to ride through before the durability fix is proven. **UPDATE (2026-06-07
   re-run): durability fix PROVEN** — 85 post-deploy Amber refinements healed PG within seconds. The only
   residue is 16 stale rows refined in the ~2h _before_ #15 deployed (old receiver dropped them); fix is a
   one-shot recompute. See [Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift).
2. ✅ **DONE — PR #12 (auth enforcement) merged 2026-06-07.** Closed a real auth gap + the 404 noise;
   isolated from the readings work. **Still to verify on live traffic:** Fronius push, OAuth round-trip,
   share link (smoke only — code is in).
3. ✅ **DONE — Amber (system 9) 5m stale-row cleanup (2026-06-07).** Root-caused as pre-#15-deploy
   refinements the old receiver dropped (**not** a recompute bug — system 9 has no raw); healed with a
   one-shot `recompute-pg-range.ts --system 9`. Reconciler now **fully green, all systems** (`agg_5m
--days=2` 19978/19978, `agg_1d` clean). See
   [Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift).
4. **Phase 2 cutover — raw-vendor reconciler is green over a settled window (incl. the daily 1d):**
   - **PR-12 — readings reads → PG** behind `READINGS_READS_FROM_PG`, shadow-diff first,
     endpoint-by-endpoint. **Why:** serve reads from PG so the Turso read paths can retire.
   - **PR-13 — trim the raw-vendor Turso 5m/1d publishers** (after quiescing the queue to lag 0).
     **Why:** stop the double-write; PG becomes the sole aggregator. Re-confirm the reconciler green
     immediately before trimming.
5. **Phase 3 — Sydney region move** (parallel ops). **Why:** co-locate compute + data and kill the
   cross-region RTT (R8); sequence with the readings cutover.
6. **Phase 4 — Turso decommission.** **Why:** the end-state is PG-only. Needs raw durability off Turso
   (synchronous PG raw write — bring forward the item-4 end-state) + dropping the `*_backup`/archive tables.
7. **Decommission-time hardening (gated, not blockers):** PG FK rebuild (audited; plan ready below),
   R4 Turso-FK drop, session-FK validation. **Why:** relational integrity + cleanup, after readings cut over.

Per-phase detail is in **Phased plan (detail)** below.

## Open follow-up — Amber (system 9) 5m live-tail drift

**RESOLVED (diagnosed 2026-06-07) — only a one-shot data cleanup remains; left here as the record.**
Surfaced by a **2026-06-07 verification re-run** (after #15 + PR #12 merged) and **fully root-caused** the
same day: it's **pre-#15-deploy stale rows, not a bug in current code, not a Phase-2 blocker** — and the
investigation doubled as positive proof the #15 durability fix works.

**What was measured (read-only, prod, `TZ=UTC`):**

| Check                     | Command                                                      | Result                                                      |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Unit tests                | `npm test`                                                   | ✅ 365 passed / 24 suites                                   |
| Raw completeness          | `gap-map-raw-readings.ts --from 2026-06-05 --to 2026-06-08`  | ✅ no PG raw deficits                                       |
| `agg_1d` settled          | `reconcile-agg-values.ts --table=agg_1d --days=2`            | ✅ 0 mismatches (only-in-PG=39, presence-only)              |
| Raw-vendor `agg_5m` sys 1 | `reconcile-agg-values.ts --table=agg_5m --system=1 --days=2` | ✅ 0 / 9216                                                 |
| Raw-vendor `agg_5m` sys 6 | `reconcile-agg-values.ts --table=agg_5m --system=6 --days=2` | ✅ 0 / 10368                                                |
| **All-systems `agg_5m`**  | `reconcile-agg-values.ts --table=agg_5m --days=2`            | ⚠️ **16 mismatches, all system 9** → ✅ **0 after cleanup** |

**Root cause (proven).** System 9 (Amber) has **no raw `point_readings` in PG _or_ Turso** — so
`AGG_COMPUTE_IN_PG` is _not_ averaging raw (Hypothesis 1 **refuted**; the recompute is correctly disjoint
from 5m-native). Instead: Amber writes **forecast `agg_5m` intervals ahead of time and refines them toward
actuals** as the interval approaches (rows for `interval_end` 06-07 were _created_ 06-06 02:34). The 16
stale rows are refinements the **old `onConflictDoNothing` 5m-native receiver dropped** in the window just
before #15 deployed:

- All 16 mismatched intervals were last refined in **Turso between 07:58 and 10:04 UTC**, but their PG
  `updated_at` is **frozen at 07:46:06** — PG never got those refinements.
- **#15 merged ~10:11 UTC**; the latest dropped refinement was **10:04** (minutes before).
- **85 intervals refined _after_ the deploy all match**, with PG `updated_at` landing **2–4 s after** Turso's
  (the queue→receiver→upsert latency) — i.e. post-deploy refinements heal automatically, within seconds.

The "computed-looking" long decimals (e.g. PG `9.20755389609171`) were just Amber's _earlier forecast_
estimates frozen in PG; Turso's clean `7.606` is the later actual. Nothing computes them on the PG side.

**Status of the durability fix:** **proven.** The plan's gate ("one Amber late-refinement must ride
through") is met many times over — 85 post-deploy refinements propagated cleanly. The 16 stragglers won't
self-heal (Amber won't re-publish already-settled intervals).

**Cleanup — ✅ EXECUTED 2026-06-07.** Re-copied Turso's refined `agg_5m` for the pre-deploy window into PG
(snapshot `liveone-snapshot-20260607-215859` first), then re-reconciled — **now fully green, all systems
included**:

```bash
# snapshot taken: liveone-snapshot-20260607-215859
TZ=UTC NODE_ENV=production ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/recompute-pg-range.ts --system 9 --from 2026-06-06 --to 2026-06-08 --apply
#   → copied 346 5m row(s), recomputed 3 day(s) of 1d
TZ=UTC NODE_ENV=production npx tsx scripts/reconcile-agg-values.ts --table=agg_5m --days=2   # ✅ 19978/19978, 0 mismatch
TZ=UTC NODE_ENV=production npx tsx scripts/reconcile-agg-values.ts --table=agg_1d --days=2   # ✅ 0 mismatch
```

A wider Amber-history sweep can use the same tool over a longer window if older days ever need it.
_Investigation scripts (read-only, `scripts/temp/`, gitignored): `investigate-sys9-5m.ts`,
`investigate-sys9-boundary.ts`._

## Full-history parity + live pipeline health (verified 2026-06-08)

A whole-history read-only sweep (all `TZ=UTC`, prod) — PG is complete and reconciles against Turso back
to inception (first data **2025-08**):

| Check                                                     | Window                                  | Result                                                                   |
| --------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Raw `point_readings` deficits (`gap-map-raw-readings.ts`) | 2025-01-01 → 2026-06-08                 | ✅ **0 — PG ⊇ Turso on every (system, day)**                             |
| `agg_5m` value parity, **all systems** (chunked)          | inception → 2026-06-08, **~3.31M rows** | ✅ **0 mismatches** (per-window all 0)                                   |
| `agg_1d` value parity                                     | all 2025 (5900) + all 2026 (6106)       | ✅ **0 mismatches**                                                      |
| Live QStash queue                                         | now                                     | ✅ **lag 0, DLQ 0, parallelism 1, not paused**                           |
| Live PG mirror (last hour)                                | now                                     | ✅ **response-presence 100% (102/102), 1500 raw rows, newest 0 min old** |

"Complete" here means **complete relative to Turso** (the gap-map flags only days where PG < Turso —
none exist; a reading that never reached Turso either is a collection gap, invisible to a two-store diff).
The `agg_5m` sweep was chunked by month/quarter because a single multi-month Turso response exceeds the
libsql client's max decode-string size (`ERR_STRING_TOO_LONG`) — a tooling limit, not a data issue.

**Durability model (today vs end-state) — answers "do we ever drop a reading before it's in PG?":**
Not via QStash alone, and that's intentional for now. A poll writes **Turso inline (synchronous, the real
durability anchor)** and then **best-effort enqueues to QStash** — `publishObservationBatch` swallows
enqueue errors ("do NOT break the database insertion"), and there is **no synchronous PG write** (PG is fed
only by the receiver). Once enqueued, QStash is at-least-once with retries → **DLQ**, parallelism-1
(ordered); the receiver is idempotent. So the actual guarantee is **"Turso has it, and PG holes heal from
Turso"** via idempotent `gap-map-raw-readings.ts --apply` — exactly how 2026's ~9 mirror-down windows were
repaired. The gaps QStash itself doesn't close (swallowed enqueue, crash mid-poll before publish, stranded
DLQ) are caught by the every-15-min `monitor-observations` cron + the Turso backstop. **"Never drop until
ingested into PG" is the Phase-4 goal** (a synchronous PG raw write, or formally accepting queue-only
at-least-once with monitoring) — not yet built, and the reason Turso can't be decommissioned yet
(decision F). _Snapshot tooling: `scripts/qstash-health.ts` (read-only live lag/DLQ/presence)._

## Status (2026-06-07)

- **Stage 1 (additive groundwork) — merged.** Flag seam (`lib/db/routing.ts`, all flags default
  off), PG pool memoization fix, PG migration tooling, `share_tokens` PG table, seed hardening,
  value reconciler, dev guardrail + read-site inventory. Live QStash→PG pipeline + historical
  backfill done (verified, zero dropped); 1d aggregates flow via the queue.
- **PR-7 — LIVE in prod.** Session id → UUIDv7/text; one combined QStash message co-enqueued per
  poll at session close; transactional session-before-readings receiver;
  `point_readings.session_id → sessions.id` FK added `NOT VALID`; dropped the `sessions` unique.
  **Admin session reads now served from PG.**
- **✅ Phase 1 — Config authority on Postgres: LIVE in prod (cut over 2026-06-07).**
  `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` flipped together — **Postgres is now the system of
  record for config** (`systems`, `point_info`, `users`, `user_systems`, `polling_status`,
  `share_tokens`). Turso config is now a stale, no-longer-written mirror. Verified: full Turso↔PG
  parity pre-flip (`scripts/parity-config-turso-vs-pg.ts`), `[CONFIG-SERVE]` errors ≈ 0 post-flip,
  writes confirmed on PG (PG `polling_status` runs ahead of Turso), shadow compare stopped. Revert =
  flip both flags off; rollback point = snapshot `liveone-snapshot-20260607-000847` + PG PITR.
- **Readings reads still come from Turso** (`READINGS_READS_FROM_PG` off) — that's Phase 2. Turso
  remains the source of truth for raw readings + their aggregates' _serving_.
- **PR-11 (Move 1) — ENABLED in prod (`AGG_COMPUTE_IN_PG=true`).** PG computes its own raw-vendor
  5m + 1d aggregates from PG's own data. Reads still served from Turso (shadow-for-reads); the
  Turso-publisher trim (PR-13) is gated on `scripts/reconcile-agg-values.ts` value-parity over a settled
  window — **GREEN, all systems (2026-06-07): `agg_5m --days=2` 19978/19978, `agg_1d` clean** after
  recomputing historical PG 5m + 1d (`scripts/recompute-pg-range.ts`) and re-copying Amber's late-refined
  5m. PG raw was verified complete (the earlier "raw gaps" were a client-TZ measurement artifact). Durable
  item-2 fix (receiver upserts 5m-native) + the mirror monitor **shipped via #15 (merged 2026-06-07)** —
  and is now **proven** (85 post-deploy Amber refinements healed PG within seconds; the 16 pre-deploy
  stragglers were cleaned up — see [Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift)).
- **Prod PG hardening (done):** `share_tokens` created on prod; `drizzle.__drizzle_migrations`
  baselined (0000–0003); `db:pg:migrate` SSL bug fixed → migration tooling works end-to-end.
- **Data recoveries (done):** all session data preserved — see [Completed](#completed).

## Config cutover runbook — ✅ EXECUTED 2026-06-07

_Executed in prod 2026-06-07: `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` flipped together; config
is now served + written from PG (see Status). Steps retained as the record + rollback reference._

This PR (`simonhac/pr8-config-reads`) bundles the whole config seam — **1A** read-shadow
(`CONFIG_READS_FROM_PG`), **1B** PG-only writes (`CONFIG_WRITES_TO_PG`), **1C** serve-from-PG
(`CONFIG_SERVE_FROM_PG`). All three default **off**, so merge + deploy is **dark** (identical to
today). The cutover is driven entirely by flipping prod env flags — revert = flip back, no redeploy.

Flag semantics (`lib/db/config-shadow.ts`): READS on + SERVE off = **shadow** (serve Turso, also read
PG, compare, log `[CONFIG-SHADOW] … DIVERGE`; PG errors swallowed — can't affect a request). SERVE on
= **serve from PG** (Turso fallback on error/skip, logged `[CONFIG-SERVE]`; the shadow compare is not
run). WRITES on = config writes hit **PG only** (no Turso dual-write).

1. **Merge + deploy (dark).** Confirm healthy; with all config flags off the behavior is unchanged.
2. **Shadow.** Set `CONFIG_READS_FROM_PG=true` in prod. The gate is **0 divergence on the stable
   config** — `systems`, `point_info`, `users`, `user_systems`, and the non-churn fields of
   `share_tokens`/`polling_status` (especially `userHasSystemAccess` — access control). **Expected and
   ignorable:** `[CONFIG-SHADOW] loadSystems DIVERGE` on `polling_status` per-poll fields and
   `share_tokens.lastUsedAtMs` — those are written to Turso every poll/use, so PG lags until the write
   flip (step 4) heals it. Verify with `NODE_ENV=production npx tsx scripts/parity-config-turso-vs-pg.ts`,
   which compares every config row with the shadow seam's own normalizers and classifies churn vs. real
   divergence into a ✅/⚠️ verdict (traffic-independent); or watch logs for `[CONFIG-SHADOW] … DIVERGE` /
   `pg-read failed` on any label other than `loadSystems`. If the stable config drifted, re-seed:
   `NODE_ENV=production npx tsx scripts/seed-planetscale-refs.ts --apply --with-users`.
3. **Pre-cutover safety.** Fresh Turso snapshot + confirm PG PITR; re-seed + hard-validate PG ≥ Turso
   config counts (the seed aborts on shortfall). Optionally pause cron for the flip.
4. **Cutover — flip together.** Set `CONFIG_SERVE_FROM_PG=true` **and** `CONFIG_WRITES_TO_PG=true` in
   one change (serving from PG while still writing Turso — or the reverse — serves stale config). PG
   is now authoritative for config. Re-enable cron.
5. **Verify.** `[CONFIG-SERVE]` fallback/error rate ≈ 0; make a real config edit (rename a system /
   add a viewer) and confirm it lands in PG; `userHasSystemAccess` still correct.
6. **Rollback.** Flip `CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` back off (instant; reverts to
   Turso, current up to cutover). ⚠️ Config writes made to PG _after_ cutover aren't in Turso — if any
   occurred, recover via PG PITR rather than a bare flip. Config edits are rare; keep the window short.

**Related (not a blocker):** decision B / R4 — dropping the Turso readings→config CASCADE FKs is
decommission-time and re-assessed as _not_ a prerequisite for the write flip (investigate the
`*_2025_11_27_backup` FK drift when scheduled). The PG FK rebuild is likewise later (see the
_PG foreign-key rebuild_ section).

## Locked decisions

- **Reads** flip to Postgres (accept queue lag). **Raw** keeps the async dual-write (Turso inline
  best-effort backup + queue → PG).
- **Sessions** go through the queue, PG-mirrored (not synchronous in PG). _[done — PR-7]_
- **(E) Session id = UUIDv7, app-generated**; **(E1) text in both DBs** (`sessions.id`,
  `point_readings.session_id`, `agg_5m.session_id`) — historical = stringified ints, new = UUIDv7
  (time-ordered as text). _[done — PR-7]_
- **Enphase/Amber** (5m-native, no raw) keep flowing their 5m through the queue.
- **(A) Aggregation ported to Postgres** for raw vendors (Selectronic/Fusher) via deferred
  idempotent recompute; 5m-native vendors' 5m stays queue-fed. Needs the value reconciler.
- **(B) Config writes → Postgres only**; **drop the FK constraints on the Turso readings tables** so
  the Turso raw backup survives with config rows living only in PG. Config rollback relies on **PG
  PITR** + a pre-cutover Turso snapshot.
- **(C) Dev = shared PlanetScale dev branch** + hard guardrails + PITR backstop.
- **(D) Move Vercel + PlanetScale to Sydney.** Turso stays in Tokyo, decommissioned soon.
- **(F) Turso = transitional backup of raw + sessions only** _(2026-06-06)_ — no special or lasting
  status. Config **and** all aggregates leave Turso entirely (PG is the sole aggregator); design as
  if **PG is the only store**, with the inline Turso write an extra best-effort backup deletable with
  zero architectural change. Retire Turso once **raw-durability-on-PG** is proven (accept the
  at-least-once QStash queue with monitoring, or add a synchronous PG raw write) — not on any feature
  it provides. Supersedes any "Turso = permanent substrate" framing.
- **(G) Engine/web separation is the end goal** _(2026-06-06)_ — two independently deployable units
  (collection engine vs web/FE); Postgres + KV + the QStash queue + an engine Control API are the
  only cross-boundary contracts. See [Direction of travel](#direction-of-travel--engineweb-separation).

## Two table classes (until Turso decommission)

- **Config (authoritative in PG):** `systems`, `point_info`, `users`, `user_systems`,
  `polling_status`, `share_tokens`. Dev-only `clerk_id_mapping`/`sync_status` out of scope.
- **Readings (queue → PG; Turso best-effort backup):** raw `point_readings` (dual-write), sessions
  (queue), 5m-native 5m (queue). Raw-vendor `agg_5m`/`agg_1d` computed in PG (idempotent recompute),
  not mirrored to Turso.
- **Out of scope — legacy, never migrated:** the old `readings` / `readings_agg_5m` /
  `readings_agg_1d` tables (superseded data model, no longer read) are **not** moved to Postgres;
  they're left behind and dropped when Turso is decommissioned. The migration concerns
  `point_readings*` only.

## Direction of travel — engine/web separation

The Postgres migration is the enabler for a deeper split: separate the data-collection **engine**
from the **web/FE** so the front-end can iterate (and **multiple FEs** can run) without ever risking
data collection. Postgres is what makes the boundary clean — the web reads only Postgres + KV; the
engine owns all writes. _(Direction of travel, not yet built. Locked decisions (F)/(G).)_

**Two runtime roles, split by data-flow:**

- **Engine** = write/collect: cron scheduler → vendor adapters → collector → writes the store + KV +
  publishes to QStash, **plus the QStash observations receiver** (writes PG). Must never be disturbed
  by an FE deploy.
- **Web (×N)** = read/serve: FE pages + read-only API + Clerk auth + low-frequency config/admin writes.

**The only things that cross the boundary (the contracts):** (1) the shared **Postgres** store;
(2) the **KV** latest-values cache (engine writes, web reads — engine is the _sole_ KV writer);
(3) the **QStash** observations queue (engine → receiver); (4) an engine **Control API** + a job
queue for web→engine commands (below). No shared process, no shared in-memory cache, no synchronous
web→engine call except the Control API. Turso is **not** a contract — it's an engine-internal,
disposable backup.

**FE→engine command pattern — "web brokers, engine executes."** The browser never talks to the
engine; the web server (which holds the Clerk session) does the user's authorization, then re-auths
to the engine with a service credential. Two lanes:

- **Sync (request/response)** — interactive config needing the engine's vendor-adapter code: _test
  connection, discover monitoring points, validate credentials, "poll now & show the result."_
- **Async (durable job)** — long / fire-and-forget: _poll-now batch, recompute, resync._ The Control
  API enqueues a job (a `jobs` row in PG, or QStash) and returns a job id; the engine worker executes
  and writes status back for the FE to poll.

Config _persistence_ writes the authoritative store (PG); the engine reads it fresh. **Credentials
stay in Clerk** (decision 2026-06-06) — the engine keeps a Clerk read path for vendor secrets
(`lib/secure-credentials.ts` `getSystemCredentials`) and the connect/disconnect OAuth flows write
Clerk; this is **not** moved to PG. Net: the engine exposes exactly two inbound contracts — the
**QStash receiver** and the **Control API**.

**Hard decouplings (code, not deploy — all behaviour-preserving; do these first):**

1. **Split `lib/api-auth.ts`** into Clerk-auth (web) vs secret/signature-auth (engine) — the QStash
   receiver already uses signature auth. _(Note: vendor creds off Clerk was considered and **dropped**
   — creds stay in Clerk per (above); `SystemsManager.getSystemByUsernameAndAlias`'s `clerkClient()`
   username→owner lookup is a web-only concern, keep it out of the engine.)_
2. **Extract `pollAllSystems()` / daily aggregation / the receiver handler** out of `NextRequest`/SSE
   route handlers into host-agnostic `async` functions (so they run under a Next route _or_ a worker).
3. **Stop assuming cross-service cache coherence** — `SystemsManager`/`PointManager` 60s caches and
   the `global`-memoised DB pools are fine per-process; the store is the source of truth.

**Deployment.** Monorepo → `packages/core` (db clients, schema, aggregation math, identifiers,
date-utils, observation types, routing flags) + `apps/engine` (crons + receiver + Control API; a
stable public domain e.g. `engine.liveone.energy`; co-located with PG) + `apps/web` (×N). Likely two
Vercel projects from one repo (keeps the cron/serverless model); engine-as-worker (Fly/Railway) is a
later option if serverless limits bite. The `OBSERVATIONS_QSTASH_RECEIVER_URL` override already
supports re-pointing the receiver to the engine domain. **Sequence the deploy split AFTER the store
is on PG** — the decouplings above land incrementally now; the split is then mechanical.

## Phased plan (detail)

The concise prioritized list is in **What's next (and why)** above; this is the per-phase detail.
PR-7 and **Phase 1 (config authority)** are done and live (2026-06-07). **Every cutover: take a fresh
Turso snapshot first, land via a PR (never direct-to-`main`), and stay revertible by flag flip.**

### Phase 1 — Config authority → Postgres ✅ DONE (cut over 2026-06-07)

**Goal (achieved):** config tables authoritative in Postgres — executed via the config cutover runbook
above (`CONFIG_SERVE_FROM_PG` + `CONFIG_WRITES_TO_PG` flipped 2026-06-07). The PR-8/9/10 detail below
is the historical record.

- **PR-8 — config reads** behind `CONFIG_READS_FROM_PG` (default off) + shadow-diff Turso vs PG at
  every read site (SystemsManager systems⋈polling_status, PointManager point_info cache,
  `userHasSystemAccess`, share-tokens validation, `app/api/setup`, admin systems/users routes).
  Couple polling_status reads with systems (flip together).
- **PR-9 — config writes** PG-only behind `CONFIG_WRITES_TO_PG`: createSystem,
  ensurePointInfo/createPoint/updatePoint, user prefs, user_systems grants, share-tokens (detect PG
  `23505`, not `SQLITE_CONSTRAINT`), polling_status (atomic `total_polls = total_polls + 1` upsert,
  **log-but-don't-throw** so `shouldPoll` doesn't re-poll → dup sessions). **Prereq:** drop the
  Turso readings→config CASCADE FKs (decision B) via a **0016-grade** rebuild (snapshot, BEGIN
  TRANSACTION, row-count validation before DROP, recreate indexes, test on a copy). ⚠️ **First
  investigate the live FK drift** — prod `point_readings`/`agg_5m` FKs reference
  `point_info_2025_11_27_backup` / `systems_backup_20251117`, not the live tables.
- **PR-10 — cutover:** fresh Turso snapshot + confirm PG PITR; pause cron; seed + hard-validate
  PG ≥ Turso counts; flip `CONFIG_READS_FROM_PG` + `CONFIG_WRITES_TO_PG`; re-enable cron.
- **Verify:** shadow-diff zero divergence (esp. `userHasSystemAccess` — access control);
  `PRAGMA foreign_key_check` clean after the Turso FK-drop. **Rollback:** flip flags back (config
  reverts to stale-but-rarely-changing Turso) + PG PITR.

### Phase 2 — Readings & aggregation on Postgres (PR-11 → PR-12 → PR-13)

**Goal:** serve all reads from PG and compute raw-vendor aggregates in PG; trim redundant Turso
publishers.

- **PR-11 — PG aggregation** behind `AGG_COMPUTE_IN_PG`. _[✅ ENABLED in prod 2026-06-07; reconciler
  GREEN after the historical recompute — see *What was not working* above]_. Idempotent recompute of
  raw-vendor 5m + 1d keyed `(systemId, intervalEnd)` /
  `(systemId, day)` over landed PG data, `onConflictDoUpdate`. Shape:
  - The per-point math is a **shared db-free module** `lib/aggregation/point-aggregates.ts`
    (`aggregate5mForPoint`, `aggregate1dForPoint`) that **both** the Turso writers
    (`updatePointAggregates5m`, `aggregateDailyPointData`) and the PG recompute call — so values are
    identical by construction (the parity the reconciler proves). `dayToUnixRangeForAggregation`
    moved here too (fixed a latent negative-fractional-tz bug en route).
  - **5m**: `lib/db/planetscale/aggregate-points-pg.ts` `recomputeAgg5mForIntervals`; the receiver
    (`app/api/observations/receive/route.ts`) recomputes the touched intervals from PG raw after the
    raw-insert tx commits (best-effort, awaited), matching Turso's recompute granularity exactly
    (only the reading's own interval). `transform='d'` `previousLast` comes from PG raw — equal to
    Turso's stored `agg.last` AND correct at the flag-flip boundary; relies on the observations
    queue's **ordered delivery (parallelism 1)** so the previous interval's raw is always present
    (same as Turso's in-order inline insert). Points absent from the PG `point_info` mirror are
    **skipped** (not mis-defaulted). 5m-native Enphase/Amber stay queue-fed (disjoint point set →
    no collision).
  - **1d**: `recomputeAgg1dForDay` from PG 5m; the daily cron (`aggregateRange`) computes 1d in PG
    **instead of** publishing the Turso 1d queue-mirror when the flag is on (else the async queue
    overwrites the PG-computed rows and the reconciler falsely passes).
  - Gate enabling/trim on `scripts/reconcile-agg-values.ts` (value parity over a settled window),
    not counts. 286→**316** unit tests (added pure-math + recompute-orchestration suites).
- **PR-12 — readings reads → PG** endpoint-by-endpoint behind `READINGS_READS_FROM_PG`: a PG
  provider mirroring `lib/history/point-readings-provider.ts` (ms↔timestamp + started↔createdAt
  translation); "latest" stays on KV. Shadow-diff first. Primary sites: `app/api/data/route.ts`,
  the admin point-readings routes, generator-events.
- **PR-13 — cutover:** quiesce the queue to lag 0 on `/admin/observations`, then trim only the
  raw-vendor Turso 5m/1d publishers + the receiver's raw-vendor 5m/1d inserts. **Keep** raw,
  sessions, and 5m-native 5m on the queue. Keep removed branches as logging no-ops one release.
- **Verify:** reconciler clean; dashboard lag ~0. **Rollback:** flip `READINGS_READS_FROM_PG` back;
  un-trim publishers.

### Phase 3 — Region move to Sydney (parallel ops; coordinate with Phase 1/2 cutovers)

Provision PlanetScale Postgres in **Sydney (ap-southeast-2)** (data via backup/branch restore), set
Vercel `regions` to **`syd1`** (`vercel.json`), re-point env vars. Turso stays in Tokyo (being
decommissioned). Sequence the data move with the read cutover so compute + data stay co-located.
Mostly cloud-ops + a one-line `vercel.json` change.

### Phase 4 — Turso decommission (Phase B)

With session-id minting already off Turso (PR-7), this reduces to **raw durability off Turso**: raw
readings must reach PG without the inline Turso write as the synchronous safety net — either a
synchronous PG raw write or accepting queue-only (at-least-once) durability (re-opens the
synchronous-PG-write question). Then retire Turso (drop `sessions_archive` / `*_backup` tables,
decommission `liveone-tokyo`). Separate planning.

### Loose ends / hardening (independent of the phases)

- **Session FK validation (optional):** the FK is `NOT VALID` (enforces all new rows; confirmed
  still `NOT VALID` by the 2026-06-06 audit). To fully validate, NULL the ~4,165 unrecoverable orphan
  `session_id`s (the 2025-11-27 final purge-window block, ids 301,141–305,599 — the audit measured
  **59,730 orphan reading rows** referencing them) then `VALIDATE CONSTRAINT` — or leave `NOT VALID`
  (preserves their dangling ids). NULL-then-VALIDATE mutates ~60K prod rows, so it needs explicit
  go-ahead; default is leave-as-is.
- **Response-capture monitor — DONE.** `app/api/cron/monitor-observations` (every 15 min, `vercel.json`)
  alerts when recent successful-CRON sessions' `response`-presence drops, when raw stops landing in PG
  despite sessions, or when QStash lag/DLQ grows — the signals that the live mirror pipeline went down
  (it had ~9 such windows in 2026). Alerts POST to `OBSERVATIONS_ALERT_WEBHOOK_URL` (Slack-compatible;
  graceful no-op if unset) and always log structured. _[shipped — #15]_
- **Dev-seed path:** `db:sync-prod` → `scripts/sync-prod-to-dev.js` (missing) and the
  `sync-database` seed from prod Turso both go stale once PG is authoritative — re-point to seed dev
  from PG (during Phase 1).

### PG foreign-key rebuild (decommission-time hardening)

PG was built FK-less for receiver throughput (only `point_readings.session_id → sessions.id` exists,
`NOT VALID`). This rebuild restores the relational graph on PG. **Decommission-time, NOT a cutover
blocker**; runs _after_ the write-to-PG cutover is stable + the reconciler shows agg value-parity,
and _before_ Turso/`*_backup` tables are dropped (so orphan-backfill stays possible). Creds stay in
Clerk → nothing here touches credentials; `users` stays a passive Clerk mirror (so its inbound FKs
are deliberately **not** enforced — see skips).

**Decisions (locked 2026-06-06).** `onDelete`: only trivial rows cascade; everything in the data
lineage is `NO ACTION`, so tearing down a system is always an explicit, ordered op — never a silent
cascade over 13M readings.

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

**Skips:** the redundant single-column `point_readings.system_id → systems` (transitively guaranteed
via #5 + #6); the Clerk-mirror FKs `user_systems.clerk_user_id` / `share_tokens.owner_clerk_user_id
→ users.clerk_user_id` (the mirror lags the Clerk webhook → would fail membership/token writes for
marginal benefit; audit shows 0 drift _today_, but write-time lag is the risk). **Keep** the existing
session FK as-is. **GOTCHA:** `point_info`'s per-system key is DB column **`id`** (the Drizzle TS
field is named `index` → `integer("id")`); the composite PK is `(system_id, id)`. FK target is
`point_info(system_id, id)`, never `(…, index)`.

**Pre-flight audit (`scripts/audit-pg-fk-orphans.ts`, read-only, run 2026-06-06 vs prod):** all 8
proposed constraints are **0-orphan → add + validate cleanly** (decision #4 needs no backfill/clean).
Row counts: `point_readings` 13.4M, `point_readings_agg_5m` 3.3M, `sessions` 870K, `agg_1d` 11.9K,
`point_info` 73, `systems` 9. So #4/#6/#7 (large) use `ADD … NOT VALID` + a separate `VALIDATE`
(validating scan under non-blocking `SHARE UPDATE EXCLUSIVE` instead of `ACCESS EXCLUSIVE` for the
full scan); the rest validate inline. Re-run the audit immediately before executing — 0-orphan is a
point-in-time fact.

**Execution (the `0003` precedent).** Update `lib/db/planetscale/schema.ts`:
`polling_status.systemId`/`userSystems.systemId` → `.references(() => systems.id, {onDelete:"cascade"})`;
`users.defaultSystemId` → `.references(() => systems.id, {onDelete:"set null"})`;
`sessions.systemId` + `pointInfo.systemId` → `.references(() => systems.id)`; and a composite
`foreignKey({columns:[t.systemId,t.pointId], foreignColumns:[pointInfo.systemId, pointInfo.index], name:…})`
in the `point_readings` / `point_readings_agg_5m` / `point_readings_agg_1d` table callbacks. Then
`db:pg:generate`, **hand-edit** the generated `drizzle-planetscale/0004_*.sql` to split #4/#6/#7 into
`NOT VALID` + `VALIDATE` (drizzle emits a plain validating `ADD` by default — same hand-edit as
`0003`) and add the `pg_constraint` re-run guards, then `db:pg:migrate`. Snapshot Turso + confirm PG
PITR first per the CLAUDE.md checklist (constraint-only, but cheap insurance). **Forbidden:** `push`.

Staged SQL (reference — do **not** drop into `drizzle-planetscale/` or apply until the gate above;
add `--> statement-breakpoint` between statements when promoting to a real migration):

```sql
-- 0004_fk_rebuild.sql (STAGED). Pre-flight 2026-06-06: all 0-orphan.
-- Group A — trivial rows → systems (CASCADE / SET NULL), validate inline
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
(adding a constraint never fires a cascade). No rollback migration is authored; removal = a new
forward migration.

## Top risks & how they're handled

- **R3 + R7 — combined message at close + session FK** _[done — PR-7]_: a poll buffers its readings
  and emits one combined QStash message at session close (completed session + all readings); the
  receiver inserts session-then-readings in one transaction; FK added `NOT VALID` (orphan-tolerant
  for legacy rows). Caveats handled: flush on success + failure paths; chunk readings (sharing the
  session id) under QStash's ~1 MB / 10 MB-Fixed limit; a crash mid-poll leaves readings in Turso
  but not the queue (rare, acceptable).
- **R4 — config FK CASCADE** (Phase 1 / PR-9): Turso readings tables FK→`point_info`/`systems` ON
  DELETE CASCADE; drop those FKs (decision B) **before** config writes stop hitting Turso, 0016-grade.
  ⚠️ Live drift: prod FKs reference `*_2025_11_27_backup`, not live tables — investigate first.
- **R5 — no PG migration runner** _[done]_: prod was built by destructive `drizzle-kit push`; now
  baselined into `drizzle.__drizzle_migrations` + on `generate`/`migrate`; **`push` forbidden** on
  authoritative PG (see `drizzle-planetscale.config.ts`).
- **R6 — pool bug** _[done — Stage 1]_: PG pool now memoized unconditionally on `global`; budget
  `max` × warm-instances ≤ PlanetScale connection limit (`PLANETSCALE_POOL_MAX`).
- **R8 — region latency (transitional):** with Vercel→`syd1` and Turso left in Tokyo, the inline
  Turso raw backup write eats ~100ms cross-region RTT per poll. Acceptable (best-effort); gone at
  Phase B.

## Cross-cutting prerequisites

- **Feature-flag seam** `lib/db/routing.ts`: `CONFIG_READS_FROM_PG`, `READINGS_READS_FROM_PG`,
  `AGG_COMPUTE_IN_PG`, `CONFIG_WRITES_TO_PG`, all default false. Each port is additive; cutover =
  flip env var; revert = flip back. _[done]_
- **PG migrations** via `drizzle-kit generate`/`migrate` (`db:pg:generate`/`db:pg:migrate`); baseline
  matching live schema seeded; **never `push`**. _[done — baselined 0000–0003 + config SSL fix]_
- **PITR backups:** set a long-retention custom backup **schedule** + **prevent-deletion** once in
  the PlanetScale dashboard (no documented CLI/API for the schedule); optionally a scripted periodic
  `pscale backup create`.
- **Dev guardrails (C):** distinct `PLANETSCALE_DATABASE_URL` per env; startup assert that throws if
  dev resolves to the prod host (`assertNotProdDbInDev` / `PLANETSCALE_PRODUCTION_HOST`); PITR
  backstop. _[done — Stage 1]_
- **share_tokens PG schema:** bigint epoch-ms columns + text PK (keeps `share-tokens.ts`
  `gt(expiresAtMs, nowMs)` unchanged); write-port detects PG `23505`. _[table done + on prod]_
- **Seed hardening:** config upserts (`onConflictDoUpdate`); seed `polling_status` + `share_tokens`;
  `setval` for the serial config tables (sessions no longer serial — text id); count-shortfall is a
  hard abort. _[done — Stage 1]_
- **Queue quiesce before any trim:** stop publishing a type, drain to lag=0 on `/admin/observations`
  while the OLD receiver still handles all types, then deploy the trimmed receiver; keep removed
  branches as logging no-ops one release.
- **Value-level reconciler** `scripts/reconcile-agg-values.ts`: diff avg/min/max/last/delta per
  system/point/interval within tolerance — gates the aggregation trim. _[done — Stage 1]_

## Completed

- **Aggregation reconciler driven GREEN (2026-06-07).** Investigation found PG **raw was complete** —
  the earlier "43–48% short" was a client-TZ artifact (node-postgres serializes Date params in local tz
  vs the UTC `timestamp` columns); re-checked with `TZ=UTC`, `gap-map-raw-readings.ts` shows zero raw
  deficits for 2026. The real RED causes were (a) historical PG **5m** never recomputed (queue-mirror
  gaps before `AGG_COMPUTE_IN_PG`) → `agg_1d` `sampleCount` short, isolated to 2026-06-06; and (b) Amber
  (sys9) **5m staleness** (late `updateUsage` dropped by the receiver's `onConflictDoNothing`).
  `scripts/recompute-pg-range.ts --apply` recomputed raw-vendor 5m from PG raw + re-copied Amber 5m +
  recomputed 1d; `aggregateRange` regenerated 06-06's 1d on both stores. Result: `agg_5m` + `agg_1d`
  reconcile **0 value mismatches** (`--days=2` and 2026-06-04..06-07). Snapshot
  `liveone-snapshot-20260607-171037` taken first. New scripts: `gap-map-raw-readings.ts`,
  `recompute-pg-range.ts`. Durable fixes (receiver 5m-native upsert; mirror monitor) **shipped via #15**.
- **#15 — agg-reconciler durability + tooling shipped (merged 2026-06-07).** Receiver now upserts
  5m for 5m-native systems (Amber refinements should heal automatically); the `monitor-observations` cron
  (every 15 min) lands for mirror-health alerting; `recompute-pg-range.ts` + `gap-map-raw-readings.ts`
  tooling lands. This was item 1 of _What's next_. ✅ A 2026-06-07 re-run **proved the auto-heal** (85
  post-deploy Amber refinements healed PG within seconds); the 16 remaining sys-9 mismatches are
  pre-deploy stale rows fixed by a one-shot recompute — see
  [Open follow-up](#open-follow-up--amber-system-9-5m-live-tail-drift).
- **Phase 1 — config authority on Postgres (2026-06-07).** Flipped `CONFIG_SERVE_FROM_PG` +
  `CONFIG_WRITES_TO_PG` in prod; PG is now the config system of record. Pre-flight: fresh snapshot
  `liveone-snapshot-20260607-000847`, full Turso↔PG config parity (`scripts/parity-config-turso-vs-pg.ts`),
  and a write-routing completeness audit (every config write flag-routed; no Turso bypass). Post-flip
  verified: `[CONFIG-SERVE]` ≈ 0, writes landing on PG, shadow compare stopped. Side fixes: the
  receiver's recurring `NEXT_HTTP_ERROR_FALLBACK;404` (Clerk middleware now allow-lists
  `/api/observations(.*)`) and the un-awaited `protect()` no-op (separate PR #12).
- **Stage 1 (PR-0…PR-6)** merged.
- **PR-7** (session-id UUIDv7/text + co-enqueue + transactional receiver + FK `NOT VALID` + drop
  unique) shipped to prod via: PG cols→text (psql), Turso `sessions` table-aside (rename →
  `sessions_archive`, fresh text-id `sessions`), app deploy. tsc clean, 286 unit tests, build green.
- **Data recoveries — nothing lost:** 36 deploy-window sessions; 19 backfill-gap sessions; **118,613
  purged Sep–Nov 2025 sessions** recovered full-fidelity from snapshot
  `liveone-snapshot-20251126-195709`; **147,727 response blobs** restored from `sessions_archive`.
  ~4,165 orphans remain (the 2025-11-27 final purge-window block, in no snapshot) — tolerated under
  the `NOT VALID` FK.
- **Why prod sessions were purged:** the `sessions` table (added 2025-09-28) had ids 1–305,599
  removed in a ~2025-11-27 rebuild (matches the `*_2025_11_27_backup` tables); oldest surviving id
  305,600 = 2025-11-27 05:43.
- **"Response capture decline" investigated — not a regression:** the live poll code always captured
  `response`; the PG nulls came from an intermittently-running mirror pipeline (~9 ON/OFF windows in 2026) + the 2026-06-05 backfill writing `response: null`. Every response existed in Turso (now
  restored).
- **Prod PG hardening:** `share_tokens` created; `drizzle.__drizzle_migrations` baselined;
  `db:pg:migrate` SSL handling fixed.

## Dev Postgres wiring (shared PlanetScale dev branch)

Dev uses a **shared PlanetScale dev branch** (not a separate engine), with Postgres PITR as the
safety backstop.

**Env (`.env.local`):** `PLANETSCALE_DATABASE_URL` → the dev branch (runtime client);
`PLANETSCALE_DATABASE_URL_MIGRATIONS` (or `DB_*`) → DDL creds for `db:pg:migrate`;
`PLANETSCALE_PRODUCTION_HOST` → the prod branch host (a hostname, not a credential) — setting it
**arms the guardrail**; `PLANETSCALE_POOL_MAX` (optional, default 10).

**Prod-host guardrail (`lib/db/planetscale/index.ts`):** `assertNotProdDbInDev()` throws outside
production if the resolved host matches `PLANETSCALE_PRODUCTION_HOST`. Inert until that var is set;
`ALLOW_PROD_DB_IN_DEV=true` is an explicit one-off escape hatch (e.g. a read-only prod
seed/reconcile run).

**`receive-dev`:** `app/api/observations/receive-dev/route.ts` currently only logs (no PG writes), so
the dev queue pipeline doesn't populate dev Postgres today. To exercise the PG ingest path in dev,
point the publisher's receiver URL at a dev receiver that writes the dev branch, or extend
`receive-dev` to write (guarded by the guardrail).

## Turso read/write-site inventory

Generated from importers of `@/lib/db/turso*`. A **scoping checklist** — exact tables per file are
confirmed during the relevant PR. Classes: **Config** (→ PG-authoritative), **Readings** (→ PG
read/compute), **Mixed**, **Ops/Vendor/Script/Test**.

**Config accessors & write sites → Phase 1 (PR-8/9/10):** `lib/systems-manager.ts`
(systems⋈polling_status + `createSystem`); `lib/polling-utils.ts` (polling_status; atomic increment +
log-not-throw); `lib/share-tokens.ts` (share_tokens; PG `23505`); `lib/user-preferences.ts` (users +
`userHasSystemAccess`); `app/api/setup/route.ts`;
`app/api/admin/systems/[systemId]/{status,admin-settings,settings,composite-config}/route.ts`;
`app/api/admin/users/route.ts`, `app/api/admin/user/[userId]/points/route.ts`; `app/api/systems/route.ts`;
`app/api/auth/{enphase,tesla}/{callback,disconnect}/route.ts`.

**Readings reads & aggregation compute → Phase 2 (PR-11/12):** `lib/history/point-readings-provider.ts`
(**the** serving provider; ms↔timestamp + started↔createdAt); `app/api/data/route.ts`;
`app/api/system/[systemId]/generator-events/route.ts`;
`app/api/admin/systems/[systemId]/point-readings/route.ts`,
`app/api/admin/point/[systemIdDotPointId]/readings/route.ts`; `lib/db/turso/aggregate-daily-points.ts`
(1d); `lib/point-aggregation-helper.ts` (5m); `app/labs/kinkora-hws/page.tsx` (low priority).

**Mixed:** `lib/point/point-manager.ts` (point_info CRUD = config/PR-9 **and** raw insert + 5m + KV
cache = readings/PR-11; split by concern); `lib/session-manager.ts` (session lifecycle — **done, PR-7**);
`app/api/system/[systemId]/point/[pointId]/route.ts`.

**Vendor adapters:** `lib/vendors/enphase/*` (5m-native; 5m stays queue-fed, read config from PG
post-cutover); `lib/observations/publisher.ts` (point_info type only).

**Ops / cron / sync:** `app/api/cron/daily/route.ts` (1d trigger, PR-11);
`app/api/cron/db-stats/route.ts`, `app/api/admin/storage/route.ts`, `app/api/health/route.ts`
(stats/health; port opportunistically); `app/api/admin/sync-database/{route,stages}.ts` (dev-seed
from prod Turso — re-point to seed dev from PG, or retire); `app/api/enphase-proxy/route.ts`.

**Scripts:** `scripts/backfill-turso-to-postgres.ts`, `scripts/seed-planetscale-refs.ts`,
`scripts/reconcile-agg-values.ts` (read Turso, write/compare PG — intended). One-off recoveries
(2026-06-06): `scripts/temp/recover-sessions-fullfidelity.ts`, `scripts/temp/backfill-session-responses.ts`.

**Tests:** `app/api/system/__tests__/point.integration.test.ts` — needs a PG-backed harness once
reads move (PR-12).

**Note:** `db:sync-prod` → `scripts/sync-prod-to-dev.js` does **not exist** — the documented
dev-refresh path is already broken; decide the post-cutover dev-seed source (seed dev from PG).

## Tools

> ⚠️ **Run every Turso/PG comparison or recompute script with `TZ=UTC`.** PG `point_readings`/`agg_*`
> use `timestamp without time zone` (UTC); node-postgres serializes JS `Date` params in the client's
> local tz, so on a non-UTC machine date-bounded queries silently shift ~tz-offset hours and mis-report.
> `gap-map-raw-readings.ts` and `recompute-pg-range.ts` also force `TZ=UTC` in-process as a backstop.

- `scripts/backfill-turso-to-postgres.ts` — historical backfill + `--verify` (see its doc).
- `scripts/gap-map-raw-readings.ts` — READ-ONLY per-(system, UTC-day) raw-count diff Turso vs PG
  (scoped/indexed); `--apply` copies the missing raw rows (onConflictDoNothing). Run with `TZ=UTC`.
- `scripts/recompute-pg-range.ts` — recompute raw-vendor 5m from PG raw + re-copy 5m-native 5m from
  Turso + recompute 1d, over `--from/--to` (optional `--system`); dry-run default, `--apply` to write.
  Idempotent. The tool that drove the reconciler GREEN on 2026-06-07. Run with `TZ=UTC`.
- `scripts/seed-planetscale-refs.ts` — re-seed `systems` + `point_info` if metadata changes.
- `scripts/reconcile-agg-values.ts` — read Turso, compare aggregate values against PG (the gate). `TZ=UTC`.
- `scripts/audit-pg-fk-orphans.ts` — READ-ONLY FK pre-flight: lists existing PG constraints + row
  counts + orphan counts per proposed FK (run before the FK rebuild; see hardening section).
- `scripts/purge-observations-queue.ts` — purge + recreate the QStash queue (paused).
- `scripts/qstash-health.ts` — READ-ONLY one-shot snapshot of live mirror health (QStash queue
  lag/DLQ/paused/parallelism + PG response-presence + raw-landing age); the CLI sibling of the
  `monitor-observations` cron. Run with `TZ=UTC`.
- `app/api/cron/monitor-observations` — mirror-health monitor (response-presence, raw-landing, queue
  lag/DLQ) + alert; `/admin/observations` — live pipeline depth, ingestion rate, queue/DLQ controls.

## Verification

- Per PR: `npm run build:local && npm run typecheck`; targeted `npm test`; shadow-diff (PR-8/11/12)
  logs Turso-vs-PG divergence with the flag on but reads still served from Turso.
- The value reconciler gates the aggregation trim (PR-13).
- After the next daily cron: `--verify --table=agg_1d` clean; dashboard lag ~0.

## Rollback

- Additive / flag-gated PRs (PR-8, 9, 11, 12; the PR-7 work): revert the PR or flip the env flag
  (instant, no logic redeploy); `DROP CONSTRAINT` removes the session FK.
- CUTOVER PRs (PR-10, PR-13): flip the relevant flag back (instant). Config has no Turso dual-write
  soak (decision B), so config rollback relies on **PG PITR** + the pre-cutover Turso snapshot;
  flipping `CONFIG_READS_FROM_PG` back reads stale-but-rarely-changing Turso config (acceptable).
- Always take a fresh Turso snapshot (`turso db create --from-db liveone-tokyo …`) and confirm PG
  PITR before each CUTOVER PR. The old "pause the queue, Turso untouched" rollback is valid only
  **before** PR-10. If ingestion misbehaves, **pause the queue** from `/admin/observations` — Turso
  keeps serving; backfill writes are idempotent (worst case `TRUNCATE` the PG table(s) and re-run).
