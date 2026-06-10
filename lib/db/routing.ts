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
 *
 * SHADOW PHASE (PR-8): while this flag gates the eventual cutover, in the shadow PR turning
 * it ON does NOT change the served value — reads are still answered from Turso. It only adds
 * a best-effort PG read + compare-and-log of any divergence (see lib/db/config-shadow.ts).
 * Serving config from Postgres is a later cutover PR.
 */
export const CONFIG_READS_FROM_PG = envFlag("CONFIG_READS_FROM_PG");

/**
 * Make Postgres the authoritative target for config-table writes (writes stop
 * going to Turso). Gated separately from reads so the two flip together at the
 * config-authority cutover.
 */
export const CONFIG_WRITES_TO_PG = envFlag("CONFIG_WRITES_TO_PG");

/**
 * Serve config reads FROM Postgres (the cutover). Flip together with
 * CONFIG_WRITES_TO_PG. With it off, reads are served from Turso (shadow-only
 * when CONFIG_READS_FROM_PG is on).
 */
export const CONFIG_SERVE_FROM_PG = envFlag("CONFIG_SERVE_FROM_PG");

/**
 * Serve readings reads (point_readings / agg_5m / agg_1d serving queries) FROM Postgres.
 *
 * CUTOVER (PR-13a): turning this ON makes Postgres the SERVED source — `serveReadings`
 * (lib/db/readings-serve.ts) reads PG and falls back to Turso only on error / unconfigured PG.
 * With it OFF, reads are served from Turso exactly as before. Unlike config, readings use a SINGLE
 * flag: it gated the earlier shadow phase (#19) and now, after the shadow diff went clean over a
 * settled window, the same flag is repurposed to serve. Rollback = flip back to false.
 */
export const READINGS_READS_FROM_PG = envFlag("READINGS_READS_FROM_PG");

/**
 * Compute 5m/1d aggregates in Postgres (deferred idempotent recompute for raw
 * vendors) instead of relying on Turso-computed aggregates shipped via the queue.
 */
export const AGG_COMPUTE_IN_PG = envFlag("AGG_COMPUTE_IN_PG");

/**
 * Phase 4 — PG raw durability. When ON, each poll's built QueueMessage(s) are
 * also recorded in the `observations_outbox` table (a tee, in parallel with the
 * unchanged live direct enqueue), and the relay cron (app/api/cron/relay-outbox)
 * drains them to QStash. This makes raw readings durable on Postgres — derived
 * from a committed row, retried until acked — instead of relying on the inline
 * Turso write + a fire-and-forget enqueue. Additive and fully reversible: OFF =
 * exactly today's behaviour (direct enqueue only). See
 * docs/architecture/engine-web-separation.md §6.4 and docs/turso-pg-migration.md
 * Phase 4.
 */
export const WRITE_OUTBOX = envFlag("WRITE_OUTBOX");

/**
 * All routing flags as a snapshot, for logging / admin diagnostics.
 */
export function dbRoutingFlags(): Record<string, boolean> {
  return {
    CONFIG_READS_FROM_PG,
    CONFIG_WRITES_TO_PG,
    CONFIG_SERVE_FROM_PG,
    READINGS_READS_FROM_PG,
    AGG_COMPUTE_IN_PG,
    WRITE_OUTBOX,
  };
}
