'use client'

import { SeriesData } from './MondoPowerChart'

interface EnergyTableProps {
  chartData: {
    timestamps: Date[]
    series: SeriesData[]
    mode: 'power' | 'energy'
  } | null
  mode: 'load' | 'generation'
  hoveredIndex?: number | null  // Index of the hovered data point
  className?: string
}

export default function EnergyTable({ chartData, mode, hoveredIndex, className = '' }: EnergyTableProps) {
  if (!chartData || chartData.series.length === 0) {
    return (
      <div className={`bg-gray-800 rounded-lg p-4 ${className}`}>
        <div className="text-gray-500 text-center">No data</div>
      </div>
    )
  }

  // Use hovered index if available, otherwise use the latest
  const dataIndex = hoveredIndex !== null && hoveredIndex !== undefined ? hoveredIndex : chartData.timestamps.length - 1

  // Build table data from series - maintain consistent order from chart
  const tableData = chartData.series
    .map(series => ({
      label: series.description,
      value: series.data[dataIndex], // Can be null or a number (already in kW)
      color: series.color
    }))
    // Keep the original order from the chart configuration - no sorting

  // Calculate totals (only sum non-null values)
  let total: number | null = null
  let hasAnyValue = false

  tableData.forEach(item => {
    if (item.value !== null && item.value !== undefined) {
      hasAnyValue = true
      total = (total ?? 0) + item.value
    }
  })

  // If all values are null, total should be null
  if (!hasAnyValue) {
    total = null
  }

  const formatValue = (value: number | null | undefined) => {
    if (value === null || value === undefined) return '—' // Show dash for no data
    return value.toFixed(1) + ' kW'
  }

  const formatPercentage = (value: number | null | undefined, total: number | null) => {
    if (value === null || value === undefined || total === null || total === 0) return '—'
    const percentage = (value / total) * 100
    return percentage.toFixed(0) + '%'
  }

  return (
    <div className={`bg-gray-800 rounded-lg p-4 ${className}`}>
      <div className="space-y-4">
        {/* Title */}
        <div className="border-b border-gray-700 pb-2">
          <div className="text-xs text-gray-400">
            {mode === 'load' ? 'Load Breakdown' : 'Generation Sources'}
          </div>
        </div>

        {/* Column Headers */}
        <div className="flex items-center text-xs border-b border-gray-700 pb-1">
          <div className="flex-1 text-gray-500">Source</div>
          <div className="w-16 text-right text-gray-500">Power</div>
          <div className="w-12 text-right text-gray-500">%</div>
        </div>

        {/* Items */}
        <div className="space-y-1">
          {tableData.map((item) => (
            <div key={item.label} className="flex items-center text-xs">
              <div className="flex items-center gap-2 flex-1">
                <div
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: item.color }}
                />
                <span className="text-gray-300">{item.label}</span>
              </div>
              <span className="text-gray-100 font-mono w-16 text-right">
                {formatValue(item.value)}
              </span>
              <span className="text-gray-400 font-mono w-12 text-right">
                {formatPercentage(item.value, total)}
              </span>
            </div>
          ))}
        </div>

        {/* Total */}
        <div className="border-t border-gray-700 pt-2">
          <div className="flex items-center text-sm">
            <span className="text-gray-300 font-medium flex-1">Total</span>
            <span className="text-gray-100 font-mono font-medium w-16 text-right">
              {formatValue(total)}
            </span>
            <span className="text-gray-400 font-mono font-medium w-12 text-right">
              {total !== null ? '100%' : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}