-- Per-run provenance, accumulated by the recompute alongside energy_kwh (never derived at render
-- time). NULL means UNKNOWN, never zero — the reader omits the column entirely rather than showing
-- $0.00. Expand-only, so it is safe to apply BEFORE the code that reads it ships (and it must be:
-- PG migrations here are manual, and drizzle's bare .select() enumerates every schema column, so
-- deploying first would 500 the run-periods route and getOpenRun).
-- IF NOT EXISTS so a re-run after a partial apply is a no-op (cf. 0027).
ALTER TABLE "derived_intervals" ADD COLUMN IF NOT EXISTS "cost_c" double precision;--> statement-breakpoint
ALTER TABLE "derived_intervals" ADD COLUMN IF NOT EXISTS "emissions_g" double precision;--> statement-breakpoint
ALTER TABLE "derived_intervals" ADD COLUMN IF NOT EXISTS "renewable_kwh" double precision;
