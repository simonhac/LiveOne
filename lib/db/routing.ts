/**
 * Database routing flags (Postgres-primary).
 *
 * Historically this was the env-driven seam for the staged Turso → Postgres
 * cutover. Phase 5 decommissioned Turso: config, readings, aggregation, and raw
 * durability are now unconditionally on Postgres, so the migration flags
 * (`CONFIG_*`, `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`, `WRITE_OUTBOX`)
 * have been retired and their Turso branches deleted.
 *
 * The only remaining flags gate the energy-flow-matrix feature, which is a
 * separate, not-yet-enabled rollout. Flags are read once at module load.
 */

/**
 * Parse an environment variable as a boolean. Only the exact string "true"
 * (case-insensitive, trimmed) is truthy; everything else — including unset,
 * "1", "yes" — is false. This keeps rollout flags explicit and unambiguous.
 */
function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/**
 * Materialize the per-day directional energy-flow matrix in Postgres
 * (`point_readings_flow_1d`). When on, the daily cron recomputes each system/day's matrix
 * from PG `agg_5m` alongside the 1d recompute. Shadow-only: it just writes the table; serving
 * is gated separately by `FLOW_MATRIX_SERVE_FROM_PG`. See docs/architecture/ENERGY-FLOW-MATRIX.md.
 */
export const FLOW_MATRIX_COMPUTE_IN_PG = envFlag("FLOW_MATRIX_COMPUTE_IN_PG");

/**
 * Serve the dashboard's long-range (30-day / month / arbitrary) Sankey from the materialized
 * `point_readings_flow_1d` (summed completed days + the live partial day) instead of computing
 * client-side from daily-averaged data. Off → the dashboard behaves exactly as before.
 */
export const FLOW_MATRIX_SERVE_FROM_PG = envFlag("FLOW_MATRIX_SERVE_FROM_PG");

/**
 * All routing flags as a snapshot, for logging / admin diagnostics.
 */
export function dbRoutingFlags(): Record<string, boolean> {
  return {
    FLOW_MATRIX_COMPUTE_IN_PG,
    FLOW_MATRIX_SERVE_FROM_PG,
  };
}
