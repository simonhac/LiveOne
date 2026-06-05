# Postgres-primary migration — final plan

## Context

LiveOne records energy data into Turso (libsql/SQLite, Tokyo) as the system of record, with a
Postgres mirror (PlanetScale-hosted **Postgres**, not MySQL) fed asynchronously through an Upstash
QStash queue (publisher → receiver route). Goal: **make Postgres the primary** (serve reads from it;
move the system/config tables to it), demote **Turso to a transitional best-effort backup**, and
**decommission Turso soon**. End-state is Postgres-only. Vercel + PlanetScale relocate to Australia.

This plan was adversarially reviewed by a 6-lens multi-agent workflow against the actual code
(verdict: the first draft was ~60% complete / unsafe — three load-bearing claims were wrong), then
refined through a series of user decisions. It is a **staged, flag-gated, multi-PR program.**

## Confirmed current pipeline

- **Publish** `lib/observations/publisher.ts:97` → QStash, for raw (`point-manager.ts:637`, before
  the Turso write), 5m (`insertPointReadingsAgg5m`), 1d (`aggregate-daily-points.ts`), sessions
  (`session-publisher.ts`).
- **Consume** `app/api/observations/receive/route.ts` writes `point_readings`/`agg_5m`/`agg_1d`/
  `sessions` to PG; returns 500 on failure so QStash retries.
- **Today:** Turso written synchronously inline; PG eventually consistent via the queue; aggregation
  computed in Turso and shipped; all serving reads hit Turso; session id is Turso's autoincrement
  (`session-manager.ts:104-107`), preserved as the PG PK by the receiver (`receive/route.ts:264`).

## Locked decisions

- **Reads** flip to Postgres (accept queue lag). **Raw** keeps the async dual-write (Turso inline
  best-effort backup + queue → PG).
- **Sessions go through the queue**, PG-mirrored (not synchronous in PG).
- **(E) Session id = UUIDv7, app-generated** at poll start (replaces Turso autoincrement; removes the
  Turso minting dependency now). **(E1) cast-to-text in BOTH DBs:** `sessions.id`,
  `point_readings.session_id`, `agg_5m.session_id` become **`text`** — historical values = stringified
  integers, new ids = UUIDv7 (time-ordered as text). No data/linkage loss.
- **Enphase/Amber** (5m-native, no raw) keep flowing their 5m **through the queue**.
- **(A) Aggregation ported to Postgres** for raw vendors (Selectronic/Fusher) via deferred idempotent
  recompute; 5m-native vendors' 5m stays queue-fed. Needs a value reconciler.
- **(B) Config writes → Postgres only**; **drop the FK constraints on the Turso readings tables** so
  the Turso raw backup survives with config rows living only in PG. Turso config goes stale; config
  rollback relies on **PG PITR** + a pre-cutover Turso snapshot.
- **(C) Dev = shared PlanetScale dev branch** + hard guardrails + PITR backstop.
- **(D) Move Vercel + PlanetScale to Australia** (Sydney, ap-southeast-2 / `syd1`). Turso stays in
  Tokyo, decommissioned soon.

## Corrected misconceptions (now resolved)

1. "Queue carries raw only / PG computes all 5m from raw" → wrong (Enphase/Amber have no raw) →
   their 5m stays on the queue.
2. "sessionId minted in PG" → wrong (Turso-minted today) → replaced by app-generated UUIDv7 (E).
3. "`--verify` proves PG aggregates match Turso" → wrong (count-only, assumes PG ⊆ Turso) → a real
   value-level reconciler is required for (A).

## Two table classes (until Turso decommission)

- **Config (authoritative in PG):** `systems`, `point_info`, `users`, `user_systems`,
  `polling_status`, `share_tokens`. Dev-only `clerk_id_mapping`/`sync_status` out of scope.
- **Readings (queue → PG; Turso best-effort backup):** raw `point_readings` (dual-write), sessions
  (queue), 5m-native 5m (queue). Raw-vendor `agg_5m`/`agg_1d` **computed in PG** (idempotent
  recompute), not mirrored to Turso.

## Top risks & how they're handled

- **R3 + R7 → single-message-at-close (chosen design):** buffer a poll's readings and emit **one
  combined QStash message at session close** containing the _completed_ session + all its readings
  (the gap between last reading and session close is ms, so latency is negligible). The receiver
  inserts the session then its readings **in one transaction** → self-contained, ordering guaranteed,
  no pending-stub/completion-update dance. Then **drop PG `sessions_system_created_at_unique`**
  (`schema.ts:172-175`) and **add the FK** `point_readings.session_id → sessions.id` (`NOT VALID` →
  `VALIDATE` after an orphan check). With UUIDv7 PKs (E) distinctness is guaranteed. Caveats: emit on
  success **and** failure paths; keep each message under QStash's 1 MB (10 MB on Fixed-1M) limit —
  chunk readings across messages sharing the session id, or trim the `response` blob, for huge polls;
  a crash mid-poll leaves readings in Turso (backup) but not the queue (acceptable, rare).
- **R4 (config FK CASCADE):** Turso readings tables FK→`point_info`/`systems` ON DELETE CASCADE
  (`schema-monitoring-points.ts:110-113,160-163,203-206`). Drop those FKs (decision B) **before**
  config writes stop hitting Turso. The drop is a SQLite table rebuild → **0016-grade care**
  (snapshot, `BEGIN TRANSACTION`, row-count validation before `DROP`, recreate indexes, test on a
  copy). **Combine with the E1 Turso session_id→text rebuild** so the big Turso tables are rebuilt once.
- **R5 (no PG migration runner):** tables were made by destructive `drizzle-kit push`. Adopt
  `drizzle-kit generate`/`migrate`; **forbid `push`** on authoritative PG.
- **R6 (pool bug):** PG pool memoized on `global` only when not-production (`index.ts:82-84,105-107`)
  and `isPlanetscaleConfigured()` re-allocates (`:122`) → unbounded pools. Memoize unconditionally;
  budget `max` × warm-instances ≤ PlanetScale connection limit.
- **R8 (region latency, transitional):** with Vercel→`syd1` and Turso left in Tokyo, the inline Turso
  raw backup write eats ~100ms cross-region RTT per poll. Acceptable (best-effort, being
  decommissioned); gone at Phase B.

## Cross-cutting prerequisites

- **Feature-flag seam** `lib/db/routing.ts`: env booleans `CONFIG_READS_FROM_PG`,
  `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`, `CONFIG_WRITES_TO_PG`, all default false. Each port is
  additive (PG branch behind a default-off flag); cutover = flip env var; revert = flip back.
- **PG migrations** via `drizzle-kit generate`/`migrate` + `db:pg:generate`/`db:pg:migrate`; baseline
  migration matching live schema; CLAUDE.md-style checklist applied to PG.
- **PITR backups:** set a long-retention custom backup **schedule** + **prevent-deletion** once in the
  PlanetScale dashboard (no documented CLI/API for the schedule itself); optionally add a scripted
  periodic `pscale backup create` (CLI) for belt-and-braces. Confirm `pscale backup create --help`
  retention flag.
- **Dev guardrails (C):** distinct `PLANETSCALE_DATABASE_URL` per env; a startup assert that **throws
  if dev resolves to the prod branch/host**; `receive-dev` writes to the dev branch; PITR as backstop.
- **share_tokens PG schema:** bigint epoch-ms columns + text PK (keeps `share-tokens.ts:591`
  `gt(expiresAtMs, nowMs)` unchanged); on write-port detect PG unique-violation `23505` (not
  `SQLITE_CONSTRAINT`, `:564`).
- **Seed hardening:** `users`/`user_systems` → `onConflictDoUpdate`; seed `polling_status` +
  `share_tokens`; keep `setval` for the serial config tables (systems/user_systems) — sessions no
  longer serial (text id); fix `createdAtMs=0`→1970 (`seed:197`); make count-shortfall a hard abort.
- **polling_status to PG:** atomic `total_polls = total_polls + 1` upsert; **log-but-don't-throw** on
  PG failure (else `shouldPoll` re-polls → duplicate sessions).
- **Aggregation port covers BOTH 5m writers:** `updatePointAggregates5m`
  (`lib/point-aggregation-helper.ts`, no valueStr/dataQuality) AND direct `insertPointReadingsAgg5m`
  (`point-manager.ts:779-798`, valueStr/dataQuality + energy counter/delta). PG 5m = idempotent
  recompute keyed `(systemId, intervalEnd)` over landed PG raw, `onConflictDoUpdate`, handling
  transform='d' previous-interval lookup. _Confirm how raw-vendor 5m currently reaches PG._
- **Queue quiesce before any trim:** stop publishing a type, drain to lag=0 on `/admin/observations`
  while the OLD receiver still handles all types, then deploy the trimmed receiver; keep removed
  branches as logging no-ops one release.
- **Value-level reconciler:** diff avg/min/max/last/delta per system/point/interval within a tolerance
  — gates the aggregation trim (the count-only `--verify` cannot prove value equality).

## Session-id (UUIDv7 / cast-to-text) + session-FK workstream — ordering

The app emitting UUIDv7 text ids requires **both** DB columns to be `text` first (the same inline
code writes Turso + publishes to PG). Sequence:

1. **PG columns → text** (`sessions.id`, `point_readings.session_id`, `agg_5m.session_id`): cast
   existing via add-column → batched backfill → atomic swap (avoid the 13M-row `ACCESS EXCLUSIVE`
   lock); Drizzle schema updated to text.
2. **Turso columns → text** + **drop readings FKs (B)** in one **0016-grade** table rebuild.
3. **App change:** `createSession` generates UUIDv7; code-wide `number → string` type change
   (Drizzle, `types.ts` `QueueMessage`, `createSession` return, receiver, publisher, all call sites —
   TypeScript + grep audit; verify no numeric use/sort of session id). **Restructure publishing to
   emit one combined message (completed session + all its readings) at session close** across all
   four poll entry points (base-adapter, enphase adapter, fusher push, amber-sync): the insert
   methods buffer into a poll-scoped collector instead of publishing inline; the orchestrator flushes
   at session close (success and failure). Receiver inserts **session-before-readings in one
   transaction**. Chunk readings across messages sharing the session id if a poll exceeds QStash's
   1 MB (10 MB Fixed-1M) limit.
4. **Add FK** `point_readings.session_id → sessions.id` (`NOT VALID` → `VALIDATE`) + **drop the
   secondary unique**, after an orphan check.
   Snapshot Turso + ensure PG PITR before steps 1–2.

## Region migration (D) — parallel ops track

Provision PlanetScale Postgres in **Sydney (ap-southeast-2)** (data migrate via backup/branch
restore), set Vercel region to **`syd1`** (`vercel.json` `regions`), re-point env vars. Turso stays in
Tokyo. Mostly cloud-ops + a one-line `vercel.json` change; coordinate with the read/write cutover so
data and compute stay co-located. Can run in parallel with Stage 1.

## Execution plan (PRs)

### Stage 1 — additive groundwork (no behaviour change, no cutover) — implement now

- **PR-0** `lib/db/routing.ts` flag seam (all default false). _risk:none_
- **PR-1** Fix PG pool memoization + `isPlanetscaleConfigured` reuse. _risk:low_
- **PR-2** PG migration tooling (`generate`/`migrate`, `db:pg:*`, forbid `push`) + configure PITR
  backups. _risk:none_
- **PR-3** Add `share_tokens` PG table (bigint-ms, text PK) + extend seed (unused table). _risk:low_
- **PR-4** Seed hardening (config upserts, polling_status/share_tokens, setval for serial config
  tables, createdAtMs fix, hard-abort). _risk:low_
- **PR-5** Value-level aggregate reconciliation tool (read-only). _risk:none_
- **PR-6** Dev shared-branch wiring + prod-URL guardrail + read-site inventory. _risk:low_

### Stage 2 — gated cutovers (each gated on explicit go-ahead; revert by flag flip / PITR)

- **PR-7** Session-id migration (the workstream above: PG+Turso columns→text, app UUIDv7,
  co-enqueue + transactional receiver, FK, drop unique). _cutover — table rewrites + maintenance window_
- **PR-8** Config READS behind `CONFIG_READS_FROM_PG` + shadow-diff (default off): SystemsManager
  systems⋈polling_status join, PointManager cache, `userHasSystemAccess`.
- **PR-9** Config WRITES behind `CONFIG_WRITES_TO_PG` (PG-only): createSystem, ensurePointInfo/
  createPoint/updatePoint, user-prefs, user_systems grants, share-tokens (+`23505`), polling-utils
  (atomic increment, log-not-throw). Depends on the Turso readings FK-drop (in PR-7's rebuild).
- **PR-10** CUTOVER config authority: pre-cutover Turso snapshot + confirm PG PITR; pause cron; seed +
  hard-validate counts PG≥Turso; flip `CONFIG_READS_FROM_PG` + `CONFIG_WRITES_TO_PG`; re-enable cron.
- **PR-11** PG raw-vendor 5m + 1d aggregation in SHADOW behind `AGG_COMPUTE_IN_PG` (idempotent
  recompute, both 5m writers, transform='d'; 5m-native stay queue-fed); verified via PR-5.
- **PR-12** Readings READS to PG endpoint-by-endpoint behind `READINGS_READS_FROM_PG` (PG provider
  mirroring `lib/history/point-readings-provider.ts` with ms↔timestamp; "latest" stays on KV).
- **PR-13** CUTOVER: quiesce queue, then trim only the **raw-vendor** Turso 5m + 1d publishers and the
  receiver's raw-vendor 5m/1d inserts. **Keep** raw, sessions, and 5m-native 5m on the queue.
- **Region move (D):** parallel ops track, coordinated with PR-10/PR-12.

### Phase B — Turso decommission (future, separate planning)

With session-id minting already off Turso (E), Phase B reduces to **raw durability off Turso**: raw
must reach PG without the inline Turso write as the synchronous safety net — either synchronous PG raw
write or accept queue-only (at-least-once) durability. Re-opens the synchronous-PG-write question.

## What I'll implement now (pending approval)

**Step 0 — Turso checkpoint (safety baseline):** create a copy-on-write snapshot before any work —
`~/.turso/turso db create liveone-snapshot-<timestamp> --from-db liveone-tokyo --location
aws-ap-northeast-1 --wait`, then verify it has data. (Turso's "branch/checkpoint" = an instant
copy-on-write DB clone; this is the `CLAUDE.md` mechanism.)

**Then Stage 1 (PR-0…PR-6) only.** Additive, behaviour-preserving (flags default off), individually
revertible; nothing flips production. Implemented via a multi-agent workflow; each PR gated on
`npm run build:local && npm run typecheck` + relevant Jest tests before it's considered done. Stage 2
cutovers (incl. the session-id migration), the region move, and Phase B are each brought to you
separately for go-ahead.

## Verification

- Per PR: `npm run build:local && npm run typecheck`; targeted `npm test`; PR-3/4 confirm PG counts ==
  Turso after `seed --apply`; PR-1 observe one pool per warm instance; PR-5 baseline value parity.
- Independent near-term: after the next daily cron, `--verify --table=agg_1d` clean; dashboard lag ~0.

## Rollback

- Stage 1: every PR additive/no-op → revert the PR.
- Stage 2: flip the relevant env flag back (instant, no deploy). Config has no Turso dual-write soak
  (decision B), so config rollback relies on **PG PITR** + the pre-cutover Turso snapshot; flipping
  `CONFIG_READS_FROM_PG` back reads stale Turso config (rare-changing data — acceptable).
- Always take a Turso snapshot (`turso db create --from-db liveone-tokyo …`) and confirm PG PITR
  retention before each CUTOVER PR (PR-7, PR-10, PR-13). The old "pause the queue, Turso untouched"
  rollback is valid only before PR-10.
