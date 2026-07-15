/**
 * Pure reserve-floor learner — NO database, NO clock, NO IO. Structural twin of `capacity.ts`.
 *
 * The reserve floor is the battery's physical minimum operating SoC (%): usable energy is measured
 * ABOVE it, so the fold pins its inventory to `targetE = (SoC − reserveFloor)/100 · C`. It is learned
 * per LOCAL day as a low quantile of the trailing-`RESERVE_WINDOW_DAYS` per-day SoC MINIMA, clamped to
 * a physical band `[RESERVE_FLOOR_MIN, DEFAULT_RESERVE_PCT]`.
 *
 * Why per-day-minima, and why persisted: the reserve floor used to be a SLIDING 90-day 0.5th-percentile
 * of all 5-min SoC samples, cached in KV and baked as a scalar into each fold checkpoint — the ONE
 * provenance input that was neither reproducible nor persisted, so a stale cache re-froze into
 * checkpoints and self-perpetuated (the ~20% "genset comfort setpoint" bug). Persisting a per-day value
 * — computed causally from the additive per-day `socMin` reduction (see `daily.ts`) — makes it a
 * reproducible, window-independent param exactly like η / C / η_c / idle, read back per interval by the
 * loader. Percentile-of-daily-minima ≠ 0.5th-percentile-of-all-samples, but both target the same
 * physical floor and the clamp dominates for a genset-backed site (→ DEFAULT_RESERVE_PCT).
 */

/** Default upper bound (%) on the applied floor when a battery declares no `reserveFloorMaxPct`. */
export const DEFAULT_RESERVE_PCT = 10;
const RESERVE_FLOOR_MIN = 5;
/** Trailing window (local days) the low-SoC quantile is taken over. */
const RESERVE_WINDOW_DAYS = 90;
/** Low quantile of the per-day SoC minima in the window (robust to a single anomalous deep dip). */
const RESERVE_Q = 0.05;
/** Need at least this many non-null day-minima in the window, else fall back to DEFAULT_RESERVE_PCT. */
const RESERVE_MIN_DAYS = 10;

const clamp = (x: number, lo: number, hi: number) =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * The per-day applied reserve floor (%), from a CAUSAL trailing window of per-day SoC minima.
 * `socMin[i]` is day `i`'s minimum forward-filled SoC (%), or null when the day was SoC-dark; `maxPct`
 * is the battery's assumed physical floor (`config.batteryProvenance.reserveFloorMaxPct`, default
 * `DEFAULT_RESERVE_PCT`) — the UPPER clamp. Returns a value index-aligned to the input: each day's floor
 * is a low quantile of the ≤`RESERVE_WINDOW_DAYS` non-null minima ending at (and including) that day,
 * minus 2, clamped to `[RESERVE_FLOOR_MIN, maxPct]`.
 *
 * The clamp is a "learn-where-you-can, assume-where-you-can't" rule: where the battery discharges deep
 * the quantile is data-driven (< maxPct, so the cap doesn't bind); where it never goes below the genset
 * setpoint the floor is unidentifiable from SoC, so it pins to `maxPct` (the prior). Days with too few
 * observations in the window also get `maxPct` (conservative — understates usable rather than
 * over-claiming reserve). Deterministic, always finite.
 */
export function learnReserveFloorByDay(
  socMin: (number | null)[],
  maxPct: number = DEFAULT_RESERVE_PCT,
): number[] {
  const hi = Math.max(RESERVE_FLOOR_MIN, maxPct); // guard an inverted band
  const out: number[] = new Array(socMin.length);
  for (let i = 0; i < socMin.length; i++) {
    const lo = Math.max(0, i - (RESERVE_WINDOW_DAYS - 1));
    const mins: number[] = [];
    for (let j = lo; j <= i; j++) {
      const m = socMin[j];
      if (m !== null) mins.push(m);
    }
    if (mins.length < RESERVE_MIN_DAYS) {
      out[i] = hi;
      continue;
    }
    mins.sort((a, b) => a - b);
    const p = mins[Math.floor(RESERVE_Q * (mins.length - 1))];
    out[i] = clamp(p - 2, RESERVE_FLOOR_MIN, hi);
  }
  return out;
}
