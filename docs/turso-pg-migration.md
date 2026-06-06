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
reviewed against the actual code.

## Status (2026-06-06)

- **Stage 1 (additive groundwork) — merged.** Flag seam (`lib/db/routing.ts`, all flags default
  off), PG pool memoization fix, PG migration tooling, `share_tokens` PG table, seed hardening,
  value reconciler, dev guardrail + read-site inventory. Live QStash→PG pipeline + historical
  backfill done (verified, zero dropped); 1d aggregates flow via the queue.
- **PR-7 — LIVE in prod.** Session id → UUIDv7/text; one combined QStash message co-enqueued per
  poll at session close; transactional session-before-readings receiver;
  `point_readings.session_id → sessions.id` FK added `NOT VALID`; dropped the `sessions` unique.
  **Admin session reads now served from PG.**
- **Postgres is still a MIRROR for most reads.** Config + readings reads still come from Turso
  (`CONFIG_READS_FROM_PG` / `READINGS_READS_FROM_PG` / `AGG_COMPUTE_IN_PG` / `CONFIG_WRITES_TO_PG`
  all default off). Turso is the source of truth for everything not yet cut over.
- **Config seam (1A + 1B + 1C) — in this PR (`simonhac/pr8-config-reads`); deploys dark.** Read-shadow,
  serve-from-PG (`CONFIG_SERVE_FROM_PG`), and PG-only writes — all flags default off. Execute via the
  **config cutover runbook** below.
- **PR-11 (Move 1) — code-complete, NOT yet enabled.** PG can compute its own raw-vendor 5m +
  1d aggregates from PG's own data behind `AGG_COMPUTE_IN_PG` (default **off** = exactly today's
  behavior). Shadow-only: reads still served from Turso; the value reconciler gates trusting it.
  Lands via PR (branch `simonhac/pg-pr7-session-id` continuation). Enable in prod only after the
  reconciler is clean over a settled window.
- **Prod PG hardening (done):** `share_tokens` created on prod; `drizzle.__drizzle_migrations`
  baselined (0000–0003); `db:pg:migrate` SSL bug fixed → migration tooling works end-to-end.
- **Data recoveries (done):** all session data preserved — see [Completed](#completed-2026-06-06).

## As soon as this PR is pushed — config cutover runbook

This PR (`simonhac/pr8-config-reads`) bundles the whole config seam — **1A** read-shadow
(`CONFIG_READS_FROM_PG`), **1B** PG-only writes (`CONFIG_WRITES_TO_PG`), **1C** serve-from-PG
(`CONFIG_SERVE_FROM_PG`). All three default **off**, so merge + deploy is **dark** (identical to
today). The cutover is driven entirely by flipping prod env flags — revert = flip back, no redeploy.

Flag semantics (`lib/db/config-shadow.ts`): READS on + SERVE off = **shadow** (serve Turso, also read
PG, compare, log `[CONFIG-SHADOW] … DIVERGE`; PG errors swallowed — can't affect a request). SERVE on
= **serve from PG** (Turso fallback on error/skip, logged `[CONFIG-SERVE]`; the shadow compare is not
run). WRITES on = config writes hit **PG only** (no Turso dual-write).

1. **Merge + deploy (dark).** Confirm healthy; with all config flags off the behavior is unchanged.
2. **Shadow.** Set `CONFIG_READS_FROM_PG=true` in prod. Watch for `[CONFIG-SHADOW] … DIVERGE` /
   `pg-read failed` across the read sites (systems⋈polling_status, point_info, `userHasSystemAccess`,
   share-tokens validate/list, `/api/setup`, admin systems/users). Soak until a clean window with
   **0 divergences** (especially `userHasSystemAccess` — access control). If config drifted, re-seed:
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

## What's next — phased plan

PR-7 is done and live. The remaining work groups into **four phases**. **Every cutover: take a fresh
Turso snapshot first, land via a PR (never direct-to-`main`), and stay revertible by flag flip.**

### Phase 1 — Config authority → Postgres (PR-8 → PR-9 → PR-10)

**Goal:** make the config tables authoritative in Postgres.

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

- **PR-11 — PG aggregation in shadow** behind `AGG_COMPUTE_IN_PG`. _[IMPLEMENTED — code-complete,
  flag default off]_. Idempotent recompute of raw-vendor 5m + 1d keyed `(systemId, intervalEnd)` /
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
- **Response-capture monitor:** alert when successful-CRON sessions' `response`-presence drops below
  a threshold — the signal that the live mirror pipeline has gone down (it had ~9 such windows in
  2026; gaps were backfilled `response: null`, since restored from the Turso archive).
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

## Completed (2026-06-06)

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

- `scripts/backfill-turso-to-postgres.ts` — historical backfill + `--verify` (see its doc).
- `scripts/seed-planetscale-refs.ts` — re-seed `systems` + `point_info` if metadata changes.
- `scripts/reconcile-agg-values.ts` — read Turso, compare aggregate values against PG.
- `scripts/audit-pg-fk-orphans.ts` — READ-ONLY FK pre-flight: lists existing PG constraints + row
  counts + orphan counts per proposed FK (run before the FK rebuild; see hardening section).
- `scripts/purge-observations-queue.ts` — purge + recreate the QStash queue (paused).
- `/admin/observations` — live pipeline depth, ingestion rate, queue controls + queue/DLQ inspection.

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
