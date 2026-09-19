/**
 * Window energy totals (kWh) for the legend tables, from a chart's own series.
 *
 * Two modes, decided by the chart, not guessed from the data:
 *
 *  - **energy** — the values ARE kWh already (one per day at the M period, one per calendar month at
 *    Y), so the window total is a plain SUM.
 *  - **power** — the values are kW samples (5m/30m), integrated trapezoidally over their timestamps.
 *
 * 🛑 The mode used to be INFERRED here, from whether the first two timestamps were ≥20 h apart, and
 * the daily branch multiplied each value by 24 on its way into the total. That was the whole of the
 * ×24: the chart drew the raw daily `power.avg` under an axis labelled `kWh`, and only this function
 * ever applied the conversion — so the bars and the total they were supposed to add up to were 24×
 * apart, in the same table. The conversion now happens once, upstream in `lib/site-data-processor.ts`
 * (`toDailyEnergy`), which is also what let the Y view roll days into months: with the gap closed,
 * a month's bar is just the sum of its days and this function keeps agreeing with it. The heuristic
 * had to go with it — at Y the spacing between two monthly buckets is ~30 days, and "≥20h" would
 * have quietly multiplied a month's kWh by 24.
 *
 * KNOWN LIMITATION (unchanged): for daily data, bidirectional flows like battery charge/discharge
 * and grid import/export are not accurately separated — the daily aggregate averages both directions
 * together, losing the directional information. The attributed flow matrix (`flow_attr_1d`) is the
 * accurate source and is what the cost/emissions column already reads.
 */
function calculateEnergyKwh(
  values: (number | null)[],
  timestamps: Date[],
  mode: "power" | "energy",
): number | null {
  if (values.length === 0) return null;

  if (values.length !== timestamps.length) {
    console.error(
      "Power values and timestamps arrays must have the same length",
    );
    return null;
  }

  let totalEnergy = 0;
  let hasValidSegment = false;

  if (mode === "energy") {
    // Already kWh per bucket — a bucket is a day (M) or a calendar month (Y). Nulls are gaps, not
    // zeros, but a gap contributes nothing to a total either way; what matters is that a window of
    // nothing but gaps returns null rather than 0.
    for (const value of values) {
      if (value === null) continue;
      totalEnergy += value;
      hasValidSegment = true;
    }
    return hasValidSegment ? totalEnergy : null;
  }

  // Instantaneous power: trapezoidal integration. Area = (y1 + y2) * dt / 2.
  for (let i = 0; i < values.length - 1; i++) {
    const power1 = values[i];
    const power2 = values[i + 1];

    // Skip if either value is null
    if (power1 === null || power2 === null) {
      continue;
    }

    // Calculate time difference in hours
    const time1 = timestamps[i].getTime();
    const time2 = timestamps[i + 1].getTime();
    const deltaHours = (time2 - time1) / (1000 * 60 * 60);

    // Trapezoidal area (average power * time)
    const segmentEnergy = ((power1 + power2) / 2) * deltaHours;
    totalEnergy += segmentEnergy;
    hasValidSegment = true;
  }

  return hasValidSegment ? totalEnergy : null;
}

/**
 * Calculate energy for multiple series
 * @param series Array of series data with power values
 * @param timestamps Array of timestamps
 * @param mode The chart's own mode — `energy` (values are kWh) or `power` (values are kW)
 * @returns Map of series ID to energy value
 */
export function calculateSeriesEnergy(
  series: Array<{ id: string; data: (number | null)[] }>,
  timestamps: Date[],
  mode: "power" | "energy",
): Map<string, number | null> {
  const energyMap = new Map<string, number | null>();

  for (const s of series) {
    const energy = calculateEnergyKwh(s.data, timestamps, mode);
    energyMap.set(s.id, energy);
  }

  return energyMap;
}
