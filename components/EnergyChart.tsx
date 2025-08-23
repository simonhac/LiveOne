'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import ChartTooltip from './ChartTooltip'
import PeriodSwitcher from './PeriodSwitcher'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  ChartOptions,
  Filler,
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { format } from 'date-fns'
import 'chartjs-adapter-date-fns'
import annotationPlugin from 'chartjs-plugin-annotation'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
  annotationPlugin
)

interface EnergyChartProps {
  className?: string
  maxPowerHint?: number // Max power in kW
}

interface ChartData {
  timestamps: Date[]
  solar: number[]
  load: number[]
  batteryW: number[]
  batterySOC: number[]
  batterySOCMin?: number[]  // Min SOC for daily data
  batterySOCMax?: number[]  // Max SOC for daily data
  mode: 'power' | 'energy' // Mode based on interval: power (≤30m) or energy (≥1d)
}

export default function EnergyChart({ className = '', maxPowerHint }: EnergyChartProps) {
  const [chartData, setChartData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'1D' | '7D' | '30D'>('1D')
  const [hoveredData, setHoveredData] = useState<{ solar: number | null; load: number | null; batterySOC: number | null; timestamp: Date | null }>({
    solar: null,
    load: null,
    batterySOC: null,
    timestamp: null
  })
  const chartRef = useRef<any>(null)
  
  // Define callbacks before any conditional returns
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
  const handleHover = useCallback((event: any, activeElements: any[], chart: any) => {
    // Don't process if no chart data
    if (!chartData) return
    
    // Clear any pending timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }
    
    // Debounce the hover update
    hoverTimeoutRef.current = setTimeout(() => {
      if (activeElements && activeElements.length > 0) {
        const dataIndex = activeElements[0].index
        const solarValue = chartData.mode === 'energy' 
          ? chartData.solar[dataIndex]
          : (chartData.solar[dataIndex] !== null ? chartData.solar[dataIndex] / 1000 : null) // Convert W to kW
        const loadValue = chartData.mode === 'energy'
          ? chartData.load[dataIndex]
          : (chartData.load[dataIndex] !== null ? chartData.load[dataIndex] / 1000 : null) // Convert W to kW
        const batteryValue = chartData.batterySOC[dataIndex]
        const timestamp = chartData.timestamps[dataIndex]
        
        setHoveredData({
          solar: solarValue,
          load: loadValue,
          batterySOC: batteryValue,
          timestamp: timestamp
        })
      } else {
        setHoveredData({ solar: null, load: null, batterySOC: null, timestamp: null })
      }
    }, 10) // Small debounce delay
  }, [chartData])
  
  // Calculate the time window for x-axis
  const { now, windowStart } = useMemo(() => {
    const now = new Date()
    let windowHours: number
    if (timeRange === '1D') {
      windowHours = 24
    } else if (timeRange === '7D') {
      windowHours = 24 * 7
    } else { // 30D
      windowHours = 24 * 30
    }
    const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000)
    return { now, windowStart }
  }, [timeRange])

  const options: ChartOptions<any> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    onHover: handleHover,
    plugins: {
      legend: {
        display: false, // Hide the legend
      },
      tooltip: {
        enabled: false, // Disable the default tooltip since we're using our custom one
      },
      annotation: {
        annotations: (() => {
          const annotations: any[] = []
          
          if (timeRange === '30D') {
            // For 30D view: shade weekdays (Mon-Fri)
            const daysToShow = 31
            for (let i = 0; i < daysToShow; i++) {
              const day = new Date(now)
              day.setDate(day.getDate() - i)
              day.setHours(0, 0, 0, 0)
              
              const dayOfWeek = day.getDay() // 0 = Sunday, 6 = Saturday
              
              // Only shade weekdays (Monday = 1 through Friday = 5)
              if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                const dayEnd = new Date(day)
                dayEnd.setHours(23, 59, 59, 999)
                
                // Only add if this day overlaps with our window
                if (dayEnd > windowStart && day < now) {
                  annotations.push({
                    type: 'box',
                    xMin: Math.max(day.getTime(), windowStart.getTime()),
                    xMax: Math.min(dayEnd.getTime(), now.getTime()),
                    backgroundColor: 'rgba(255, 255, 255, 0.07)', // 7% opacity white overlay
                    borderWidth: 0,
                  })
                }
              }
            }
          } else {
            // For 1D and 7D views: shade daytime hours (7am-10pm)
            const daysToShow = timeRange === '1D' ? 2 : 8
            for (let i = 0; i < daysToShow; i++) {
              const dayStart = new Date(now)
              dayStart.setDate(dayStart.getDate() - i)
              dayStart.setHours(7, 0, 0, 0)
              
              const dayEnd = new Date(now)
              dayEnd.setDate(dayEnd.getDate() - i)
              dayEnd.setHours(22, 0, 0, 0)
              
              // Only add if this day overlaps with our window
              if (dayEnd > windowStart && dayStart < now) {
                annotations.push({
                  type: 'box',
                  xMin: Math.max(dayStart.getTime(), windowStart.getTime()),
                  xMax: Math.min(dayEnd.getTime(), now.getTime()),
                  backgroundColor: 'rgba(255, 255, 255, 0.07)', // 7% opacity white overlay
                  borderWidth: 0,
                })
              }
            }
          }
          
          return annotations
        })(),
      },
    },
    scales: {
      x: {
        type: 'time',
        min: windowStart.getTime(), // Show from selected time range
        max: now.getTime(), // To current time
        time: {
          unit: timeRange === '1D' ? 'hour' : 'day',
          displayFormats: {
            hour: 'HH:mm',
            day: 'MMM d', // Show month and day
          },
        },
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
          display: true,
          drawOnChartArea: true,
          drawTicks: true,
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
            lineHeight: 1.4, // Add spacing between day name and date
          },
          maxRotation: 0, // Keep labels horizontal
          minRotation: 0, // Keep labels horizontal
          align: timeRange !== '1D' ? 'start' : 'center', // Align labels to the right of the grid line in 7D/30D mode
          padding: timeRange === '30D' ? 6 : 4, // More padding for 30D to prevent collision
          autoSkip: timeRange === '1D', // Only auto-skip for 1D view
          source: 'auto', // Let Chart.js generate ticks automatically
          callback: function(value: any, index: any, ticks: any) {
            const date = new Date(value);
            if (timeRange === '30D') {
              // Dynamically adjust based on number of ticks
              // More aggressive skipping for smaller screens
              const totalDays = ticks.length;
              let skipInterval = 2; // Default: show every other day
              
              if (totalDays > 20) {
                skipInterval = 3; // Show every 3rd day
              }
              if (totalDays > 25) {
                skipInterval = 4; // Show every 4th day  
              }
              
              if (index % skipInterval !== 0) {
                // Use multiple spaces to maintain minimum width
                return '     '; // 5 spaces to prevent collision detection
              } else {
                // Show the date label
                const dayName = format(date, 'EEE'); // Mon, Tue, Wed, etc.
                const dayDate = format(date, 'd MMM'); // 30 Jun
                return [dayName, dayDate]; // Return array for multi-line label
              }
            } else if (timeRange === '7D') {
              // For 7D mode, show day name on first line and date on second line
              const dayName = format(date, 'EEE');
              const dayDate = format(date, 'd MMM');
              return [dayName, dayDate]; // Return array for multi-line label
            } else if (timeRange === '1D') {
              // For 1D mode, skip some labels to prevent collision
              if (index % 2 !== 0) {
                return '\u200B'; // Return zero-width space to keep gridline but hide label
              }
              return format(date, 'HH:mm');
            }
          },
        },
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: false, // Hide the title
        },
        // Use maxPowerHint for power mode, auto-scale for energy mode
        suggestedMax: chartData?.mode === 'energy' ? undefined : maxPowerHint,
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
          display: true,
          drawOnChartArea: true,
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          callback: function(value: any, index: any, ticks: any) {
            // Add unit only to the last (top) tick
            // Use kWh for energy mode, kW for power mode
            if (index === ticks.length - 1) {
              const unit = chartData?.mode === 'energy' ? 'kWh' : 'kW'
              return value + ' ' + unit;
            }
            return value;
          },
        },
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        title: {
          display: false, // Hide the title
        },
        grid: {
          display: true,
          drawOnChartArea: false, // Don't draw y1 grid lines on chart area to avoid overlap
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          callback: function(value: any, index: any, ticks: any) {
            // Add "%" only to the last (top) tick
            if (index === ticks.length - 1) {
              return value + '%';
            }
            return value;
          },
        },
        min: 0,
        max: 100,
      },
    },
  }), [handleHover, windowStart, now, timeRange, chartData?.mode, maxPowerHint])

  // Cleanup hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    let abortController = new AbortController()
    
    const fetchData = async () => {
      // Create a new abort controller for this specific request
      abortController = new AbortController()
      
      try {
        // Fetch will automatically include cookies
        // Use different intervals: 5m for 1D, 30m for 7D, 1d for 30D
        let requestInterval: string
        let duration: string
        
        if (timeRange === '1D') {
          requestInterval = '5m'
          duration = '25h' // 25h for 1D
        } else if (timeRange === '7D') {
          requestInterval = '30m'
          duration = '169h' // 7*24+1 for 7D
        } else { // 30D
          requestInterval = '1d'
          duration = '30d' // 30 days
        }
        
        const response = await fetch(`/api/history?interval=${requestInterval}&last=${duration}&fields=solar,load,battery&systemId=1`, {
          credentials: 'same-origin', // Include cookies
          signal: abortController.signal
        })

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Not authenticated - please log in')
          }
          throw new Error(`Failed to fetch data: ${response.status}`)
        }

        const data = await response.json()
        
        // Determine mode based on interval
        const isEnergyMode = requestInterval === '1d'
        
        // Process the data for Chart.js
        // Energy mode: use energy data; Power mode: use power data
        const solarData = isEnergyMode 
          ? data.data.find((d: any) => d.id.includes('solar.energy'))
          : data.data.find((d: any) => d.id.includes('solar.power'))
        const loadData = isEnergyMode
          ? data.data.find((d: any) => d.id.includes('load.energy'))
          : data.data.find((d: any) => d.id.includes('load.power'))
        const batteryWData = data.data.find((d: any) => d.id.includes('battery.power'))
        const batterySOCData = data.data.find((d: any) => d.id.includes(isEnergyMode ? 'battery.soc.avg' : 'battery.soc.last'))
        
        // For daily data, also get min/max SOC
        const batterySOCMinData = isEnergyMode ? data.data.find((d: any) => d.id.includes('battery.soc.min')) : null
        const batterySOCMaxData = isEnergyMode ? data.data.find((d: any) => d.id.includes('battery.soc.max')) : null

        if (!solarData || !loadData || !batterySOCData) {
          throw new Error('Missing data series')
        }

        // Parse the start time - the API returns timestamps like "2025-08-16T12:17:53+10:00"
        const startTimeString = solarData.history.start
        
        // JavaScript Date constructor handles timezone offsets correctly
        const startTime = new Date(startTimeString)
        
        // Parse the interval from the response (e.g., "5m", "1m")
        const interval = solarData.history.interval
        if (!interval) {
          throw new Error('No interval specified in API response')
        }
        
        let intervalMs: number
        
        if (interval === '1d') {
          intervalMs = 24 * 60 * 60000 // 1 day
        } else if (interval === '30m') {
          intervalMs = 30 * 60000 // 30 minutes
        } else if (interval === '5m') {
          intervalMs = 5 * 60000 // 5 minutes
        } else if (interval === '1m') {
          intervalMs = 60000 // 1 minute
        } else {
          throw new Error(`Unsupported interval: ${interval}`)
        }
        
        
        // Calculate timestamps based on start time and actual interval
        const timestamps = solarData.history.data.map((_: any, index: number) => 
          new Date(startTime.getTime() + index * intervalMs)
        )

        // Get data for selected time range
        const currentTime = new Date()
        let windowHours: number
        if (timeRange === '1D') {
          windowHours = 24
        } else if (timeRange === '7D') {
          windowHours = 24 * 7
        } else { // 30D
          windowHours = 24 * 30
        }
        const windowStart = new Date(currentTime.getTime() - windowHours * 60 * 60 * 1000)
        
        // Filter to selected time range
        const selectedIndices = timestamps
          .map((t: Date, i: number) => ({ time: t, index: i }))
          .filter(({ time }: { time: Date, index: number }) => time >= windowStart && time <= currentTime)
          .map(({ index }: { time: Date, index: number }) => index)

        setChartData({
          timestamps: selectedIndices.map((i: number) => timestamps[i]),
          solar: selectedIndices.map((i: number) => solarData.history.data[i]),
          load: selectedIndices.map((i: number) => loadData.history.data[i]),
          batteryW: selectedIndices.map((i: number) => batteryWData?.history.data[i]),
          batterySOC: selectedIndices.map((i: number) => batterySOCData.history.data[i]),
          batterySOCMin: batterySOCMinData ? selectedIndices.map((i: number) => batterySOCMinData.history.data[i]) : undefined,
          batterySOCMax: batterySOCMaxData ? selectedIndices.map((i: number) => batterySOCMaxData.history.data[i]) : undefined,
          mode: isEnergyMode ? 'energy' : 'power',
        })
        setLoading(false)
      } catch (err: any) {
        // Ignore abort errors
        if (err.name === 'AbortError') {
          console.log('[EnergyChart] Fetch aborted')
          return
        }
        console.error('Error fetching chart data:', err)
        setError(err instanceof Error ? err.message : 'Failed to load chart data')
        setLoading(false)
      }
    }

    fetchData()
    // Refresh every minute
    const interval = setInterval(fetchData, 60000)
    
    // Cleanup function
    return () => {
      clearInterval(interval)
      abortController.abort() // Cancel any pending requests
    }
  }, [timeRange])

  // For energy mode, pad the SOC data to extend the fill to chart edges
  const paddedSOCData = chartData?.mode === 'energy' && chartData.batterySOCMin && chartData.batterySOCMax
    ? (() => {
        // Get the first and last timestamps from the data
        const timestamps = [...chartData.timestamps];
        const firstTime = timestamps[0];
        const lastTime = timestamps[timestamps.length - 1];
        
        // Add padding timestamps (half day before/after to ensure coverage)
        const paddedTimestamps = [
          new Date(firstTime.getTime() - 12 * 60 * 60 * 1000), // 12 hours before
          ...timestamps,
          new Date(lastTime.getTime() + 12 * 60 * 60 * 1000)   // 12 hours after
        ];
        
        // Extend the SOC values (use the same values at edges)
        const paddedSOCMin = [
          chartData.batterySOCMin[0],
          ...chartData.batterySOCMin,
          chartData.batterySOCMin[chartData.batterySOCMin.length - 1]
        ];
        
        const paddedSOCMax = [
          chartData.batterySOCMax[0],
          ...chartData.batterySOCMax,
          chartData.batterySOCMax[chartData.batterySOCMax.length - 1]
        ];
        
        return { timestamps: paddedTimestamps, min: paddedSOCMin, max: paddedSOCMax };
      })()
    : null;

  const data: any = !chartData ? {} : chartData.mode === 'energy' ? {
    // Energy mode: Use bar chart data structure
    labels: chartData.timestamps,
    datasets: [
      {
        label: 'Solar',
        data: chartData.solar, // Already in kWh for energy mode
        backgroundColor: 'rgb(250, 204, 21)', // yellow-400 solid
        borderWidth: 0, // No border
        yAxisID: 'y',
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      {
        label: 'Load',
        data: chartData.load, // Already in kWh for energy mode
        backgroundColor: 'rgb(96, 165, 250)', // blue-400 solid
        borderWidth: 0, // No border
        yAxisID: 'y',
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      // Add SOC range area if we have min/max data
      ...(paddedSOCData ? [{
        label: 'Battery SOC Range',
        type: 'line' as const,
        labels: paddedSOCData.timestamps,
        data: paddedSOCData.timestamps.map((t, i) => ({ x: t, y: paddedSOCData.max[i] })), // Upper boundary with padding
        borderColor: 'transparent',
        backgroundColor: 'rgba(74, 222, 128, 0.3)', // green-400 with 30% opacity
        yAxisID: 'y1',
        tension: 0.4, // Nice curved splines
        borderWidth: 0,
        pointRadius: 0, // No dots
        pointHoverRadius: 0, // No dots on hover
        pointHitRadius: 0, // No hit area for points
        fill: '+1', // Fill to next dataset (min line)
        showLine: true,
        clip: false, // Don't clip at chart edges
        order: 10, // Higher number = drawn first (behind everything)
      },
      {
        label: '', // No label for min line (hidden from legend)
        type: 'line' as const,
        labels: paddedSOCData.timestamps,
        data: paddedSOCData.timestamps.map((t, i) => ({ x: t, y: paddedSOCData.min[i] })), // Lower boundary with padding
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        yAxisID: 'y1',
        tension: 0.4, // Nice curved splines
        borderWidth: 0,
        pointRadius: 0, // No dots
        pointHoverRadius: 0, // No dots on hover
        pointHitRadius: 0, // No hit area for points
        fill: false,
        showLine: true,
        clip: false, // Don't clip at chart edges
        order: 10, // Higher number = drawn first (behind everything)
      }] : []),
      {
        label: 'Battery SOC',
        type: 'line' as const, // Keep SOC as line even in bar chart
        data: chartData.batterySOC, // Already in percentage
        borderColor: 'rgb(74, 222, 128)', // green-400
        backgroundColor: 'rgb(74, 222, 128)', // Solid color for legend
        yAxisID: 'y1',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
        order: -1, // Negative number = drawn last (on top of everything)
      },
    ],
  } : {
    // Power mode: Use line chart data structure
    labels: chartData.timestamps,
    datasets: [
      {
        label: 'Solar',
        data: chartData.solar.map(w => w === null ? null : w / 1000), // Convert W to kW for power mode
        borderColor: 'rgb(250, 204, 21)', // yellow-400
        backgroundColor: 'rgb(250, 204, 21)', // Solid color for legend
        yAxisID: 'y',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
      },
      {
        label: 'Load',
        data: chartData.load.map(w => w === null ? null : w / 1000), // Convert W to kW for power mode
        borderColor: 'rgb(96, 165, 250)', // blue-400
        backgroundColor: 'rgb(96, 165, 250)', // Solid color for legend
        yAxisID: 'y',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
      },
      {
        label: 'Battery SOC',
        data: chartData.batterySOC, // Already in percentage
        borderColor: 'rgb(74, 222, 128)', // green-400
        backgroundColor: 'rgb(74, 222, 128)', // Solid color for legend
        yAxisID: 'y1',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
      },
    ],
  }

  // Format timestamp based on time range
  const formatHoverTimestamp = (date: Date | null, isMobile: boolean = false) => {
    if (!date) return '';
    
    if (timeRange === '30D') {
      // For 30D view, show date only
      // Mobile: "Fri, 22 Aug" / Desktop: "Fri, 22 Aug 2024"
      return format(date, isMobile ? 'EEE, d MMM' : 'EEE, d MMM yyyy');
    } else if (timeRange === '7D') {
      // For 7D view, show date and time
      // Mobile: "Fri, 22 Aug 11:58PM" / Desktop: "Fri, 22 Aug 2024 11:58PM"
      return format(date, isMobile ? 'EEE, d MMM h:mma' : 'EEE, d MMM yyyy h:mma');
    } else {
      // For 1D view, show time only (e.g., "11:58PM")
      return format(date, 'h:mma');
    }
  };

  // Render the chart content based on state
  const renderChartContent = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">Loading chart...</div>
        </div>
      );
    }

    if (error || !chartData) {
      return (
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-red-400">Error: {error || 'No data available'}</div>
        </div>
      );
    }

    // Normal chart display
    return (
      <>
        <div className="flex-1 min-h-0">
          {chartData.mode === 'energy' ? (
            <Bar ref={chartRef} data={data} options={options} />
          ) : (
            <Line ref={chartRef} data={data} options={options} />
          )}
        </div>
        <div className="flex justify-center mt-2">
          <ChartTooltip
            solar={hoveredData.solar}
            load={hoveredData.load}
            batterySOC={hoveredData.batterySOC}
            unit={chartData?.mode === 'energy' ? 'kWh' : 'kW'}
            visible={true}
          />
        </div>
      </>
    );
  };

  return (
    <div className={`md:bg-gray-800 md:border md:border-gray-700 md:rounded py-1 px-0 md:p-4 flex flex-col ${className}`}>
      <div className="flex justify-between items-center mb-1 md:mb-2 px-1 md:px-0">
        <h3 className="text-sm font-semibold text-white" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>Daylesford</h3>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:block text-xs text-gray-400 min-w-[200px] text-right whitespace-nowrap" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
            {formatHoverTimestamp(hoveredData.timestamp)}
          </span>
          <span className="sm:hidden text-xs text-gray-400 text-right whitespace-nowrap" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
            {formatHoverTimestamp(hoveredData.timestamp, true)}
          </span>
          <PeriodSwitcher 
            value={timeRange} 
            onChange={setTimeRange}
          />
        </div>
      </div>
      {renderChartContent()}
    </div>
  )
}