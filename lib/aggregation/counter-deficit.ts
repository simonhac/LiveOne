/**
 * Trusting one interval of a differenced cumulative counter.
 *
 * A meter counter only goes up, so a NEGATIVE interval delta means the counter dropped out or
 * re-based. What makes that expensive is the other half: the counter comes back, and the interval
 * where it does carries everything it skipped, in one bucket. Raw sums self-cancel and the DAY is
 * still right — which is why `computeDayEnergyReadings` keeps the diffs signed — but neither
 * interval means what it says, and any per-interval consumer reads a spike.
 *
 * Measured on Sigenergy (Kutis, 2026-08-20): the solar counter sat at 26.97 kWh, read 0.00 for one
 * sample, then 26.97 again. As interval energy that is −26.97 then +26.97 kWh; as power, ∓324 kW at
 * 7pm with the sun down. Confirmed vendor-side from the raw payload — `powerGeneration: 0` with
 * `esCharging: -0.01`, a negative on a cumulative counter.
 *
 * ## Why a deficit and not "the next interval"
 *
 * The obvious guard — distrust a negative and the interval after it — is what both call sites
 * originally had, and it is not enough: the counter can stay frozen for SEVERAL intervals, so the
 * catch-up is not adjacent to the negative. Prod, 2026-08-19: `−10590` at 17:30, zeros through
 * 17:55, `+10590` at 18:00. The interval before the catch-up is 0, not negative, so it passed the
 * adjacent check and was booked as one interval's energy — inflating that day's solar to 10.7× the
 * metered total.
 *
 * Tracking the DEBT closes it without a threshold, because the deltas telescope: a negative says
 * exactly how much the counter owes, and every interval stays distrusted until subsequent deltas
 * have repaid it. Nothing here needs to know a plausible magnitude.
 *
 * ## Not for signed-net series
 *
 * This reads a negative as impossible, which holds only for a counter that measures one direction
 * (generation, consumption, import, export, charge, discharge). A signed NET register is negative
 * whenever the flow reverses, and its dropouts are not detectable by sign.
 */

/**
 * Which intervals of `values` can be read as that interval's own quantity.
 *
 * `values` is a time-ORDERED series of interval deltas; `null` (no reading) is never trusted and
 * does not disturb the debt. Returns a parallel array.
 *
 * `ulp` forgives negatives no larger than one unit in the last place of the source counter — a
 * low-volume register rounded to a coarse resolution flickers (…0 → 0.01 → 0 → 0.01…), and reading
 * that as a dropout distrusted 49 % of Sigenergy's grid intervals for what is only the reporting
 * resolution. Default 0 (any negative is a dropout), which is the right default for a caller whose
 * fallback is cheap.
 */
export function trustedByDeficit(
  values: readonly (number | null | undefined)[],
  ulp = 0,
): boolean[] {
  const trusted = new Array<boolean>(values.length).fill(false);
  let debt = 0;

  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw === null || raw === undefined) continue;

    if (raw < -ulp) {
      debt = -raw; // dropped out — it now owes this much
      continue;
    }
    // Within one ULP of zero: reporting resolution, not a dropout.
    const v = raw < 0 ? 0 : raw;

    if (debt > 0) {
      debt -= v; // still repaying; this bucket carries more than its own interval
      continue;
    }
    trusted[i] = true;
  }
  return trusted;
}
