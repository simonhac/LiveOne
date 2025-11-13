/**
 * Calculate energy (kWh) from power data using trapezoidal integration
 * @param powerValues Array of power values in kW
 * @param timestamps Array of timestamps (Date objects)
 * @returns Total energy in kWh
 *
 * KNOWN LIMITATION: For daily averaged data (30D view), bidirectional flows like battery
 * charge/discharge and grid import/export are not accurately calculated. The daily power.avg
 * values average both directions together (e.g., battery charging and discharging over 24 hours),
 * which loses the directional information needed for accurate energy totals.
 *
 * PLANNED FIX: Move site data processing server-side and persist daily energy flow matrices
 * calculated from 5-minute data before averaging occurs. This will provide accurate energy
 * totals for all time periods.
 */
export function calculateEnergyKwh(
  powerValues: (number | null)[],
  timestamps: Date[],
): number | null {
  if (powerValues.length < 2 || timestamps.length < 2) {
    return null;
  }

  if (powerValues.length !== timestamps.length) {
    console.error(
      "Power values and timestamps arrays must have the same length",
    );
    return null;
  }

  let totalEnergy = 0;
  let hasValidSegment = false;

  // Check if we're dealing with daily averaged data (intervals ~= 24 hours)
  // For daily data, power.avg already represents the average over 24 hours,
  // so we should multiply by the interval duration rather than using trapezoidal integration
  const firstInterval =
    timestamps.length >= 2
      ? (timestamps[1].getTime() - timestamps[0].getTime()) / (1000 * 60 * 60)
      : 0;
  const isDailyData = firstInterval >= 20; // ~24 hour intervals

  if (isDailyData) {
    // For daily data: power.avg is the average power over 24 hours
    // Energy for each day = power.avg * 24 hours
    console.log(
      `[Energy Calculator] Using daily data method (interval: ${firstInterval.toFixed(1)}h), ${powerValues.length} data points`,
    );
    for (let i = 0; i < powerValues.length; i++) {
      const power = powerValues[i];

      if (power === null) {
        continue;
      }

      // Each data point represents one day's average power
      // Energy = average power * 24 hours
      const segmentEnergy = power * 24;
      totalEnergy += segmentEnergy;
      hasValidSegment = true;
    }
    console.log(
      `[Energy Calculator] Daily data total energy: ${totalEnergy.toFixed(2)} kWh`,
    );
  } else {
    // For instantaneous data: use trapezoidal integration
    // Trapezoidal integration: Area = (y1 + y2) * dt / 2
    for (let i = 0; i < powerValues.length - 1; i++) {
      const power1 = powerValues[i];
      const power2 = powerValues[i + 1];

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
  }

  return hasValidSegment ? totalEnergy : null;
}

/**
 * Calculate energy for multiple series
 * @param series Array of series data with power values
 * @param timestamps Array of timestamps
 * @returns Map of series ID to energy value
 */
export function calculateSeriesEnergy(
  series: Array<{ id: string; data: (number | null)[] }>,
  timestamps: Date[],
): Map<string, number | null> {
  const energyMap = new Map<string, number | null>();

  for (const s of series) {
    const energy = calculateEnergyKwh(s.data, timestamps);
    energyMap.set(s.id, energy);
  }

  return energyMap;
}
