/**
 * Readings-table read shadowing (Turso → Postgres migration, PR-12).
 *
 * The readings analog of `lib/db/config-shadow.ts`, generic over the served payload type `T` so
 * every readings endpoint (`/api/history`, the admin point-readings views) reuses one harness —
 * each supplies its own Turso read, PG read, and comparator.
 *
 * TWO MODES, gated by the single flag `READINGS_READS_FROM_PG` (currently SHADOW-only):
 *
 *   • Flag OFF (default): behave exactly as today — serve the Turso read, the PG read never runs,
 *     zero added cost.
 *   • Flag ON (shadow): the SERVED value is STILL the Turso read. We additionally fire the PG read
 *     CONCURRENTLY, compare the two served payloads, and LOG any divergence. The PG read is
 *     best-effort: any error / `SHADOW_SKIP` is swallowed, so flipping this flag on in production
 *     can only add `[READINGS-SHADOW]` log lines — it can never change a user-facing result or
 *     break a request. Serving FROM Postgres is a LATER cutover that repurposes this same flag; it
 *     is out of scope here.
 *
 * Why compare the final served payload (not the raw rows): it is exactly what the eventual cutover
 * will serve, so a clean shadow proves the whole read+transform pipeline (query, ms↔timestamp
 * translation, dense-timeline, bucketing, precision, type representation) is equivalent — not just
 * that the underlying agg VALUES match (which `scripts/reconcile-agg-values.ts` already proves
 * offline). The per-pair rule (`pairMatches`) is deliberately lenient on presence so the queue's
 * live-tail lag (PG trails Turso on the newest intervals) never registers as a hard divergence.
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
 * Default fraction of eligible requests to shadow, from `READINGS_SHADOW_SAMPLE` (0..1).
 * Defaults to 1.0 (shadow every eligible request). Read per-call so it can be throttled via env
 * without a code change. Invalid / unset → 1.0.
 */
function defaultSampleRate(): number {
  const raw = process.env.READINGS_SHADOW_SAMPLE;
  if (raw == null || raw.trim() === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * Two numbers are "near" if within a relative tolerance with a floor of 1 — the same rule the
 * value reconciler uses (`scripts/reconcile-agg-values.ts`), so the online shadow and the offline
 * gate share one definition of equality. Absorbs SQLite-real vs PG-double low-bit noise and
 * `toPrecision` rounding-boundary flapping.
 */
export function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether a single Turso-vs-PG value pair is NON-divergent under the shadow rules:
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
 * Resolve a readings read in shadow mode (see file header).
 *
 *   • Flag off (or this request not sampled): serve `tursoServe()`; `pgServe` never runs.
 *   • Flag on: run `tursoServe()` and `pgServe()` concurrently (added latency bounded to the
 *     slower of the two, not their sum — serverless can't defer work past the response). Serve the
 *     Turso value. If the PG read succeeded (and isn't `SHADOW_SKIP`), `compare` it and log a single
 *     `[READINGS-SHADOW] … DIVERGE` line on mismatch. Any PG / compare error is swallowed.
 */
export async function shadowServeReadings<T>(
  label: string,
  tursoServe: () => Promise<T>,
  opts: {
    pgServe: () => Promise<T | typeof SHADOW_SKIP>;
    compare: (turso: T, pg: T) => ReadingsCompareResult;
    diffKey?: string;
    sampleRate?: number;
  },
): Promise<T> {
  const sampleRate = opts.sampleRate ?? defaultSampleRate();
  if (!READINGS_READS_FROM_PG || Math.random() >= sampleRate) {
    return tursoServe(); // exactly today
  }

  const keyPart = opts.diffKey ? ` ${opts.diffKey}` : "";
  const [tursoResult, pgResult] = await Promise.allSettled([
    tursoServe(),
    opts.pgServe(),
  ]);

  // Turso is the served path; a Turso failure propagates exactly as it would without the shadow.
  if (tursoResult.status === "rejected") throw tursoResult.reason;
  const served = tursoResult.value;

  if (pgResult.status === "rejected") {
    console.warn(
      `[READINGS-SHADOW] ${label}${keyPart} pg-read failed (swallowed): ` +
        `${(pgResult.reason as Error)?.message ?? String(pgResult.reason)}`,
    );
    return served;
  }
  if (pgResult.value === SHADOW_SKIP) return served; // PG unconfigured → nothing to compare

  try {
    const { matched, detail } = opts.compare(served, pgResult.value as T);
    if (!matched) {
      console.warn(
        `[READINGS-SHADOW] ${label}${keyPart} DIVERGE${detail ? ` ${detail}` : ""}`,
      );
    }
  } catch (e) {
    console.warn(
      `[READINGS-SHADOW] ${label}${keyPart} compare failed (swallowed): ` +
        `${(e as Error)?.message ?? String(e)}`,
    );
  }
  return served;
}
