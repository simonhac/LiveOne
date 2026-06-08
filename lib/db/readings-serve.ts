/**
 * Readings-table read serving (Turso → Postgres migration, PR-13a — serve-from-PG cutover).
 *
 * The readings analog of the config serve seam, generic over the served payload type `T` so every
 * readings endpoint (`/api/history`, the admin point-readings views) reuses one harness — each
 * supplies its own PG read and a Turso read used only as a fallback.
 *
 * History: this file replaces `readings-shadow.ts`. During the shadow phase (#19) the flag-on path
 * served Turso and merely compared a concurrent PG read. Burn-in proved value + serve-path parity
 * (`scripts/reconcile-agg-values.ts` GREEN over a settled window incl. fresh 1d), so the SINGLE flag
 * `READINGS_READS_FROM_PG` is now repurposed to actually SERVE from Postgres:
 *
 *   • Flag OFF (default): behave exactly as before — serve the Turso read; PG is never touched.
 *   • Flag ON: serve the Postgres read. PG is the primary; if the PG read throws or returns
 *     `SHADOW_SKIP` (PG unconfigured), fall back to the Turso read and log a single
 *     `[READINGS-SERVE] … pg unavailable → serving Turso` line. Only one store is read on the happy
 *     path (no concurrent double-read), so serving costs the same as Turso did and benefits from PG's
 *     much faster admin-readings queries.
 *
 * Rollback is a flag flip: `READINGS_READS_FROM_PG=false` reverts to serving Turso instantly.
 *
 * The `near`/`pairMatches` tolerance helpers (shared with the offline reconciler's definition of
 * equality) and `ReadingsCompareResult` remain exported here for the PG read modules' equivalence
 * comparators and their tests.
 */
import { READINGS_READS_FROM_PG } from "./routing";
import { SHADOW_SKIP } from "./config-shadow";

export { SHADOW_SKIP };

export interface ReadingsCompareResult {
  matched: boolean;
  /** Human-readable, grep-friendly summary of the divergence (omitted when matched). */
  detail?: string;
}

/**
 * Two numbers are "near" if within a relative tolerance with a floor of 1 — the same rule the
 * value reconciler uses (`scripts/reconcile-agg-values.ts`), so the online and offline checks share
 * one definition of equality. Absorbs SQLite-real vs PG-double low-bit noise and `toPrecision`
 * rounding-boundary flapping.
 */
export function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether a single Turso-vs-PG value pair is NON-divergent under the comparison rules:
 *   • either side null/undefined → NOT a divergence (presence-only; covers live-tail lag and
 *     gap-fill nulls that legitimately differ while the queue catches up),
 *   • both numbers → equal within `near()`,
 *   • otherwise → strict equality (strings, booleans).
 * Only a pair where BOTH sides are present and differ counts as a divergence.
 */
export function pairMatches(turso: unknown, pg: unknown, tol = 1e-6): boolean {
  if (turso == null || pg == null) return true;
  if (typeof turso === "number" && typeof pg === "number") {
    return near(turso, pg, tol);
  }
  return turso === pg;
}

/**
 * Resolve a readings read, serving from Postgres when `READINGS_READS_FROM_PG` is on (see header).
 *
 *   • Flag off: serve `tursoServe()`; `pgServe` never runs.
 *   • Flag on: serve `pgServe()`. If it returns `SHADOW_SKIP` (PG unconfigured) or throws, log a
 *     `[READINGS-SERVE]` line and fall back to `tursoServe()`. A Turso failure (on the off path or
 *     the fallback path) propagates exactly as it would without this harness.
 */
export async function serveReadings<T>(
  label: string,
  pgServe: () => Promise<T | typeof SHADOW_SKIP>,
  tursoServe: () => Promise<T>,
): Promise<T> {
  if (!READINGS_READS_FROM_PG) {
    return tursoServe(); // exactly as before the cutover
  }

  try {
    const pgResult = await pgServe();
    if (pgResult === SHADOW_SKIP) {
      console.warn(`[READINGS-SERVE] ${label} pg unconfigured → serving Turso`);
      return tursoServe();
    }
    return pgResult as T;
  } catch (e) {
    console.warn(
      `[READINGS-SERVE] ${label} pg unavailable → serving Turso: ` +
        `${(e as Error)?.message ?? String(e)}`,
    );
    return tursoServe();
  }
}
