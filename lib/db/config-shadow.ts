/**
 * Config-table read shadowing + serve-from-PG cutover (Turso → Postgres migration, PR-8).
 *
 * THREE MODES, gated by two flags (`CONFIG_READS_FROM_PG`, `CONFIG_SERVE_FROM_PG`):
 *
 *   • Both OFF (default): behave exactly as today — Turso read, the PG read never runs,
 *     zero added cost.
 *   • READS_FROM_PG ON, SERVE_FROM_PG OFF (shadow): the SERVED value is STILL the Turso
 *     read. We additionally fire the PG read, normalize both sides, compare, and LOG any
 *     divergence. The PG read is best-effort: any error is caught and swallowed, so flipping
 *     this flag on in production can only add log lines — it can never change a user-facing
 *     result or break a request.
 *   • SERVE_FROM_PG ON (cutover): the SERVED value comes FROM Postgres. The PG read runs
 *     first and, on success, is returned without ever touching Turso (lazy). An optional
 *     `toServed` maps the PG read into the Turso-shaped served value. If the PG read returns
 *     `SHADOW_SKIP` (PG unconfigured) or throws, we fall through to a Turso read as a safety
 *     net — Turso config is recent at cutover. SERVE takes precedence over the shadow path;
 *     when SERVE is on the shadow compare is NOT run.
 *
 * Every config read site funnels through `shadowReadConfig`, supplying its own Turso read,
 * PG read, and a `normalize` projection that strips the non-load-bearing schema divergences
 * (see `toEpochSeconds` / `normalizeJson`) before comparison.
 */
import { CONFIG_READS_FROM_PG, CONFIG_SERVE_FROM_PG } from "./routing";

export interface ShadowDiffResult {
  matched: boolean;
  diffFields: string[];
}

/**
 * A `pgRead` may return this sentinel to signal "Postgres unavailable / nothing to compare"
 * (e.g. `planetscaleDb` is null because PG isn't configured). The shadow is then skipped
 * with no divergence logged.
 */
export const SHADOW_SKIP: unique symbol = Symbol("config-shadow-skip");

/**
 * Deterministic JSON with recursively key-sorted objects, so object key order and the
 * Turso `text(mode:"json")` vs PG `jsonb` representation don't produce false divergences.
 */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Truncate a timestamp to whole SECONDS. Turso `integer(mode:"timestamp")` stores/returns
 * second-precision `Date`s, while PG `timestamp` keeps sub-second precision — comparing raw
 * `getTime()` would false-diff on every row. Accepts a `Date`, an epoch-ms `number` (e.g.
 * point_info's Turso `*Ms` integer columns), or null/undefined.
 */
export function toEpochSeconds(
  v: Date | number | null | undefined,
): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : v;
  return Math.floor(ms / 1000);
}

/** Parse a JSON string into a value (Turso text-json); pass objects through (PG jsonb). */
export function normalizeJson(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v ?? null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function topLevelDiffFields(a: unknown, b: unknown): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys]
      .filter((k) => stableStringify(a[k]) !== stableStringify(b[k]))
      .sort();
  }
  return ["(value)"];
}

function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Compare two already-normalized projections. On divergence, log a single structured,
 * grep-able line with the field-level diff and return it. Pure — no flag/IO.
 */
export function compareNormalized(
  label: string,
  key: string | undefined,
  turso: unknown,
  pg: unknown,
): ShadowDiffResult {
  if (stableStringify(turso) === stableStringify(pg)) {
    return { matched: true, diffFields: [] };
  }
  const diffFields = topLevelDiffFields(turso, pg);
  console.warn(
    `[CONFIG-SHADOW] ${label}${key ? ` key=${key}` : ""} DIVERGE ` +
      `fields=[${diffFields.join(",")}] ` +
      `turso=${truncate(stableStringify(turso))} pg=${truncate(stableStringify(pg))}`,
  );
  return { matched: false, diffFields };
}

/**
 * Resolve a config read across the three migration modes (see the file header).
 *
 *   • `CONFIG_SERVE_FROM_PG` on (cutover): serve FROM Postgres. Run `pgRead` first; on a
 *     real result, return it (mapped through `toServed` when supplied) WITHOUT touching
 *     Turso. On `SHADOW_SKIP` (PG unconfigured) or a thrown error, fall through to a Turso
 *     read as a safety net. The shadow compare is NOT run in this mode.
 *   • `CONFIG_READS_FROM_PG` on, SERVE off (shadow): serve the Turso read, then best-effort
 *     fire `pgRead` and log any normalized divergence.
 *   • Both off (default): serve the Turso read; `pgRead` never runs.
 */
export async function shadowReadConfig<T>(
  label: string,
  tursoRead: () => Promise<T>,
  opts: {
    pgRead: () => Promise<unknown>;
    normalize: (v: unknown) => unknown;
    diffKey?: string;
    /**
     * Maps a successful PG read into the Turso-shaped served value (cutover only).
     * Omit when the PG read already matches the Turso shape.
     */
    toServed?: (pg: unknown) => T;
  },
): Promise<T> {
  if (CONFIG_SERVE_FROM_PG) {
    try {
      const pg = await opts.pgRead();
      if (pg !== SHADOW_SKIP) {
        return opts.toServed ? opts.toServed(pg) : (pg as T);
      }
      // PG unconfigured (SHADOW_SKIP) → fall through to Turso.
    } catch (e) {
      console.error(
        `[CONFIG-SERVE] ${label}${opts.diffKey ? ` key=${opts.diffKey}` : ""} ` +
          `PG read failed — serving Turso fallback`,
        e,
      );
      // fall through to Turso (safety net; Turso config is recent at cutover).
    }
  }

  const served = await tursoRead();
  if (CONFIG_READS_FROM_PG && !CONFIG_SERVE_FROM_PG) {
    try {
      const shadow = await opts.pgRead();
      if (shadow === SHADOW_SKIP) return served;
      compareNormalized(
        label,
        opts.diffKey,
        opts.normalize(served),
        opts.normalize(shadow),
      );
    } catch (e) {
      console.warn(
        `[CONFIG-SHADOW] ${label} pg-read failed (swallowed): ${(e as Error)?.message ?? String(e)}`,
      );
    }
  }
  return served;
}
