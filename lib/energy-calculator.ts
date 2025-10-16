/**
 * Calculate energy (kWh) from power data using trapezoidal integration
 * @param powerValues Array of power values in kW
 * @param timestamps Array of timestamps (Date objects)
 * @returns Total energy in kWh
 */
export function calculateEnergyKwh(
  powerValues: (number | null)[],
  timestamps: Date[]
): number | null {
  if (powerValues.length < 2 || timestamps.length < 2) {
    return null
  }

  if (powerValues.length !== timestamps.length) {
    console.error('Power values and timestamps arrays must have the same length')
    return null
  }

  let totalEnergy = 0
  let hasValidSegment = false

  // Trapezoidal integration: Area = (y1 + y2) * dt / 2
  for (let i = 0; i < powerValues.length - 1; i++) {
    const power1 = powerValues[i]
    const power2 = powerValues[i + 1]

    // Skip if either value is null
    if (power1 === null || power2 === null) {
      continue
    }

    // Calculate time difference in hours
    const time1 = timestamps[i].getTime()
    const time2 = timestamps[i + 1].getTime()
    const deltaHours = (time2 - time1) / (1000 * 60 * 60)

    // Trapezoidal area (average power * time)
    const segmentEnergy = ((power1 + power2) / 2) * deltaHours
    totalEnergy += segmentEnergy
    hasValidSegment = true
  }

  return hasValidSegment ? totalEnergy : null
}

/**
 * Calculate energy for multiple series
 * @param series Array of series data with power values
 * @param timestamps Array of timestamps
 * @returns Map of series ID to energy value
 */
export function calculateSeriesEnergy(
  series: Array<{ id: string; data: (number | null)[] }>,
  timestamps: Date[]
): Map<string, number | null> {
  const energyMap = new Map<string, number | null>()

  for (const s of series) {
    const energy = calculateEnergyKwh(s.data, timestamps)
    energyMap.set(s.id, energy)
  }

  return energyMap
}