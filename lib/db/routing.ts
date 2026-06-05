/**
 * Database routing flags (Postgres-primary migration).
 *
 * Central, env-driven seam for the staged Turso → Postgres cutover. Every flag
 * defaults to `false`, meaning "behave exactly as today" (Turso reads/writes,
 * aggregation in Turso). Each migration step adds a Postgres branch guarded by
 * its flag; flipping the env var is the cutover, and flipping it back is the
 * revert — no code change or redeploy of logic required.
 *
 * Flags are read once at module load. They are environment configuration, not
 * per-request state, so a change requires a new deploy (or a fresh process),
 * which is the intended granularity for a cutover.
 *
 * See the migration plan and `lib/env.ts` for related environment helpers.
 */

/**
 * Parse an environment variable as a boolean. Only the exact string "true"
 * (case-insensitive, trimmed) is truthy; everything else — including unset,
 * "1", "yes" — is false. This keeps cutover flags explicit and unambiguous.
 */
function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/**
 * Serve config-table reads (systems, point_info, users, user_systems,
 * polling_status, share_tokens) from Postgres instead of Turso.
 */
export const CONFIG_READS_FROM_PG = envFlag("CONFIG_READS_FROM_PG");

/**
 * Make Postgres the authoritative target for config-table writes (writes stop
 * going to Turso). Gated separately from reads so the two flip together at the
 * config-authority cutover.
 */
export const CONFIG_WRITES_TO_PG = envFlag("CONFIG_WRITES_TO_PG");

/**
 * Serve readings reads (point_readings / agg_5m / agg_1d serving queries) from
 * Postgres instead of Turso.
 */
export const READINGS_READS_FROM_PG = envFlag("READINGS_READS_FROM_PG");

/**
 * Compute 5m/1d aggregates in Postgres (deferred idempotent recompute for raw
 * vendors) instead of relying on Turso-computed aggregates shipped via the queue.
 */
export const AGG_COMPUTE_IN_PG = envFlag("AGG_COMPUTE_IN_PG");

/**
 * All routing flags as a snapshot, for logging / admin diagnostics.
 */
export function dbRoutingFlags(): Record<string, boolean> {
  return {
    CONFIG_READS_FROM_PG,
    CONFIG_WRITES_TO_PG,
    READINGS_READS_FROM_PG,
    AGG_COMPUTE_IN_PG,
  };
}
