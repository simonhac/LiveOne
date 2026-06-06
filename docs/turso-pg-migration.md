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

**Refined Turso scope (2026-06-06).** Turso has **no special or lasting status** — it is a
transitional, **best-effort backup of raw `point_readings` + sessions only**, kept until Postgres
is fully trusted and then dropped. **Everything else — the config tables _and_ all aggregates —
lives in Postgres, which serves every read.** Design as if **Postgres is the only store**; the
inline Turso write is an extra best-effort backup the engine can delete with zero architectural
change. Retiring Turso is gated on **raw-durability-on-Postgres** (accept the at-least-once QStash
queue with monitoring, or add a synchronous PG raw write) — not on any feature it provides.

**Overarching architectural direction — engine/web separation.** The deeper reason for the
migration is to cleanly separate the data-collection **engine** (scheduler/poll + vendor adapters +
collector + the QStash receiver — all writes) from the **web/FE** (read API + UI + config/admin), so
the front-end can iterate (and **multiple FEs** can run) without ever risking data collection.
Postgres is what makes that boundary clean: **the web reads only Postgres + KV; the engine owns all
writes.** See the **Direction of travel** section below.

## Status (2026-06-06)

- **Stage 1 (additive groundwork) — merged.** Flag seam (`lib/db/routing.ts`, all flags default
  off), PG pool memoization fix, PG migration tooling, `share_tokens` PG table, seed hardening,
  value reconciler, dev guardrail + read-site inventory. Live QStash→PG pipeline + historical
  backfill done (verified, zero dropped); 1d aggregates flow via the queue.
- **PR-7 — LIVE in prod.** Session id → UUIDv7/text; one combined QStash message co-enqueued per
  poll at session close; transactional session-before-readings receiver;
  `point_readings.session_id → sessions.id` FK added `NOT VALID`; dropped the `sessions` unique.
  **Admin session reads now served from PG.**
- **Postgres still SERVES most reads from Turso.** Config + readings reads still come from Turso
  (`CONFIG_READS_FROM_PG` / `READINGS_READS_FROM_PG` / `CONFIG_WRITES_TO_PG` default off). `AGG_COMPUTE_IN_PG`
  is now **ON** in prod (PG computes its own raw-vendor aggregates — see below). Turso is the source
  of truth for everything not yet cut over.
- **PR-11 (Move 1) — MERGED, ENABLED in prod, and VALIDATED.** PG computes its own raw-vendor 5m + 1d
  from PG's own data (`AGG_COMPUTE_IN_PG` flipped on). Verified value-clean vs Turso via
  `scripts/reconcile-agg-values.ts` for the active raw vendors (Selectronic sys1: full-day 5m + 1d
  zero mismatch; Mondo sys6 clean after the fix below). Reads are still served from Turso (shadow).
- **Observation timestamp ms-truncation bug — found, fixed, deployed (PR #8 merged).** The QStash
  publisher serialized `measurementTime`/`receivedTime` at second precision (`formatTime_fromJSDate`
  had no `.SSS`), so every reading reaching PG **via the queue** lost sub-second precision while
  Turso's inline write kept ms. For ms-precision raw vendors (Mondo) this produced duplicate
  `point_readings` under the unique index. Fixed (publisher now emits ms), deployed, and remediated:
  `scripts/dedupe-pg-truncated-readings.ts` removed 2,664 truncated dups + `scripts/restore-sys6-precision.ts`
  restored 11,700 residual rows to ms (PR #9). sys6 now reconciles clean.
- **PR-8 (config reads, shadow) — first slice MERGED-pending (PR #10).** `lib/db/config-shadow.ts`
  `shadowReadConfig()` seam + normalizers (`toEpochSeconds` truncate-to-seconds for Turso↔PG timestamp
  parity, `normalizeJson` for text-json vs jsonb); `getPollingStatus` wrapped; 10 unit tests. Remaining
  config read sites reuse the seam.
- **Prod PG hardening (done):** `share_tokens` created on prod; `drizzle.__drizzle_migrations`
  baselined (0000–0003); `db:pg:migrate` SSL bug fixed → migration tooling works end-to-end.
- **Data recoveries (done):** all session data preserved — see [Completed](#completed-2026-06-06).

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
- **(D) Move Vercel + PlanetScale to Sydney.** Turso stays in Tokyo, retired once PG is trusted.
- **(F) Turso = transitional backup of raw + sessions only** _(2026-06-06)_ — no special or lasting
  status. Config **and** all aggregates leave Turso entirely (PG is the sole aggregator). Retire
  Turso once **raw-durability-on-PG** is proven; nothing is designed to depend on it. Supersedes any
  "Turso = permanent substrate" framing.
- **(G) Engine/web separation is the end goal** _(2026-06-06)_ — two independently deployable units
  (collection engine vs web/FE); Postgres + KV + the QStash queue + an engine Control API are the
  only cross-boundary contracts. See the **Direction of travel** section.

## Direction of travel — engine/web separation

The migration is the enabler for a deeper split: separate the data-collection **engine** from the
**web/FE** so the front-end can iterate (and **multiple FEs** can run) without ever disturbing data
collection.

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

- **Sync (request/response)** — interactive config that needs the engine's vendor-adapter code:
  _test connection, discover monitoring points, validate credentials, "poll now & show the result."_
  Browser → web server (Clerk authz) → engine **Control API** (service auth) → runs it → returns.
- **Async (durable job)** — long / fire-and-forget: _poll-now batch, recompute, resync._ The Control
  API enqueues a job (a `jobs` row in PG, or QStash) and returns a job id; the engine worker executes
  and writes status back to the `jobs` row (or KV) for the FE to poll.

Config _persistence_ (add system, edit point metadata) writes the authoritative store (PG); the
engine reads it fresh. **Credentials** flow through the Control API into the engine's encrypted store
(the engine owns them). Net: the engine exposes exactly two inbound contracts — the **QStash
receiver** and the **Control API**.

**Hard decouplings (code, not deploy — all behaviour-preserving; do these first):**

1. **Vendor credentials off Clerk** → an encrypted Postgres config table the engine reads headless
   (`lib/secure-credentials.ts` and `SystemsManager.getSystemByUsernameAndAlias` call `clerkClient()`
   — the biggest blocker; dovetails with the config-writes PR).
2. **Split `lib/api-auth.ts`** into Clerk-auth (web) vs secret/signature-auth (engine) — the QStash
   receiver already uses signature auth.
3. **Extract `pollAllSystems()` / daily aggregation / the receiver handler** out of `NextRequest`/SSE
   route handlers into host-agnostic `async` functions (so they run under a Next route _or_ a worker).
4. **Stop assuming cross-service cache coherence** — `SystemsManager`/`PointManager` 60s caches and
   the `global`-memoised DB pools are fine per-process; the store is the source of truth.

**Deployment.** Monorepo → `packages/core` (db clients, schema, aggregation math, identifiers,
date-utils, observation types, routing flags) + `apps/engine` (crons + receiver + Control API; a
stable public domain e.g. `engine.liveone.energy`; co-located with PG) + `apps/web` (×N). Likely two
Vercel projects from one repo (keeps the cron/serverless model); engine-as-worker (Fly/Railway) is a
later option if serverless limits bite. **Sequence the deploy split AFTER the store is on PG** — the
hard decouplings (1–4) land incrementally now; the split is then mechanical.

## Two table classes (until Turso retired)

- **Config (authoritative in PG):** `systems`, `point_info`, `users`, `user_systems`,
  `polling_status`, `share_tokens`. Dev-only `clerk_id_mapping`/`sync_status` out of scope.
- **Readings (PG-authoritative; Turso = best-effort raw+sessions backup only):** raw `point_readings`
  (dual-write: PG via queue + Turso inline backup), sessions (queue → PG, Turso backup), 5m-native 5m
  (queue). All `agg_5m`/`agg_1d` computed in PG; **Turso no longer computes or stores any aggregates.**
- **Out of scope — legacy, never migrated:** the old `readings` / `readings_agg_5m` /
  `readings_agg_1d` tables (superseded data model, no longer read) are **not** moved to Postgres;
  they're left behind and dropped when Turso is decommissioned. The migration concerns
  `point_readings*` only.

## What's next — phased plan

PR-7, PR-11 (enabled + validated), and the PR-8 config-reads seam are done. **Every cutover: take a
fresh Turso snapshot first, land via a PR (never direct-to-`main`), and stay revertible by flag flip.**

### ▶ Next phase (now): "Postgres owns everything but the raw/sessions backup"

**Goal of the phase:** move everything _except_ the raw+sessions backup onto Postgres — config
tables, all aggregates, and all reads — so the **web reads only PG + KV** and Turso is reduced to a
disposable raw+sessions backup. Land the engine/web _code_ decouplings in parallel (behaviour-
preserving) so the eventual deploy split is mechanical. ~1–2 sub-phases.

**Workstreams:**

- **A · Config → PG** (Phase 1: PR-8 → PR-9 → PR-10). Finish wrapping the remaining config read sites
  through the shadow seam — `SystemsManager.loadSystems` (systems⋈polling_status; the big one, covers
  most API routes transitively), then `point_info`, `userHasSystemAccess`, share-tokens, the few
  direct-read routes — and soak shadow-diff clean. Then PR-9 (config writes PG-only behind
  `CONFIG_WRITES_TO_PG`; prereq: drop the Turso readings→config CASCADE FKs, 0016-grade — investigate
  the live FK drift first) and PR-10 (flip both config flags). Config then lives only in PG.
- **B · Aggregates → PG only.** PR-11 is enabled + validated; the remaining step is to **stop Turso
  aggregating at all** — turn off `updatePointAggregates5m` + the Turso daily aggregation so PG is the
  sole aggregator (stronger than the old "trim publishers"). Gate on the reconciler clean over a
  settled window. `agg_5m`/`agg_1d` then leave Turso entirely.
- **C · Readings reads → PG** (PR-12). PG point-readings provider behind `READINGS_READS_FROM_PG`
  (ms↔timestamp + started↔createdAt); shadow-diff, then cut over `data`/`history`/generator-events/
  admin reads; "latest" stays on KV. After this **the web reads nothing from Turso.**
- **D · Engine/web decoupling prep** (no deploy split yet). The four hard decouplings from _Direction
  of travel_: (1) vendor creds off Clerk → encrypted PG config — do this **with** PR-9, it's both a
  config-write and the #1 separation blocker; (2) split `api-auth` into Clerk-auth vs secret-auth;
  (3) extract `pollAllSystems`/daily-agg/receiver into host-agnostic functions; (4) carve the `core`
  import surface. All behaviour-preserving, mergeable independently.

**Sequencing:** A + D‑creds together → B (anytime; PR-11 already validated) → C (after A+B so PG is a
complete read store) → coordinate the Sydney move (Phase 3) with C so compute + PG stay co-located.
D‑auth/extract land in parallel.

**Exit criteria:** Turso holds **only** raw `point_readings` + sessions (best-effort backup); PG is
authoritative for config + aggregates and serves every read; the web touches only PG/KV; engine code
is Clerk-free and host-agnostic. (_Dropping_ Turso — removing the backup write — is a later call,
gated on raw-durability-on-PG; see Phase 4.)

The detailed per-PR notes follow.

### Phase 1 — Config authority → Postgres (PR-8 → PR-9 → PR-10)

**Goal:** make the config tables authoritative in Postgres.

- **PR-8 — config reads** behind `CONFIG_READS_FROM_PG` (default off) + shadow-diff Turso vs PG at
  every read site (SystemsManager systems⋈polling*status, PointManager point_info cache,
  `userHasSystemAccess`, share-tokens validation, `app/api/setup`, admin systems/users routes).
  Couple polling_status reads with systems (flip together). *[FIRST SLICE SHIPPED — PR #10:
  shadow-only seam `lib/db/config-shadow.ts` (`shadowReadConfig` + `toEpochSeconds`/`normalizeJson`
  normalizers) + `getPollingStatus` wrapped + 10 unit tests. Remaining read sites reuse the seam.]\_
  **Shadow semantics:** flag ON still SERVES Turso, only compares-and-logs PG divergence (PG errors
  swallowed); serving from PG is the PR-10 cutover.
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

- **PR-11 — PG aggregation** behind `AGG_COMPUTE_IN_PG`. _[DONE — merged, ENABLED in prod, validated
  value-clean vs Turso for the active raw vendors via `scripts/reconcile-agg-values.ts`]_. Idempotent
  recompute of raw-vendor 5m + 1d keyed `(systemId, intervalEnd)` /
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
- **PR-13 — stop Turso aggregating entirely** (refined per decision F — was "trim publishers"). Once
  the reconciler is clean over a settled window: turn off `updatePointAggregates5m` + the Turso daily
  aggregation so **PG is the sole aggregator** and `agg_5m`/`agg_1d` leave Turso. Also quiesce the
  queue to lag 0 on `/admin/observations` and drop the raw-vendor 5m/1d queue publishers + the
  receiver's raw-vendor 5m/1d inserts. **Keep** raw, sessions, and 5m-native 5m on the queue. Keep
  removed branches as logging no-ops one release.
- **Verify:** reconciler clean; dashboard lag ~0. **Rollback:** flip `READINGS_READS_FROM_PG` back;
  re-enable Turso aggregation.

### Phase 3 — Region move to Sydney (parallel ops; coordinate with Phase 1/2 cutovers)

Provision PlanetScale Postgres in **Sydney (ap-southeast-2)** (data via backup/branch restore), set
Vercel `regions` to **`syd1`** (`vercel.json`), re-point env vars. Turso stays in Tokyo (being
decommissioned). Sequence the data move with the read cutover so compute + data stay co-located.
Mostly cloud-ops + a one-line `vercel.json` change.

### Phase 4 — Retire Turso (later; the migration's single exit condition)

By this point Turso holds **only** its best-effort raw + sessions backup. Retiring it reduces to one
question — **raw durability on Postgres** without the inline Turso write as the synchronous safety
net: either accept the at-least-once QStash queue (with a drop/lag monitor) or add a synchronous PG
raw write (re-opens the synchronous-PG-write question). Only once that's trusted ("100% happy with
Postgres"): stop the Turso raw+sessions backup write, drop `sessions_archive` / `*_backup` tables,
and decommission `liveone-tokyo`. **Nothing else depends on this** — it's purely the exit condition.
Separate planning.

### Loose ends / hardening (independent of the phases)

- **Session FK validation (optional):** the FK is `NOT VALID` (enforces all new rows). To fully
  validate, NULL the ~4,165 unrecoverable orphan `session_id`s (the 2025-11-27 final purge-window
  block, ids 301,141–305,599) then `VALIDATE CONSTRAINT` — or leave `NOT VALID` (preserves their
  dangling ids).
- **Response-capture monitor:** alert when successful-CRON sessions' `response`-presence drops below
  a threshold — the signal that the live mirror pipeline has gone down (it had ~9 such windows in
  2026; gaps were backfilled `response: null`, since restored from the Turso archive).
- **Dev-seed path:** `db:sync-prod` → `scripts/sync-prod-to-dev.js` (missing) and the
  `sync-database` seed from prod Turso both go stale once PG is authoritative — re-point to seed dev
  from PG (during Phase 1).

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
