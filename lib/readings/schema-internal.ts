/**
 * The ONLY re-export of the hot time-series table symbols.
 *
 * Config-v4 seam (docs/plans/config-v4-execution-plan.md §3): everything that issues SQL against
 * `point_readings` / `point_readings_agg_5m` / `point_readings_agg_1d` imports the Drizzle symbols
 * FROM HERE, never from the `@/lib/db/planetscale/schema` barrel. The lint ratchet
 * (`.eslintrc.json` no-restricted-imports + scripts/check-readings-boundary.mjs) bans the raw symbols
 * everywhere except `lib/readings/**` + `lib/registry/**`, so at the Phase-8 cutover the
 * `(system_id, point_id) → point_rid` re-key touches only this directory.
 *
 * Deliberately re-exports ONLY the three hot tables (+ their inferred row types) — not `point_info`,
 * `sessions`, `systems`, or the flow/provenance tables, which stay broadly importable. This file is
 * NOT re-exported from `lib/db/planetscale/index.ts`, so the schema barrel keeps exposing the raw
 * symbols for the drizzle-kit schema/migration tooling while application imports of them are blocked.
 *
 * Post-cutover this file also surfaces the `point_rid` columns; pre-cutover they don't exist on the
 * hot tables yet, so nothing references them.
 */
export {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
  type PointReading,
  type NewPointReading,
  type PointReadingAgg5m,
  type NewPointReadingAgg5m,
  type PointReadingAgg1d,
  type NewPointReadingAgg1d,
} from "@/lib/db/planetscale/schema";
