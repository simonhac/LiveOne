-- 0055 config-v4 Phase 14 stage 21 — a run statistic stops pretending to be Watts.
--
-- `derived_intervals.{max,min,avg}_power_w` → `{max,min,avg}_signal`, plus a new `signal_unit text`
-- carrying the unit of the series each row's statistics were computed over. Then the invariant that
-- makes the rename worth anything: `derived_intervals_signal_unit_check` — a statistic is never
-- stored without its unit.
--
-- ## Why this exists
--
-- `detectRunPeriods` computes max/min/avg of THE SIGNAL SERIES THE DETECTOR FOLLOWS, whatever that
-- series measures (`lib/db/planetscale/derived-intervals-pg.ts`). The `_w` suffix was never a fact
-- about the data — only about the FIRST detector's signal happening to be Selectronic grid power.
-- Daylesford's re-point to DSE Engine Speed made the same three columns hold rpm, and because the
-- unit was unrecoverable, `app/api/device/[systemId]/run-periods/route.ts` had to gate on
-- `detector_version` and SUPPRESS the statistic for every older row. This migration is what retires
-- that gate: the unit becomes a property of the ROW, so nothing has to be inferred.
--
-- The sibling provenance columns (`cost_c`, `emissions_g`, `renewable_kwh`) were named for their
-- units precisely to avoid repeating this mistake. These three now join that convention.
--
-- ## RENAME, not add-copy-drop — and what that does and does not buy
--
-- `ALTER TABLE … RENAME COLUMN` is catalog-only: no table rewrite, no data movement, and the values
-- cannot be lost because they are never copied. It also takes an entire hazard class out of scope —
-- stage 16 (0054) established that `DROP COLUMN` silently takes every index over the column WITHOUT
-- a `CASCADE`, that an expression index stores `0` in `indkey` so `indkey`-based gates cannot see it,
-- and that an index's dependency on a column is `deptype = 'a'` so the obvious `pg_depend` filter
-- discards it. **None of that applies to a rename** (Postgres rewrites dependents in place).
-- G2 below still sweeps `pg_depend` UNFILTERED — it is free, and a surviving index whose NAME embeds
-- `power_w` would now be a lie even though it still works.
--
-- 🛑 **What the absence of a DROP does NOT buy is a softer gate, and it does not soften the
-- ordering.** To the running build, a rename IS a drop of the old names. See below.
--
-- ## 🛑 ORDERING: hard-coupled. There is no order with no window. Ruled: DEPLOY FIRST, THEN APPLY.
--
--   * **Deploy this PR, then apply** → the new build names `max_signal`; it does not exist yet ⇒ 42703.
--   * **Apply, then deploy** → the old build names `max_power_w`; it no longer exists ⇒ 42703.
--
-- **The blast radius is wider than a read route, and this was measured rather than assumed.** It is:
--
--   1. `GET /api/device/{id}/run-periods` (the generator-runs card + `/device/14`) — a read, 500s.
--   2. **A WRITE PATH**: `recomputeIntervalsForWindow` INSERTs these columns by name
--      (`derived-intervals-pg.ts:190-197`), driven by `/api/cron/derivations`, which `vercel.json`
--      schedules `* * * * *` — **every minute**.
--   3. `getOpenRun` (`lib/run-tracking/live.ts:17`) uses a projection-less `.select()`, which expands
--      to the schema's declared columns, so the live "running" lookup 42703s too.
--
-- ✅ **The window is nevertheless safe, and this is the load-bearing argument:**
--
--   * **The writer fails CLOSED and ATOMICALLY.** `db.transaction` opens at
--     `derived-intervals-pg.ts:85`; the bounded DELETE (`:167`) and the INSERT (`:195`) are BOTH
--     inside it. A 42703 on the insert aborts the transaction, so **the delete rolls back with it**.
--     Nothing is deleted, nothing half-written, nothing orphaned. Had the delete been able to commit
--     independently, this ordering would NOT have been acceptable and an expand/contract would have
--     been required.
--   * **It self-heals completely.** The minutely pass is `reconcileTrailingWindow` over
--     `DEFAULT_TRAILING_MS = 6h`, and each pass is a FULL bounded rebuild of that window from
--     `point_readings` — the authority. The first successful pass after the apply reconstructs
--     everything. A window of minutes loses nothing permanently.
--   * **KV goes stale, not wrong.** `publishRunningLatest` throws at `isRunningNow` BEFORE
--     `updateLatestPointValue`, so the "running" latest keeps its last value rather than being
--     overwritten with a bad one.
--   * **Ingest is untouched.** Grepped `app/api/observations/` and `lib/readings/` for
--     `derivedIntervals`: zero hits. The "reads only the serving store, writes only
--     `derived_intervals`" decoupling invariant holds, so the receiver/materialisation path cannot
--     see this at all.
--
-- ⚠️ **Observability defect fixed in this PR, because the ruling depends on the outage being
-- visible.** `recomputeWindowAllTrackers` catches per-detector failures and only `console.error`s
-- them, so the cron returned `success: true` with `rowsInserted: 0` — green while deriving nothing.
-- `RecomputeSummary.trackersFailed` now carries the count into the cron's JSON response, and the
-- reconcile log line goes to `console.error` when it is non-zero. That defect long predates this
-- stage and outlives the window. (`success` itself is deliberately NOT flipped: that would change the
-- cron's HTTP contract, which is a separate decision from making the failure countable.)
--
-- Order:
--   1. MERGE and let Vercel deploy. Confirm `Ready` + aliased and `/api/health?migrations=1`
--      reporting `expected: 56` — the journal length in the RUNNING build, i.e. a precise deploy probe.
--   2. Apply to prod `sydney`. Post-check the CATALOG (below), never the migrator's exit line.
--   3. Apply to `liveone-dev` immediately after, and re-post-check.
--
-- ⚠️ `liveone-dev` IS SHARED. Between the two applies, other live worktrees/previews still run the
-- OLD build against dev and will 42703 on the run-periods route and the derivations cron. Keep the
-- prod→dev gap to minutes. `derived_intervals` is NOT in the prod→dev sync manifest (it is recomputed
-- on dev by `db:recompute-dev-runs`, see `lib/readings/prod-dev-sync.ts:72`), so unlike 0054 this
-- migration canNOT trip `assertManifestSchemaParity` — the sync is indifferent to it.
--
-- 🛑 A MISSING MIGRATION FILE LOOKS IDENTICAL TO A SUCCESSFUL APPLY. `db:pg:migrate` from a tree
-- lacking this file prints "migrations applied successfully" and does nothing. Only the CATALOG
-- distinguishes them:
--
--      SELECT attname FROM pg_attribute
--       WHERE attrelid = 'public.derived_intervals'::regclass AND NOT attisdropped AND attnum > 0
--         AND attname IN ('max_power_w','max_signal','signal_unit');
--
-- Must return exactly `max_signal` and `signal_unit` afterwards. Related: `db:pg:migrate` swallows
-- `RAISE NOTICE`, so the inventory below is invisible in its output — capture it BY HAND before
-- applying or the record is lost. Every GATE is a `RAISE EXCEPTION`, which is not swallowed.
--
-- ## Measured precondition (this is what determined the backfill, and it is NOT symmetric)
--
--      detector_version | rows | first      | last       | avg_power_w range
--      -----------------+------+------------+------------+---------------------------
--      prod  1          |   74 | 2025-09-03 | 2026-07-03 | −3807.5 … −93.0   ⇒ Watts
--      prod  2          |    3 | 2026-07-22 | 2026-07-27 |  1475.8 …  1499.9 ⇒ rpm
--      dev   2          |    3 | 2026-07-22 | 2026-07-27 |  1475.8 …  1499.9 ⇒ rpm
--
-- 🛑 **`liveone-dev` HAS NO VERSION-1 ROWS AT ALL.** Prod is the only place they exist, so a green
-- dev apply demonstrates leg A and NOTHING about leg B — G3b/G3c and the leg-B UPDATE all pass
-- VACUOUSLY there. They were proven instead against synthetic version-1 rows in a ROLLED-BACK
-- transaction on dev; see the PR body. Do not read a clean dev run as coverage of the 74 prod rows.
--
-- 🛑 **ONE derivation (`947afbcc-…`) owns ALL 77 rows and its CURRENT `detector_version` is 2 —
-- while 74 of its rows are version 1.** So the unit is a property of the ROW, via its
-- `detector_version`, and NOT of the derivation. That is exactly why the route's equality gate
-- existed, and it is what makes the two-leg backfill below necessary rather than fussy.
--
-- ## The unit mapping, and the evidence for it (verified, not taken on trust)
--
-- **version 2 ⇒ `rpm` — verified DIRECTLY against `derivations.source_points`.** The live row reads
-- `source_points.signal = e149f15f-…` → `points`: name "Engine Speed", `metric_type = 'speed'`,
-- `unit = 'rpm'`, `physical_path = 'engine_rpm'`, on the `deepsea` device `rid = 14`. Leg A does not
-- hardcode this: it READS it, which is why it stays correct after any future re-point.
--
-- **version 1 ⇒ `W` — three independent lines of evidence.** `source_points` was overwritten by the
-- re-point, so the historical binding cannot be read back; it is reconstructed:
--
--   1. **The seed script.** `scripts/seed-generator-tracker.ts` (commit bccb5a8d) resolved the signal
--      as `findPoint(db, systemId, "power", "Grid")` and documented "signal = its grid power point
--      (display_name 'Grid')". On device `rid = 1` (selectronic) that is `bb2008b2-…`, whose
--      `points.unit` is **`W`** — as it is for all six power points on that device.
--   2. **The threshold.** That same seed set `lowerW = -50`, commented "on when importing > 50W". A
--      NEGATIVE threshold is meaningful only for a signed Watt series; an engine-speed series could
--      never trip it.
--   3. **The data.** Prod's 74 version-1 `avg_power_w` values are STRICTLY NEGATIVE (−3807.5 … −93.0).
--      rpm is non-negative by construction. **G3c asserts exactly this on the target database**, so
--      the `W` assignment verifies itself at apply time instead of resting on this comment.
--
-- G3c gates `avg` only, because `avg` is the range that was measured. `min`/`max` are reported as a
-- NOTICE rather than gated — gate what you measured.
--
-- ## The backfill is two legs, and the first one is the retired gate turned inside out
--
--   * **Leg A — rows AT their derivation's current `detector_version` take the unit from the LIVE
--     signal point.** This is precisely the claim the route's equality gate encoded ("same version ⇒
--     the current signal's unit is provable"), used here to WRITE the fact down once instead of
--     re-deciding it on every request. General: no uuid, no unit literal, correct for any future
--     detector.
--   * **Leg B — older rows need a RECORDED historical mapping**, because their binding is gone. The
--     only one that exists anywhere is `(947afbcc-…, version 1) ⇒ 'W'`. G3b refuses to proceed if any
--     OTHER (derivation, version) pair is left unfilled, so an unknown history aborts rather than
--     being silently mislabelled. The uuid is safe to hardcode because `derivations.id` is a
--     deterministic UUIDv5 over `(area, kind, role)` (`lib/derivations/ids.ts`) and therefore means
--     the same row in both environments — and if it ever did not, G3b is what would fire.
--
-- Preconditions read the CATALOG and the live rows, never the drizzle journal: the journal records
-- INTENT, the catalog records what is true of THIS branch. Everything is in `DO` blocks with
-- `RAISE EXCEPTION`, inside the migrator's transaction, so any failed assertion rolls the whole
-- migration back. Not idempotent, deliberately: G0 turns a second run into an explicit failure
-- rather than a confusing no-op.

-- ── G0/G1/G2. Catalog, non-vacuity, and dependents — before anything is touched. ─────────────
DO $$
DECLARE
  n_old        int;
  n_new        int;
  n_rows       bigint;
  n_deps       bigint;
  deps_desc    text;
BEGIN
  -- G0. The state this migration was written against, and the double-apply guard.
  SELECT count(*) INTO n_old
  FROM pg_attribute
  WHERE attrelid = 'public.derived_intervals'::regclass AND NOT attisdropped
    AND attname IN ('max_power_w', 'min_power_w', 'avg_power_w');

  SELECT count(*) INTO n_new
  FROM pg_attribute
  WHERE attrelid = 'public.derived_intervals'::regclass AND NOT attisdropped
    AND attname IN ('max_signal', 'min_signal', 'avg_signal', 'signal_unit');

  IF n_new > 0 THEN
    RAISE EXCEPTION '0055: % of the 4 target column(s) already exist on derived_intervals — this migration is ALREADY APPLIED (or partly so) on this branch; reconcile by hand rather than recording a no-op as applied', n_new;
  END IF;
  IF n_old <> 3 THEN
    RAISE EXCEPTION '0055: expected exactly 3 of max_power_w/min_power_w/avg_power_w on derived_intervals, found % — this is not the shape this migration was written against', n_old;
  END IF;

  -- G1. Not an empty table. A vacuous pass is the danger, not the empty table: every content gate
  -- below would succeed over zero rows and prove nothing. Measured: prod 77, dev 3.
  SELECT count(*) INTO n_rows FROM derived_intervals;
  IF n_rows = 0 THEN
    RAISE EXCEPTION '0055: derived_intervals is EMPTY — every unit gate below would pass VACUOUSLY, so this would rename three columns and assert nothing at all; refusing. If a genuinely fresh environment ever needs this, run the gate predicates by hand and remove G1 consciously';
  END IF;

  -- G2. ZERO catalog dependents on the three columns — ANY deptype, UNFILTERED.
  -- Unlike 0054 a dependent here is not destroyed (a rename rewrites dependents in place), so this
  -- is the cheap-but-not-vacuous kind of gate: an index or constraint over these columns would
  -- survive the rename still NAMED for `power_w`, i.e. correct but lying. Measured zero.
  -- `deptype` is `"char"` and `text || "char"` is ambiguous — cast it explicitly.
  SELECT count(*), string_agg(pg_describe_object(d.classid, d.objid, d.objsubid) || ' [' || d.deptype::text || ']', '; ')
  INTO n_deps, deps_desc
  FROM pg_depend d
  JOIN pg_attribute a
    ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refobjid = 'public.derived_intervals'::regclass
    AND a.attname IN ('max_power_w', 'min_power_w', 'avg_power_w');

  IF n_deps <> 0 THEN
    RAISE EXCEPTION '0055: % catalog dependent(s) on the *_power_w columns — %. A RENAME keeps them working but leaves them named for a unit that is no longer implied. Rename them alongside, or remove this gate consciously',
      n_deps, deps_desc;
  END IF;

  RAISE NOTICE '0055 pre-check OK: % row(s), 3 columns to rename, 0 dependents', n_rows;
END $$;
--> statement-breakpoint

-- Carry the pre-rename facts across the DDL so the post-state can be asserted against MEASURED
-- values rather than re-derived ones. `ON COMMIT DROP` keeps it from surviving into a pooled session.
-- (The rule this serves: re-assert an equivalence inside the migration that destroys your ability to
-- check it. After the rename there is no second address left for these values to disagree with.)
--
-- ⚠️ `sum(avg_power_w::numeric)`, NOT `sum(avg_power_w)`. Summing `double precision` is
-- ORDER-DEPENDENT, and Postgres does not promise the same scan order for two separate aggregates, so
-- an exact float-sum comparison drifts by an ULP and aborts a perfectly correct migration. This was
-- not theoretical: the negative control for G6 produced `-116209.22771197847` vs
-- `-116209.22771197848` over 77 rows on liveone-dev. Casting each value to `numeric` first makes the
-- sum exact and order-independent, while still catching a mis-targeted rename.
CREATE TEMP TABLE _m0055_pre ON COMMIT DROP AS
SELECT count(*)                             AS n_rows,
       count(max_power_w)                   AS n_max,
       count(min_power_w)                   AS n_min,
       count(avg_power_w)                   AS n_avg,
       COALESCE(sum(avg_power_w::numeric), 0) AS sum_avg
FROM derived_intervals;--> statement-breakpoint

-- ── G3. THE UNIT ORACLE. Everything the two backfill legs are about to claim, verified on THIS
--    database, BEFORE a single column is touched. ────────────────────────────────────────────────
DO $$
DECLARE
  n_current       bigint;
  n_current_unres bigint;
  n_legacy        bigint;
  n_legacy_other  bigint;
  legacy_desc     text;
  n_nonneg        bigint;
  avg_lo          double precision;
  avg_hi          double precision;
  min_lo          double precision;
  max_hi          double precision;
  cur_units       text;
  -- The ONE recorded historical binding: Daylesford's generator detector before the DSE re-point.
  -- Deterministic UUIDv5 (lib/derivations/ids.ts), so it means the same row on prod and dev.
  legacy_deriv CONSTANT uuid := '947afbcc-ffde-5151-8de0-eba49355c243';
  legacy_ver   CONSTANT int  := 1;
BEGIN
  -- G3a. Leg A must be TOTAL over the rows it claims: every row at its derivation's current version
  -- must reach a live signal point with a unit. `points.unit` is NOT NULL, so the only way to fail
  -- is an unresolvable `source_points.signal` — a broken binding, which must not become a NULL unit.
  SELECT count(*) INTO n_current
  FROM derived_intervals di
  JOIN derivations d ON d.id = di.derivation_id
  WHERE di.detector_version = d.detector_version;

  SELECT count(*) INTO n_current_unres
  FROM derived_intervals di
  JOIN derivations d ON d.id = di.derivation_id
  LEFT JOIN points p ON p.id = (d.source_points ->> 'signal')::uuid
  WHERE di.detector_version = d.detector_version
    AND p.unit IS NULL;

  IF n_current_unres <> 0 THEN
    RAISE EXCEPTION '0055: % row(s) at their derivation''s CURRENT detector_version cannot reach a signal point with a unit (source_points.signal is missing, or names no points row) — leg A would leave them unlabelled. Fix the binding first',
      n_current_unres;
  END IF;

  SELECT string_agg(DISTINCT p.unit, ', ') INTO cur_units
  FROM derived_intervals di
  JOIN derivations d ON d.id = di.derivation_id
  JOIN points p ON p.id = (d.source_points ->> 'signal')::uuid
  WHERE di.detector_version = d.detector_version;

  -- G3b. Leg B covers ONLY the one historical mapping anybody recorded. Any other older
  -- (derivation, version) pair is a history whose unit is genuinely unknown — abort, do not guess.
  SELECT count(*) INTO n_legacy
  FROM derived_intervals di
  JOIN derivations d ON d.id = di.derivation_id
  WHERE di.detector_version <> d.detector_version;

  SELECT count(*), string_agg(DISTINCT di.derivation_id::text || ' v' || di.detector_version::text, '; ')
  INTO n_legacy_other, legacy_desc
  FROM derived_intervals di
  JOIN derivations d ON d.id = di.derivation_id
  WHERE di.detector_version <> d.detector_version
    AND NOT (di.derivation_id = legacy_deriv AND di.detector_version = legacy_ver);

  IF n_legacy_other <> 0 THEN
    RAISE EXCEPTION '0055: % row(s) were written by a superseded detector version whose signal unit is NOT recorded anywhere — %. Their binding is gone from source_points, so there is nothing to read and nothing to infer. Establish what those rows measured and extend leg B before applying; do NOT let them fall through to a default',
      n_legacy_other, legacy_desc;
  END IF;

  -- G3c. THE SELF-VERIFYING PART. The `W` literal leg B is about to write is justified by the data
  -- itself: the version-1 detector fired on grid IMPORT (lowerW = -50), so every run it recorded is
  -- a negative-Watt excursion. rpm — the only other unit in this table's history — cannot be
  -- negative. A non-negative value here means these rows are NOT what leg B thinks they are.
  SELECT count(*) FILTER (WHERE di.avg_power_w >= 0),
         min(di.avg_power_w), max(di.avg_power_w),
         min(di.min_power_w), max(di.max_power_w)
  INTO n_nonneg, avg_lo, avg_hi, min_lo, max_hi
  FROM derived_intervals di
  WHERE di.derivation_id = legacy_deriv AND di.detector_version = legacy_ver;

  IF n_nonneg <> 0 THEN
    RAISE EXCEPTION '0055: % of the % version-1 row(s) have avg_power_w >= 0 (range % .. %) — they cannot be the negative-Watt grid-import series leg B assigns ''W'' to. The historical unit mapping is WRONG for this database; stop and re-establish it',
      n_nonneg, n_legacy, avg_lo, avg_hi;
  END IF;

  IF n_legacy = 0 THEN
    -- Not an error: liveone-dev is legitimately in this state. But say so loudly, because it means
    -- G3b/G3c above and leg B below just proved NOTHING on this database.
    RAISE NOTICE '0055 ⚠️  NO superseded-version rows on this database — leg B and its gates are VACUOUS here. Expected on liveone-dev (3 rows, all v2); on prod sydney this should be 74 and a 0 means something is very wrong.';
  END IF;

  RAISE NOTICE '0055 oracle: % row(s) at current version -> live unit(s) [%]; % row(s) at version 1 -> ''W'' (avg % .. %, min %, max %, all strictly negative)',
    n_current, cur_units, n_legacy, avg_lo, avg_hi, min_lo, max_hi;
END $$;
--> statement-breakpoint

-- ── The rename. Catalog-only; values are never copied, so they cannot be lost. ────────────────
ALTER TABLE "derived_intervals" RENAME COLUMN "max_power_w" TO "max_signal";--> statement-breakpoint
ALTER TABLE "derived_intervals" RENAME COLUMN "min_power_w" TO "min_signal";--> statement-breakpoint
ALTER TABLE "derived_intervals" RENAME COLUMN "avg_power_w" TO "avg_signal";--> statement-breakpoint
ALTER TABLE "derived_intervals" ADD COLUMN "signal_unit" text;--> statement-breakpoint

-- ── Leg A. Rows at their derivation's CURRENT version take the unit from the LIVE signal point.
--    No uuid, no unit literal — the retired route gate's own claim, written down once. ──────────
UPDATE "derived_intervals" di
   SET "signal_unit" = p."unit"
  FROM "derivations" d
  JOIN "points" p ON p."id" = (d."source_points" ->> 'signal')::uuid
 WHERE di."derivation_id" = d."id"
   AND di."detector_version" = d."detector_version";--> statement-breakpoint

-- ── Leg B. The one recorded historical mapping, for rows whose binding no longer exists.
--    Gated by G3b (nothing else may be unfilled) and G3c (the values must be negative Watts). ───
UPDATE "derived_intervals"
   SET "signal_unit" = 'W'
 WHERE "derivation_id" = '947afbcc-ffde-5151-8de0-eba49355c243'::uuid
   AND "detector_version" = 1
   AND "signal_unit" IS NULL;--> statement-breakpoint

-- ── G4-G7. Post-state, asserted rather than assumed — same transaction, so a failure rolls the
--    whole migration back. ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  pre        _m0055_pre%ROWTYPE;
  n_rows     bigint;
  n_unlabelled bigint;
  n_null_unit  bigint;
  n_max      bigint;
  n_min      bigint;
  n_avg      bigint;
  sum_avg    numeric;
  units_desc text;
BEGIN
  SELECT * INTO pre FROM _m0055_pre;

  -- G5. Not one row gained or lost. A rename cannot lose rows; assert it anyway — this is the last
  -- moment the claim is checkable.
  SELECT count(*) INTO n_rows FROM derived_intervals;
  IF n_rows <> pre.n_rows THEN
    RAISE EXCEPTION '0055: derived_intervals has % row(s) after the rename+backfill, expected % — rows were lost or created', n_rows, pre.n_rows;
  END IF;

  -- G6. The VALUES survived the rename intact: same non-null population, same sum. The sum is what
  -- catches a mis-targeted rename (e.g. min and max swapped), which a count alone would not.
  SELECT count(max_signal), count(min_signal), count(avg_signal), COALESCE(sum(avg_signal::numeric), 0)
  INTO n_max, n_min, n_avg, sum_avg
  FROM derived_intervals;

  IF n_max <> pre.n_max OR n_min <> pre.n_min OR n_avg <> pre.n_avg THEN
    RAISE EXCEPTION '0055: non-null statistic counts changed across the rename — max %/%, min %/%, avg %/% (after/before)',
      n_max, pre.n_max, n_min, pre.n_min, n_avg, pre.n_avg;
  END IF;
  IF sum_avg IS DISTINCT FROM pre.sum_avg THEN
    RAISE EXCEPTION '0055: sum(avg_signal) is % but sum(avg_power_w) was % — the rename did not land on the column it was supposed to', sum_avg, pre.sum_avg;
  END IF;

  -- G4. THE INVARIANT THIS MIGRATION EXISTS FOR: no statistic without a unit. Asserted BEFORE the
  -- CHECK is added so a failure names the count instead of surfacing as a bare constraint violation.
  SELECT count(*) INTO n_unlabelled
  FROM derived_intervals
  WHERE signal_unit IS NULL
    AND (max_signal IS NOT NULL OR min_signal IS NOT NULL OR avg_signal IS NOT NULL);

  IF n_unlabelled <> 0 THEN
    RAISE EXCEPTION '0055: % row(s) still carry a statistic with NO signal_unit after both backfill legs — the whole point of this migration is that such a row cannot exist. Neither leg claimed them; G3b should have caught this, so understand why it did not',
      n_unlabelled;
  END IF;

  -- G7. Inventory + the recognised-unit check. An unexpected unit is not fatal (the column is free
  -- text by design — any point's unit is legal) but it must be SEEN, so it is reported, and the
  -- expected shape is asserted: on both environments every row should be 'W' or 'rpm'.
  SELECT count(*) INTO n_null_unit FROM derived_intervals WHERE signal_unit IS NULL;

  SELECT string_agg(u || '=' || c::text, ', ' ORDER BY u) INTO units_desc
  FROM (SELECT COALESCE(signal_unit, '(null)') AS u, count(*) AS c
          FROM derived_intervals GROUP BY 1) x;

  IF EXISTS (SELECT 1 FROM derived_intervals WHERE signal_unit IS NOT NULL AND signal_unit NOT IN ('W', 'rpm')) THEN
    RAISE EXCEPTION '0055: a signal_unit outside the measured set {W, rpm} was written — inventory: %. Not necessarily wrong, but it is not what this migration was written against; confirm it before recording this as applied', units_desc;
  END IF;

  RAISE NOTICE '0055 OK: % row(s) intact; units %; % row(s) with no unit (all statistic-free)',
    n_rows, units_desc, n_null_unit;
END $$;
--> statement-breakpoint

-- ── The invariant, now DB-enforced. This REPLACES the reader's retired `detector_version` equality
--    gate: that gate existed only because a stored number could not say what it measured. ────────
ALTER TABLE "derived_intervals" ADD CONSTRAINT "derived_intervals_signal_unit_check"
  CHECK ("derived_intervals"."signal_unit" IS NOT NULL OR ("derived_intervals"."max_signal" IS NULL AND "derived_intervals"."min_signal" IS NULL AND "derived_intervals"."avg_signal" IS NULL));--> statement-breakpoint

-- ── G8. Final catalog state — an explicit expected column set, not a count. ───────────────────
DO $$
DECLARE
  surviving text[];
  expected  text[] := ARRAY[
    'derivation_id', 'start_time', 'end_time', 'duration_seconds', 'energy_kwh',
    'max_signal', 'min_signal', 'avg_signal', 'signal_unit',
    'cost_c', 'emissions_g', 'renewable_kwh',
    'sample_count', 'detector_version', 'created_at', 'updated_at'
  ];
BEGIN
  SELECT array_agg(attname ORDER BY attname) INTO surviving
  FROM pg_attribute
  WHERE attrelid = 'public.derived_intervals'::regclass AND attnum > 0 AND NOT attisdropped;

  IF NOT (surviving @> expected AND expected @> surviving) THEN
    RAISE EXCEPTION '0055: derived_intervals columns are % — expected exactly %',
      surviving, (SELECT array_agg(e ORDER BY e) FROM unnest(expected) e);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.derived_intervals'::regclass
      AND conname = 'derived_intervals_signal_unit_check' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION '0055: derived_intervals_signal_unit_check was not created — a statistic could still be stored unlabelled';
  END IF;

  -- The partial unique index must have survived untouched: it is over `derivation_id`/`end_time`,
  -- neither of which was renamed, so this is a cheap proof that nothing collateral moved.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'derived_intervals_open_unique' AND relkind = 'i'
  ) THEN
    RAISE EXCEPTION '0055: derived_intervals_open_unique is gone — something collateral was dropped';
  END IF;

  RAISE NOTICE '0055 OK: columns renamed, signal_unit added and enforced, open_unique intact';
END $$;
