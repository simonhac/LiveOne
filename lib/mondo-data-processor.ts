import { ChartData, SeriesData, SERIES_CONFIG } from '@/components/MondoPowerChart'

export interface ProcessedMondoData {
  load: ChartData | null
  generation: ChartData | null
}

export async function fetchAndProcessMondoData(
  systemId: string,
  period: '1D' | '7D' | '30D'
): Promise<ProcessedMondoData> {
  // Map period to request parameters
  let requestInterval: string
  let duration: string

  if (period === '1D') {
    requestInterval = '5m'
    duration = '24h'
  } else if (period === '7D') {
    requestInterval = '30m'
    duration = '168h'
  } else {
    requestInterval = '1d'
    duration = '30d'
  }

  const response = await fetch(`/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId}`, {
    credentials: 'same-origin'
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.status}`)
  }

  const data = await response.json()

  // Check if we have data
  if (!data || !data.data || !Array.isArray(data.data)) {
    console.warn('No data returned from history API:', data)
    return { load: null, generation: null }
  }

  // Process the data once for both charts
  const powerSeries = data.data.filter((d: any) => d.type === 'power')

  if (powerSeries.length === 0) {
    console.warn('No power series data available in response')
    return { load: null, generation: null }
  }

  // Create a map of available series by their ID suffix
  const seriesMap = new Map<string, any>()
  powerSeries.forEach((series: any) => {
    const idParts = series.id.split('.')
    const key = '.' + idParts[idParts.length - 1]
    seriesMap.set(key, series)
  })

  // Get first available series to extract timestamps
  const firstSeries = powerSeries[0]
  if (!firstSeries) {
    console.warn('No first series found')
    return { load: null, generation: null }
  }

  const startTimeString = firstSeries.history.start
  const startTime = new Date(startTimeString)
  const interval = firstSeries.history.interval

  let intervalMs: number
  if (interval === '1d') {
    intervalMs = 24 * 60 * 60000
  } else if (interval === '30m') {
    intervalMs = 30 * 60000
  } else if (interval === '5m') {
    intervalMs = 5 * 60000
  } else if (interval === '1m') {
    intervalMs = 60000
  } else {
    throw new Error(`Unsupported interval: ${interval}`)
  }

  const timestamps = firstSeries.history.data.map((_: any, index: number) =>
    new Date(startTime.getTime() + index * intervalMs)
  )

  // Filter to selected time range
  const currentTime = new Date()
  let windowHours: number
  let intervalMinutes: number

  if (period === '1D') {
    windowHours = 24
    intervalMinutes = 5
  } else if (period === '7D') {
    windowHours = 24 * 7
    intervalMinutes = 30
  } else {
    windowHours = 24 * 30
    intervalMinutes = 24 * 60
  }

  // Round down the current time to the nearest interval boundary
  const currentMinutes = currentTime.getMinutes()
  const roundedMinutes = Math.floor(currentMinutes / intervalMinutes) * intervalMinutes
  const windowEnd = new Date(currentTime)
  windowEnd.setMinutes(roundedMinutes, 0, 0) // Round to interval boundary

  // Start exactly windowHours before the end time
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000)

  const selectedIndices = timestamps
    .map((t: Date, i: number) => ({ time: t, index: i }))
    .filter(({ time }: { time: Date, index: number }) => time >= windowStart && time <= windowEnd)
    .map(({ index }: { time: Date, index: number }) => index)

  const filteredTimestamps = selectedIndices.map((i: number) => timestamps[i])

  // Process data for both load and generation modes
  const processedData: ProcessedMondoData = {
    load: null,
    generation: null
  }

  // Process each mode
  const modes: ('load' | 'generation')[] = ['load', 'generation']
  modes.forEach(mode => {
    const seriesConfig = SERIES_CONFIG[mode]
    const seriesData: SeriesData[] = []

    // For rest of house calculation
    let measuredLoadsSum: (number | null)[] | null = null
    let batteryChargeValues: (number | null)[] | null = null
    let gridExportValues: (number | null)[] | null = null
    let totalGenerationValues: (number | null)[] | null = null

    // Process each configured series
    seriesConfig.forEach((config) => {
      // Special handling for calculated series
      if (config.id === 'rest_of_house' && mode === 'load') {
        // We'll calculate this after processing all other series
        return
      }

      // Find the matching series in our data
      const dataSeries = seriesMap.get(config.id)
      if (!dataSeries) return // Skip if series not found in data

      // Extract the data for selected indices and convert from W to kW
      let seriesValues = selectedIndices.map((i: number) => {
        const val = dataSeries.history.data[i]
        return val === null ? null : val / 1000  // Convert W to kW
      })

      // Apply any data transformation
      if (config.dataTransform) {
        seriesValues = seriesValues.map((v: number | null) => v === null ? null : config.dataTransform!(v * 1000) / 1000)
      }

      seriesData.push({
        id: config.id,
        description: config.label,
        data: seriesValues,
        color: config.color
      })

      // Accumulate values for rest of house calculation (load mode)
      if (mode === 'load') {
        if (config.id !== '.batt_p' && config.id !== '.grid_p' && config.id !== 'rest_of_house') {
          // This is a measured load
          if (measuredLoadsSum === null) {
            measuredLoadsSum = new Array(seriesValues.length).fill(0)
          }
          seriesValues.forEach((val: number | null, idx: number) => {
            if (val !== null && measuredLoadsSum![idx] !== null) {
              measuredLoadsSum![idx] = (measuredLoadsSum![idx] as number) + val
            } else if (val === null) {
              measuredLoadsSum![idx] = null
            }
          })
        } else if (config.id === '.batt_p') {
          batteryChargeValues = seriesValues
        } else if (config.id === '.grid_p') {
          gridExportValues = seriesValues
        }
      }

      // Accumulate total generation (generation mode)
      if (mode === 'generation' && (config.id === '.solar1_p' || config.id === '.solar2_p')) {
        if (totalGenerationValues === null) {
          totalGenerationValues = new Array(seriesValues.length).fill(0)
        }
        seriesValues.forEach((val: number | null, idx: number) => {
          if (val !== null && totalGenerationValues![idx] !== null) {
            totalGenerationValues![idx] = (totalGenerationValues![idx] as number) + val
          } else if (val === null) {
            totalGenerationValues![idx] = null
          }
        })
      }
    })

    // Calculate rest of house if in load mode
    if (mode === 'load' && measuredLoadsSum) {
      // Get all generation sources (solar + grid import + battery discharge)
      const solar1 = seriesMap.get('.solar1_p')
      const solar2 = seriesMap.get('.solar2_p')
      const gridImport = seriesMap.get('.grid_p')  // This is grid import (positive when importing)
      const batteryDischarge = seriesMap.get('.batt_p')  // This is battery discharge (positive when discharging)

      const totalGeneration = selectedIndices.map((i: number) => {
        const s1 = solar1 ? solar1.history.data[i] : null
        const s2 = solar2 ? solar2.history.data[i] : null
        const gridIn = gridImport ? gridImport.history.data[i] : null
        const battOut = batteryDischarge ? batteryDischarge.history.data[i] : null

        // Convert W to kW and handle nulls
        let total = 0
        let hasAnyData = false

        if (s1 !== null && s1 !== undefined) {
          total += s1 / 1000
          hasAnyData = true
        }
        if (s2 !== null && s2 !== undefined) {
          total += s2 / 1000
          hasAnyData = true
        }
        // Grid import: positive values mean importing from grid
        if (gridIn !== null && gridIn !== undefined && gridIn > 0) {
          total += gridIn / 1000
          hasAnyData = true
        }
        // Battery discharge: positive values mean discharging
        if (battOut !== null && battOut !== undefined && battOut > 0) {
          total += battOut / 1000
          hasAnyData = true
        }

        return hasAnyData ? total : null
      })

      // Calculate rest of house
      // Rest of House = Total Generation - Measured Loads - Battery Charge - Grid Export
      const restOfHouse = totalGeneration.map((gen: number | null, idx: number) => {
        const measured = measuredLoadsSum![idx]
        const batteryCharge = batteryChargeValues![idx]
        const gridExport = gridExportValues![idx]

        // If we don't have generation or measured loads data, return null
        if (gen === null || measured === null) return null

        // Battery charge and grid export might be null (treat as 0)
        const battCharge = (batteryCharge !== null && batteryCharge !== undefined) ? batteryCharge : 0
        const gridExp = (gridExport !== null && gridExport !== undefined) ? gridExport : 0

        const rest = gen - measured - battCharge - gridExp
        return Math.max(0, rest)  // Don't show negative values
      })

      seriesData.push({
        id: 'rest_of_house',
        description: 'Rest of House',
        data: restOfHouse,
        color: 'rgb(107, 114, 128)'  // gray-500
      })
    }

    // Sort series by order from config
    seriesData.sort((a, b) => {
      const aConfig = seriesConfig.find(c => c.id === a.id)
      const bConfig = seriesConfig.find(c => c.id === b.id)
      return (aConfig?.order ?? 999) - (bConfig?.order ?? 999)
    })

    processedData[mode] = {
      timestamps: filteredTimestamps,
      series: seriesData,
      mode: requestInterval === '1d' ? 'energy' : 'power'
    }
  })

  return processedData
}