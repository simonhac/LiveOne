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
}

interface ChartData {
  timestamps: Date[]
  solar: number[]
  load: number[]
  batteryPower: number[]
  batterySOC: number[]
}

export default function EnergyChart({ className = '' }: EnergyChartProps) {
  const [chartData, setChartData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Get the authentication token from session storage
        const password = sessionStorage.getItem('password') || 'password'
        
        const response = await fetch('/api/history?interval=1m&fields=solar,load,battery', {
          headers: {
            'Authorization': `Bearer ${password}`
          }
        })

        if (!response.ok) {
          throw new Error('Failed to fetch data')
        }

        const data = await response.json()
        
        // Process the data for Chart.js
        const solarData = data.data.find((d: any) => d.id.includes('solar.power'))
        const loadData = data.data.find((d: any) => d.id.includes('load.power'))
        const batteryPowerData = data.data.find((d: any) => d.id.includes('battery.power'))
        const batterySOCData = data.data.find((d: any) => d.id.includes('battery.soc'))

        if (!solarData || !loadData || !batteryPowerData || !batterySOCData) {
          throw new Error('Missing data series')
        }

        // Calculate timestamps based on start time and interval
        const startTime = new Date(solarData.history.start)
        const timestamps = solarData.history.data.map((_: any, index: number) => 
          new Date(startTime.getTime() + index * 60000) // 1 minute intervals
        )

        // Get last 24 hours of data
        const now = new Date()
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        const last24HoursIndices = timestamps
          .map((t, i) => ({ time: t, index: i }))
          .filter(({ time }) => time >= twentyFourHoursAgo)
          .map(({ index }) => index)

        setChartData({
          timestamps: last24HoursIndices.map(i => timestamps[i]),
          solar: last24HoursIndices.map(i => solarData.history.data[i]),
          load: last24HoursIndices.map(i => loadData.history.data[i]),
          batteryPower: last24HoursIndices.map(i => batteryPowerData.history.data[i]),
          batterySOC: last24HoursIndices.map(i => batterySOCData.history.data[i]),
        })
        setLoading(false)
      } catch (err) {
        console.error('Error fetching chart data:', err)
        setError(err instanceof Error ? err.message : 'Failed to load chart data')
        setLoading(false)
      }
    }

    fetchData()
    // Refresh every minute
    const interval = setInterval(fetchData, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
        <h3 className="text-sm font-semibold text-white mb-2">Last 24 Hours</h3>
        <div className="flex-1 flex items-center justify-center min-h-0">
          <div className="text-gray-500">Loading chart...</div>
        </div>
      </div>
    )
  }

  if (error || !chartData) {
    return (
      <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
        <h3 className="text-sm font-semibold text-white mb-2">Last 24 Hours</h3>
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
        data: chartData.solar.map(w => w / 1000), // Convert W to kW
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
        data: chartData.load.map(w => w / 1000), // Convert W to kW
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
        data: chartData.batterySOC,
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
          
          // Create daytime background regions
          for (let i = 0; i < chartData.timestamps.length - 1; i++) {
            const currentTime = chartData.timestamps[i]
            const nextTime = chartData.timestamps[i + 1]
            const currentHour = currentTime.getHours()
            const nextHour = nextTime.getHours()
            
            // Check if we're entering daytime (7am)
            if (currentHour < 7 && nextHour >= 7) {
              const dayStart = new Date(currentTime)
              dayStart.setHours(7, 0, 0, 0)
              
              // Find where daytime ends (10pm) or data ends
              let dayEnd = new Date(currentTime)
              dayEnd.setHours(22, 0, 0, 0)
              
              // Make sure we don't go past the data range
              if (dayEnd > chartData.timestamps[chartData.timestamps.length - 1]) {
                dayEnd = chartData.timestamps[chartData.timestamps.length - 1]
              }
              
              annotations.push({
                type: 'box',
                xMin: dayStart,
                xMax: dayEnd,
                backgroundColor: 'rgba(255, 255, 255, 0.1)', // 10% opacity white overlay
                borderWidth: 0,
              })
            }
            
            // Check if we span midnight and need another daytime region
            if (currentHour >= 22 && nextHour < 7 && i < chartData.timestamps.length - 2) {
              const nextDayStart = new Date(nextTime)
              nextDayStart.setDate(nextDayStart.getDate() + (nextHour < 7 ? 0 : 1))
              nextDayStart.setHours(7, 0, 0, 0)
              
              let nextDayEnd = new Date(nextDayStart)
              nextDayEnd.setHours(22, 0, 0, 0)
              
              if (nextDayEnd > chartData.timestamps[chartData.timestamps.length - 1]) {
                nextDayEnd = chartData.timestamps[chartData.timestamps.length - 1]
              }
              
              if (nextDayStart < chartData.timestamps[chartData.timestamps.length - 1]) {
                annotations.push({
                  type: 'box',
                  xMin: nextDayStart,
                  xMax: nextDayEnd,
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderWidth: 0,
                })
              }
            }
          }
          
          // If the first timestamp is already in daytime
          if (chartData.timestamps[0].getHours() >= 7 && chartData.timestamps[0].getHours() < 22) {
            let dayEnd = new Date(chartData.timestamps[0])
            dayEnd.setHours(22, 0, 0, 0)
            
            if (dayEnd > chartData.timestamps[chartData.timestamps.length - 1]) {
              dayEnd = chartData.timestamps[chartData.timestamps.length - 1]
            }
            
            annotations.push({
              type: 'box',
              xMin: chartData.timestamps[0],
              xMax: dayEnd,
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 0,
            })
          }
          
          return annotations
        })(),
      },
    },
    scales: {
      x: {
        type: 'time',
        time: {
          unit: 'hour',
          stepSize: 2, // Show every 2 hours
          displayFormats: {
            hour: 'HH:mm',
          },
        },
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
          drawBorder: false,
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
          display: true,
          text: 'kW',
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 11,
            family: 'DM Sans, system-ui, sans-serif',
            weight: 700,
          },
        },
        grid: {
          color: 'rgb(55, 65, 81)', // gray-700
          drawBorder: false,
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
        },
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        title: {
          display: true,
          text: '%',
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 11,
            family: 'DM Sans, system-ui, sans-serif',
            weight: 700,
          },
        },
        grid: {
          drawOnChartArea: false,
          drawBorder: false,
        },
        ticks: {
          color: 'rgb(156, 163, 175)', // gray-400
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
        },
        min: 0,
        max: 100,
      },
    },
  }

  return (
    <div className={`bg-gray-800 border border-gray-700 rounded p-4 flex flex-col ${className}`}>
      <h3 className="text-sm font-semibold text-white mb-2">Last 24 Hours</h3>
      <div className="flex-1 min-h-0">
        <Line data={data} options={options} />
      </div>
    </div>
  )
}