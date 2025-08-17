'use client'

import { useEffect, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  ChartOptions,
  Filler,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { format } from 'date-fns'
import 'chartjs-adapter-date-fns'
import annotationPlugin from 'chartjs-plugin-annotation'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
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
}

export default function EnergyChart({ className = '', maxPowerHint }: EnergyChartProps) {
  const [chartData, setChartData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'1D' | '7D'>('1D')
  

  useEffect(() => {
    let abortController = new AbortController()
    
    const fetchData = async () => {
      // Create a new abort controller for this specific request
      abortController = new AbortController()
      
      try {
        // Fetch will automatically include cookies
        // Use different intervals: 5m for 1D, 30m for 7D
        const requestInterval = timeRange === '1D' ? '5m' : '30m'
        const duration = timeRange === '1D' ? '25h' : '169h' // 25h for 1D, 7*24+1 for 7D
        const response = await fetch(`/api/history?interval=${requestInterval}&last=${duration}&fields=solar,load,battery`, {
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
        
        // Process the data for Chart.js
        const solarData = data.data.find((d: any) => d.id.includes('solar.power'))
        const loadData = data.data.find((d: any) => d.id.includes('load.power'))
        const batteryWData = data.data.find((d: any) => d.id.includes('battery.power'))
        const batterySOCData = data.data.find((d: any) => d.id.includes('battery.soc'))

        if (!solarData || !loadData || !batteryWData || !batterySOCData) {
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
        
        if (interval === '30m') {
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
        const now = new Date()
        const windowStart = new Date(now.getTime() - (timeRange === '1D' ? 24 : 24 * 7) * 60 * 60 * 1000)
        
        // Filter to selected time range
        const selectedIndices = timestamps
          .map((t: Date, i: number) => ({ time: t, index: i }))
          .filter(({ time }: { time: Date, index: number }) => time >= windowStart)
          .map(({ index }: { time: Date, index: number }) => index)

        setChartData({
          timestamps: selectedIndices.map((i: number) => timestamps[i]),
          solar: selectedIndices.map((i: number) => solarData.history.data[i]),
          load: selectedIndices.map((i: number) => loadData.history.data[i]),
          batteryW: selectedIndices.map((i: number) => batteryWData.history.data[i]),
          batterySOC: selectedIndices.map((i: number) => batterySOCData.history.data[i]),
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

  if (loading) {
    return (
      <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-semibold text-white">Energy History</h3>
          <div className="inline-flex rounded-md shadow-sm" role="group">
            <button
              onClick={() => setTimeRange('1D')}
              className={`px-3 py-1 text-xs font-medium rounded-l-md border transition-colors ${
                timeRange === '1D' 
                  ? 'bg-blue-600 text-white border-blue-600' 
                  : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
              }`}
            >
              1D
            </button>
            <button
              onClick={() => setTimeRange('7D')}
              className={`px-3 py-1 text-xs font-medium rounded-r-md border-t border-r border-b transition-colors ${
                timeRange === '7D' 
                  ? 'bg-blue-600 text-white border-blue-600' 
                  : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
              }`}
            >
              7D
            </button>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">Loading chart...</div>
        </div>
      </div>
    )
  }

  if (error || !chartData) {
    return (
      <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-semibold text-white">Energy History</h3>
          <div className="inline-flex rounded-md shadow-sm" role="group">
            <button
              onClick={() => setTimeRange('1D')}
              className={`px-3 py-1 text-xs font-medium rounded-l-md border transition-colors ${
                timeRange === '1D' 
                  ? 'bg-blue-600 text-white border-blue-600' 
                  : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
              }`}
            >
              1D
            </button>
            <button
              onClick={() => setTimeRange('7D')}
              className={`px-3 py-1 text-xs font-medium rounded-r-md border-t border-r border-b transition-colors ${
                timeRange === '7D' 
                  ? 'bg-blue-600 text-white border-blue-600' 
                  : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
              }`}
            >
              7D
            </button>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-red-400">Error: {error || 'No data available'}</div>
        </div>
      </div>
    )
  }

  const data = {
    labels: chartData.timestamps,
    datasets: [
      {
        label: 'Solar',
        data: chartData.solar.map(w => w === null ? null : w / 1000), // Convert W to kW, preserve nulls
        borderColor: 'rgb(250, 204, 21)', // yellow-400
        backgroundColor: 'rgb(250, 204, 21)', // Solid color for legend
        yAxisID: 'y',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
        spanGaps: false, // Don't connect lines across null values
      },
      {
        label: 'Load',
        data: chartData.load.map(w => w === null ? null : w / 1000), // Convert W to kW, preserve nulls
        borderColor: 'rgb(96, 165, 250)', // blue-400
        backgroundColor: 'rgb(96, 165, 250)', // Solid color for legend
        yAxisID: 'y',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
        spanGaps: false, // Don't connect lines across null values
      },
      {
        label: 'Battery SOC',
        data: chartData.batterySOC, // Already in percentage, may contain nulls
        borderColor: 'rgb(74, 222, 128)', // green-400
        backgroundColor: 'rgb(74, 222, 128)', // Solid color for legend
        yAxisID: 'y1',
        tension: 0.1,
        borderWidth: 2,
        pointRadius: 0,
        fill: false, // Don't fill under the line
        spanGaps: false, // Don't connect lines across null values
      },
    ],
  }

  // Calculate the time window for x-axis
  const now = new Date()
  const windowStart = new Date(now.getTime() - (timeRange === '1D' ? 24 : 24 * 7) * 60 * 60 * 1000)

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          color: 'rgb(209, 213, 219)', // gray-300
          usePointStyle: false, // Use box style instead of point style
          padding: 10,
          font: {
            size: 11,
            family: 'DM Sans, system-ui, sans-serif',
          },
          boxWidth: 12, // Small square size
          boxHeight: 12, // Make it square
        },
      },
      tooltip: {
        backgroundColor: 'rgb(31, 41, 55)', // gray-800
        titleColor: 'rgb(209, 213, 219)', // gray-300
        bodyColor: 'rgb(209, 213, 219)', // gray-300
        borderColor: 'rgb(75, 85, 99)', // gray-600
        borderWidth: 1,
        titleFont: {
          family: 'DM Sans, system-ui, sans-serif',
        },
        bodyFont: {
          family: 'DM Sans, system-ui, sans-serif',
        },
        callbacks: {
          title: (context) => {
            const date = new Date(context[0].parsed.x)
            return format(date, 'MMM d, HH:mm')
          },
          label: (context) => {
            let label = context.dataset.label || ''
            if (label) {
              label += ': '
            }
            if (context.parsed.y !== null) {
              if (context.dataset.yAxisID === 'y') {
                label += `${context.parsed.y.toFixed(2)} kW`
              } else {
                label += `${context.parsed.y.toFixed(1)}%`
              }
            }
            return label
          },
        },
      },
      annotation: {
        annotations: (() => {
          const annotations: any[] = []
          
          // Create daytime background regions based on the time window
          // Add daytime regions for each day in the window
          const daysToShow = timeRange === '1D' ? 2 : 8 // Show 2 days for 1D view, 8 days for 7D
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
          unit: 'hour',
          displayFormats: {
            hour: 'HH:mm',
          },
        },
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          autoSkip: true,
          maxRotation: 0, // Keep labels horizontal
          minRotation: 0, // Keep labels horizontal
        },
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: false, // Hide the title
        },
        // Use maxPowerHint as suggested max, but allow chart to scale higher if needed
        suggestedMax: maxPowerHint,
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          callback: function(value, index, ticks) {
            // Add " kW" only to the last (top) tick
            if (index === ticks.length - 1) {
              return value + ' kW';
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
          drawOnChartArea: false,
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          callback: function(value, index, ticks) {
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
  }

  return (
    <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-semibold text-white">Energy History</h3>
        <div className="inline-flex rounded-md shadow-sm" role="group">
          <button
            onClick={() => setTimeRange('1D')}
            className={`px-3 py-1 text-xs font-medium rounded-l-md border transition-colors ${
              timeRange === '1D' 
                ? 'bg-blue-600 text-white border-blue-600' 
                : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
            }`}
          >
            1D
          </button>
          <button
            onClick={() => setTimeRange('7D')}
            className={`px-3 py-1 text-xs font-medium rounded-r-md border-t border-r border-b transition-colors ${
              timeRange === '7D' 
                ? 'bg-blue-600 text-white border-blue-600' 
                : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600 hover:text-gray-300'
            }`}
          >
            7D
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Line data={data} options={options} />
      </div>
    </div>
  )
}