'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import PeriodSwitcher from './PeriodSwitcher'
import ServerErrorModal from './ServerErrorModal'
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

interface MondoPowerChartProps {
  className?: string
  systemId: number
  mode: 'load' | 'generation'
  title: string
  initialPeriod?: '1D' | '7D' | '30D'
  period?: '1D' | '7D' | '30D' // External period control
  onPeriodChange?: (period: '1D' | '7D' | '30D') => void
  showPeriodSwitcher?: boolean
}

interface SeriesData {
  id: string
  description: string
  data: (number | null)[]
  color: string
}

interface ChartData {
  timestamps: Date[]
  series: SeriesData[]
  mode: 'power' | 'energy'
}

// Color palette for series
const COLORS = [
  'rgb(250, 204, 21)',  // yellow-400
  'rgb(96, 165, 250)',  // blue-400
  'rgb(74, 222, 128)',  // green-400
  'rgb(251, 146, 60)',  // orange-400
  'rgb(168, 85, 247)',  // purple-400
  'rgb(236, 72, 153)',  // pink-400
  'rgb(34, 211, 238)',  // cyan-400
  'rgb(251, 191, 36)',  // amber-400
]

export default function MondoPowerChart({
  className = '',
  systemId,
  mode,
  title,
  initialPeriod,
  period: externalPeriod,
  onPeriodChange,
  showPeriodSwitcher = true
}: MondoPowerChartProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [chartData, setChartData] = useState<ChartData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<{ type: 'connection' | 'server' | null, details?: string }>({ type: null })

  const getInitialTimeRange = () => {
    const urlPeriod = searchParams.get('period') as '1D' | '7D' | '30D' | null
    if (urlPeriod && ['1D', '7D', '30D'].includes(urlPeriod)) {
      return urlPeriod
    }
    return initialPeriod || '1D'
  }

  const [internalTimeRange, setInternalTimeRange] = useState<'1D' | '7D' | '30D'>(getInitialTimeRange())

  // Use external period if provided, otherwise use internal state
  const timeRange = externalPeriod || internalTimeRange
  const [hoveredTimestamp, setHoveredTimestamp] = useState<Date | null>(null)
  const chartRef = useRef<any>(null)

  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleHover = useCallback((event: any, activeElements: any[], chart: any) => {
    if (!chartData) return

    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }

    hoverTimeoutRef.current = setTimeout(() => {
      if (activeElements && activeElements.length > 0) {
        const dataIndex = activeElements[0].index
        const timestamp = chartData.timestamps[dataIndex]
        setHoveredTimestamp(timestamp)
      } else {
        setHoveredTimestamp(null)
      }
    }, 10)
  }, [chartData])

  const { now, windowStart } = useMemo(() => {
    const now = new Date()
    let windowHours: number
    if (timeRange === '1D') {
      windowHours = 24
    } else if (timeRange === '7D') {
      windowHours = 24 * 7
    } else {
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
        display: true,
        position: 'bottom' as const,
        labels: {
          color: 'rgb(156, 163, 175)',
          font: {
            size: 11,
            family: 'DM Sans, system-ui, sans-serif',
          },
          padding: 10,
          usePointStyle: true,
          pointStyle: 'rect',
        },
      },
      tooltip: {
        enabled: true,
        mode: 'index' as const,
        intersect: false,
        backgroundColor: 'rgba(31, 41, 55, 0.95)',
        titleColor: 'rgb(229, 231, 235)',
        bodyColor: 'rgb(209, 213, 219)',
        borderColor: 'rgb(75, 85, 99)',
        borderWidth: 1,
        padding: 12,
        displayColors: true,
        callbacks: {
          label: function(context: any) {
            const label = context.dataset.label || ''
            const value = context.raw as number
            if (value === null) return null
            return `${label}: ${value.toFixed(1)} kW`
          }
        }
      },
      annotation: {
        annotations: (() => {
          const annotations: any[] = []

          if (timeRange === '30D') {
            const daysToShow = 31
            for (let i = 0; i < daysToShow; i++) {
              const day = new Date(now)
              day.setDate(day.getDate() - i)
              day.setHours(0, 0, 0, 0)

              const dayOfWeek = day.getDay()

              if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                const dayEnd = new Date(day)
                dayEnd.setHours(23, 59, 59, 999)

                if (dayEnd > windowStart && day < now) {
                  annotations.push({
                    type: 'box',
                    xMin: Math.max(day.getTime(), windowStart.getTime()),
                    xMax: Math.min(dayEnd.getTime(), now.getTime()),
                    backgroundColor: 'rgba(255, 255, 255, 0.07)',
                    borderWidth: 0,
                  })
                }
              }
            }
          } else {
            const daysToShow = timeRange === '1D' ? 2 : 8
            for (let i = 0; i < daysToShow; i++) {
              const dayStart = new Date(now)
              dayStart.setDate(dayStart.getDate() - i)
              dayStart.setHours(7, 0, 0, 0)

              const dayEnd = new Date(now)
              dayEnd.setDate(dayEnd.getDate() - i)
              dayEnd.setHours(22, 0, 0, 0)

              if (dayEnd > windowStart && dayStart < now) {
                annotations.push({
                  type: 'box',
                  xMin: Math.max(dayStart.getTime(), windowStart.getTime()),
                  xMax: Math.min(dayEnd.getTime(), now.getTime()),
                  backgroundColor: 'rgba(255, 255, 255, 0.07)',
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
        min: windowStart.getTime(),
        max: now.getTime(),
        time: {
          unit: timeRange === '1D' ? 'hour' : 'day',
          displayFormats: {
            hour: 'HH:mm',
            day: 'MMM d',
          },
        },
        grid: {
          color: 'rgb(55, 65, 81)',
          display: true,
          drawOnChartArea: true,
          drawTicks: true,
        },
        ticks: {
          color: 'rgb(156, 163, 175)',
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
            lineHeight: 1.4,
          },
          maxRotation: 0,
          minRotation: 0,
          align: timeRange !== '1D' ? 'start' : 'center',
          padding: timeRange === '30D' ? 6 : 4,
          autoSkip: timeRange === '1D',
          source: 'auto',
          callback: function(value: any, index: any, ticks: any) {
            const date = new Date(value);
            if (timeRange === '30D') {
              const totalDays = ticks.length;
              let skipInterval = 2;

              if (totalDays > 20) skipInterval = 3;
              if (totalDays > 25) skipInterval = 4;

              if (index % skipInterval !== 0) {
                return '     ';
              } else {
                const dayName = format(date, 'EEE');
                const dayDate = format(date, 'd MMM');
                return [dayName, dayDate];
              }
            } else if (timeRange === '7D') {
              const dayName = format(date, 'EEE');
              const dayDate = format(date, 'd MMM');
              return [dayName, dayDate];
            } else if (timeRange === '1D') {
              if (index % 2 !== 0) {
                return '\u200B';
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
        stacked: true,
        title: {
          display: false,
        },
        min: 0,
        grid: {
          color: 'rgb(55, 65, 81)',
          display: true,
          drawOnChartArea: true,
        },
        ticks: {
          color: 'rgb(156, 163, 175)',
          font: {
            size: 10,
            family: 'DM Sans, system-ui, sans-serif',
          },
          callback: function(value: any, index: any, ticks: any) {
            if (index === ticks.length - 1) {
              return value + ' kW';
            }
            return value;
          },
        },
      },
    },
  }), [handleHover, windowStart, now, timeRange])

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
      abortController = new AbortController()

      try {
        let requestInterval: string
        let duration: string

        if (timeRange === '1D') {
          requestInterval = '5m'
          duration = '25h'
        } else if (timeRange === '7D') {
          requestInterval = '30m'
          duration = '169h'
        } else {
          requestInterval = '1d'
          duration = '30d'
        }

        const response = await fetch(`/api/history?interval=${requestInterval}&last=${duration}&systemId=${systemId.toString()}`, {
          credentials: 'same-origin',
          signal: abortController.signal
        })

        if (!response.ok) {
          const contentType = response.headers.get('content-type')
          if (contentType && !contentType.includes('application/json')) {
            throw new Error('Session expired - please refresh the page')
          }
          if (response.status === 401) {
            throw new Error('Not authenticated - please log in')
          }
          throw new Error(`Failed to fetch data: ${response.status}`)
        }

        const data = await response.json()

        const isEnergyMode = requestInterval === '1d'

        // Filter to only power series
        const powerSeries = data.data.filter((d: any) => d.type === 'power')

        // Further filter based on mode
        const filteredSeries = powerSeries.filter((series: any) => {
          const desc = series.description.toLowerCase()
          if (mode === 'load') {
            // Load series: Tesla, Heat Pump, Pool, HVAC
            return desc.includes('tesla') ||
                   desc.includes('heat pump') ||
                   desc.includes('pool') ||
                   desc.includes('hvac')
          } else {
            // Generation series: Solar, Battery, Meter
            return desc.includes('solar') ||
                   desc.includes('battery') ||
                   desc.includes('meter')
          }
        })

        if (filteredSeries.length === 0) {
          throw new Error('No data series available')
        }

        // Get first series to extract timestamps
        const firstSeries = filteredSeries[0]
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
        if (timeRange === '1D') {
          windowHours = 24
        } else if (timeRange === '7D') {
          windowHours = 24 * 7
        } else {
          windowHours = 24 * 30
        }
        const windowStart = new Date(currentTime.getTime() - windowHours * 60 * 60 * 1000)

        const selectedIndices = timestamps
          .map((t: Date, i: number) => ({ time: t, index: i }))
          .filter(({ time }: { time: Date, index: number }) => time >= windowStart && time <= currentTime)
          .map(({ index }: { time: Date, index: number }) => index)

        // Build series data with colors
        const seriesData: SeriesData[] = filteredSeries.map((series: any, idx: number) => ({
          id: series.id,
          description: series.description,
          data: selectedIndices.map((i: number) => series.history.data[i]),
          color: COLORS[idx % COLORS.length]
        }))

        setChartData({
          timestamps: selectedIndices.map((i: number) => timestamps[i]),
          series: seriesData,
          mode: isEnergyMode ? 'energy' : 'power',
        })
        setLoading(false)
      } catch (err: any) {
        if (err.name === 'AbortError') {
          return
        }
        console.error('Error fetching chart data:', err)

        if (err instanceof TypeError && err.message === 'Failed to fetch') {
          setServerError({ type: 'connection' })
          setError('Unable to connect to server')
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load chart data')
        }
        setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 60000)

    return () => {
      clearInterval(interval)
      abortController.abort()
    }
  }, [timeRange, systemId, mode])

  const data: any = !chartData ? {} : {
    labels: chartData.timestamps,
    datasets: chartData.series.map((series, idx) => ({
      label: series.description,
      data: series.data.map(w => w === null ? null : w / 1000), // Convert W to kW
      borderColor: series.color,
      backgroundColor: series.color, // Use solid color, not transparent
      yAxisID: 'y',
      tension: 0.1,
      borderWidth: 2,
      pointRadius: 0,
      fill: 'stack', // Fill according to stack configuration
      stack: 'stack0', // Ensure all datasets stack together
      order: idx,
    })),
  }

  const formatHoverTimestamp = (date: Date | null, isMobile: boolean = false) => {
    if (!date) return '';

    if (timeRange === '30D') {
      return format(date, isMobile ? 'EEE, d MMM' : 'EEE, d MMM yyyy');
    } else if (timeRange === '7D') {
      return format(date, isMobile ? 'EEE, d MMM h:mma' : 'EEE, d MMM yyyy h:mma');
    } else {
      return format(date, 'h:mma');
    }
  };

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

    return (
      <div className="flex-1 min-h-0">
        <Line ref={chartRef} data={data} options={options} />
      </div>
    );
  };

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex justify-between items-center mb-2 md:mb-3 px-1 md:px-0">
        <h3 className="text-sm font-medium text-gray-300">{title}</h3>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:block text-xs text-gray-400 min-w-[200px] text-right whitespace-nowrap" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
            {formatHoverTimestamp(hoveredTimestamp)}
          </span>
          <span className="sm:hidden text-xs text-gray-400 text-right whitespace-nowrap" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
            {formatHoverTimestamp(hoveredTimestamp, true)}
          </span>
          {showPeriodSwitcher && (
            <PeriodSwitcher
              value={timeRange}
              onChange={(newPeriod) => {
                if (onPeriodChange) {
                  onPeriodChange(newPeriod)
                } else {
                  setInternalTimeRange(newPeriod)
                  const params = new URLSearchParams(searchParams.toString())
                  params.set('period', newPeriod)
                  router.push(`?${params.toString()}`, { scroll: false })
                }
              }}
            />
          )}
        </div>
      </div>
      {renderChartContent()}

      <ServerErrorModal
        isOpen={serverError.type !== null}
        onClose={() => setServerError({ type: null })}
        errorType={serverError.type}
        errorDetails={serverError.details}
      />
    </div>
  )
}
