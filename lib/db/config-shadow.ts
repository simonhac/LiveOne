/**
 * Config-table read shadowing (Turso → Postgres migration, PR-8).
 *
 * SHADOW SEMANTICS — identical in spirit to PR-11's `AGG_COMPUTE_IN_PG`:
 *
 *   • `CONFIG_READS_FROM_PG` OFF (default): behave exactly as today — Turso read, the PG
 *     read never runs, zero added cost.
 *   • `CONFIG_READS_FROM_PG` ON (shadow): the SERVED value is STILL the Turso read. We
 *     additionally fire the PG read, normalize both sides, compare, and LOG any divergence.
 *     The PG read is best-effort: any error is caught and swallowed, so flipping the flag on
 *     in production can only add log lines — it can never change a user-facing result or
 *     break a request.
 *
 * Serving config FROM Postgres is a LATER cutover PR; PR-8 only proves the mirrors agree.
 *
 * Every config read site funnels through `shadowReadConfig`, supplying its own Turso read,
 * PG read, and a `normalize` projection that strips the non-load-bearing schema divergences
 * (see `toEpochSeconds` / `normalizeJson`) before comparison.
 */
import { CONFIG_READS_FROM_PG } from "./routing";

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
 * Run the Turso config read and return it. When `CONFIG_READS_FROM_PG` is on, additionally
 * run the PG read (best-effort) and log any normalized divergence. The returned value is
 * ALWAYS the Turso read.
 */
export async function shadowReadConfig<T>(
  label: string,
  tursoRead: () => Promise<T>,
  opts: {
    pgRead: () => Promise<unknown>;
    normalize: (v: unknown) => unknown;
    diffKey?: string;
  },
): Promise<T> {
  const served = await tursoRead();
  if (!CONFIG_READS_FROM_PG) return served;
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
  return served;
}
