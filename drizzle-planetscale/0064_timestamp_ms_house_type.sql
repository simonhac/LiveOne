-- The house timestamp becomes `timestamp(3)`.
--
-- WHY: a bare `timestamp` is `timestamp(6)`, so a `DEFAULT now()` writes a value with microseconds —
-- which no JS `Date` can represent. drizzle parses it with `new Date(…)` (TRUNCATING to ms) and
-- writes it back as `toISOString()`, so any `where(eq(col, rowFromTheDb.col))` compares
-- `…43.616884` against `…43.616` and matches NOTHING, silently. That is exactly how two
-- generator-exercise automations never fired (#468, `claimExerciseDispatch`). At precision 3
-- Postgres rounds the default at write time and the round trip is lossless by construction.
--
-- SCOPE: every timestamp column except nine, named in `lib/db/planetscale/__tests__/schema-shape.test.ts`,
-- which fails on a tenth. Narrowing is a full table rewrite under ACCESS EXCLUSIVE, and 🛑 drizzle runs
-- a whole migration file in ONE transaction (`PgDialect.migrate`) — so the slowest rewrite holds not
-- only its own lock but every lock taken before it, until the last statement commits. The nine live on
-- the four tables the ingest path writes every minute and where that bill is real: `point_readings`
-- (15.4M rows / 2.5 GB), `point_readings_agg_5m` (7.6M / 1.7 GB), `sessions` (1.3M / 1.4 GB) and
-- `observations_outbox` (601 MB on PROD — 22x the dev mirror, which is why this was worth measuring).
-- None of the nine is compared for EQUALITY against a JS round trip, which is the property that
-- matters; see the test for the full argument.
--
-- COST, measured rather than guessed: a rewrite runs at ~28 MB/s on this infrastructure (dev,
-- `amber_forecast_history`, 103 MB in 3.72 s). The largest table here is `amber_forecast_history` at
-- 120 MB on prod and everything else totals ~16 MB, so expect **~5 s** of ACCESS EXCLUSIVE across all
-- 18 tables — including `points`, `devices`, `areas` and `device_state`, which the minutely collector
-- reads. Narrowing `observations_outbox` would have added ~21 s to that, on every table at once.
-- Widening is nearly free (62 ms for the same table), so this is cheap to reverse.
--
-- SAFETY: narrowing ROUNDS, so a PK containing a narrowed timestamp could in principle collide.
-- Verified against prod before applying: `amber_forecast_history (device_rid, interval_end, channel,
-- observed_at)` and `derived_intervals (derivation_id, start_time)` hold ZERO sub-millisecond values,
-- so the rounding is a no-op there. `lock_timeout` below means a blocked ALTER aborts the whole
-- transaction rather than queueing and blocking every reader behind it; if it fires, just re-run.
--
-- Also adds `automations.revision` — the integer optimistic-concurrency token that replaces the
-- `updated_at` compare-and-set. NOT NULL DEFAULT 1 is a catalogue-only change on PG 11+ (no rewrite).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "amber_forecast_history"
  ALTER COLUMN "interval_end" SET DATA TYPE timestamp(3),
  ALTER COLUMN "observed_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "area_bindings"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "areas"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "automations"
  ALTER COLUMN "armed_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "last_triggered_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "last_triggered_run_start" SET DATA TYPE timestamp(3),
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "battery_provenance_daily"
  ALTER COLUMN "first_interval_end" SET DATA TYPE timestamp(3),
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "dashboard_grants"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "dashboard_revisions"
  ALTER COLUMN "saved_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "dashboards"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "derivations"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "derived_intervals"
  ALTER COLUMN "start_time" SET DATA TYPE timestamp(3),
  ALTER COLUMN "end_time" SET DATA TYPE timestamp(3),
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "device_state"
  ALTER COLUMN "last_poll_time" SET DATA TYPE timestamp(3),
  ALTER COLUMN "last_success_time" SET DATA TYPE timestamp(3),
  ALTER COLUMN "last_error_time" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "devices"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "point_commands"
  ALTER COLUMN "requested_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "completed_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "point_readings_agg_1d"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "point_readings_flow_attr_1d"
  ALTER COLUMN "finalized_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "points"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "share_tokens"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "expires_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "revoked_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "last_used_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "created_at" SET DATA TYPE timestamp(3),
  ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
