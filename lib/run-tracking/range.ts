/**
 * The recompute WINDOW grammar, shared by the two callers that drive `recomputeRange`/`deleteRange`
 * over an explicit range: the minutely cron (`/api/cron/derivations`) and the per-derivation v4
 * route (`/api/v4/areas/{ar_}/derivations/{dx_}/recompute`).
 *
 * Extracted rather than copied. The two routes are read by different people at different times, and
 * a second date parser is how one of them quietly starts clamping to a different floor or reading
 * `end` as exclusive — a divergence that would show up as a hole in a backfill, weeks later, with
 * nothing to point at. The SCOPE grammar is deliberately NOT shared: the cron takes an optional
 * `derivation`/`handle`+`role` filter, while the v4 route's scope is its own path segment and cannot
 * be widened, which is the entire reason that route exists.
 */
import { parseDate } from "@internationalized/date";

/** Earliest data (when point data collection began) — clamps every backfill range. */
export const LIVEONE_BIRTHDATE_MS = Date.parse("2025-08-16T00:00:00Z");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window spec as it arrives on the wire — query params or a JSON body, already stringified. */
export interface RangeSpec {
  last?: string | null;
  date?: string | null;
  start?: string | null;
  end?: string | null;
}

/**
 * Resolve a [startMs, endMs] range. Returns null when no range was specified AND no action was
 * given (the cron's no-param trailing-reconcile path); throws `Error` on a malformed spec, which
 * both callers map to a 400.
 *
 * - last=Nd            → [now − N days, now]
 * - date=YYYY-MM-DD    → that whole UTC day
 * - start&end=Y-M-D    → [start 00:00Z, end 23:59:59.999Z]  (end INCLUSIVE)
 * - (action, no dates) → [BIRTHDATE, now] (all data)
 */
export function parseRecomputeRange(
  action: string | null,
  spec: RangeSpec,
  nowMs: number,
): { startMs: number; endMs: number } | null {
  const { last = null, date = null, start = null, end = null } = spec;
  const specCount = [last, date, start || end].filter(Boolean).length;
  if (specCount > 1) {
    throw new Error(
      "Only one date specification allowed: use 'last', 'date', or 'start+end'",
    );
  }

  let startMs: number;
  let endMs: number;

  if (last) {
    const days = parseInt(last.replace("d", ""), 10);
    if (isNaN(days) || days <= 0) {
      throw new Error("Invalid 'last' parameter. Expected format: '7d'");
    }
    startMs = nowMs - days * DAY_MS;
    endMs = nowMs;
  } else if (date) {
    const d = parseDate(date); // throws on bad format
    startMs = Date.parse(`${d.toString()}T00:00:00Z`);
    endMs = Date.parse(`${d.toString()}T23:59:59.999Z`);
  } else if (start || end) {
    if (!start || !end) {
      throw new Error("Both start and end must be provided together");
    }
    const s = parseDate(start);
    const e = parseDate(end);
    startMs = Date.parse(`${s.toString()}T00:00:00Z`);
    endMs = Date.parse(`${e.toString()}T23:59:59.999Z`);
  } else if (action) {
    // Explicit action, no dates → all data.
    startMs = LIVEONE_BIRTHDATE_MS;
    endMs = nowMs;
  } else {
    return null; // no action, no dates → trailing reconcile
  }

  if (startMs < LIVEONE_BIRTHDATE_MS) startMs = LIVEONE_BIRTHDATE_MS;
  if (startMs > endMs) {
    throw new Error("Start must be before or equal to end");
  }
  return { startMs, endMs };
}
