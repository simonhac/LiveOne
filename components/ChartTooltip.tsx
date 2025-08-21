import React from 'react'

interface ChartTooltipProps {
  solar: number | null
  load: number | null
  batterySOC: number | null
  unit: 'kW' | 'kWh'
  visible: boolean
}

export default function ChartTooltip({ solar, load, batterySOC, unit, visible }: ChartTooltipProps) {
  return (
    <div className="flex items-center gap-10 text-xs">
      {/* Solar */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-yellow-400"></span>
        <span className="text-gray-400">Solar</span>
        <span style={{ minWidth: '3.5rem', display: 'inline-flex', gap: '0.125rem', justifyContent: 'flex-end' }}>
          {solar !== null ? (
            <>
              <span className="text-white" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {solar.toFixed(1)}
              </span>
              <span className="text-gray-400">{unit}</span>
            </>
          ) : null}
        </span>
      </div>
      
      {/* Load */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-blue-400"></span>
        <span className="text-gray-400">Load</span>
        <span style={{ minWidth: '3.5rem', display: 'inline-flex', gap: '0.125rem', justifyContent: 'flex-end' }}>
          {load !== null ? (
            <>
              <span className="text-white" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {load.toFixed(1)}
              </span>
              <span className="text-gray-400">{unit}</span>
            </>
          ) : null}
        </span>
      </div>
      
      {/* Battery SOC */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-green-400"></span>
        <span className="text-gray-400">Battery</span>
        <span style={{ minWidth: '3.5rem', display: 'inline-flex', gap: '0.125rem', justifyContent: 'flex-end' }}>
          {batterySOC !== null ? (
            <>
              <span className="text-white" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {batterySOC.toFixed(1)}
              </span>
              <span className="text-gray-400">%</span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}