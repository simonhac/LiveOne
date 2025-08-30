'use client'

import { useState } from 'react'

interface EnergyData {
  today: {
    solarKwh: number | null
    loadKwh: number | null
    batteryInKwh: number | null
    batteryOutKwh: number | null
    gridInKwh: number | null
    gridOutKwh: number | null
  }
  total: {
    solarKwh: number | null
    loadKwh: number | null
    batteryInKwh: number | null
    batteryOutKwh: number | null
    gridInKwh: number | null
    gridOutKwh: number | null
  }
}

interface HistoricalData {
  yesterday?: {
    energy?: {
      solarKwh?: number | null
      loadKwh?: number | null
      batteryChargeKwh?: number | null
      batteryDischargeKwh?: number | null
      gridImportKwh?: number | null
      gridExportKwh?: number | null
    }
    dataQuality?: {
      intervalCount?: number
    }
  }
}

interface EnergyPanelProps {
  energy: EnergyData
  historical: HistoricalData | null
  showGrid: boolean
}

export default function EnergyPanel({ energy, historical, showGrid }: EnergyPanelProps) {
  const [showPower, setShowPower] = useState(false)

  // Helper function to render value/unit pairs for narrow view
  const renderNarrowValue = (value: string, unit: string | null, colorClass: string) => {
    return (
      <>
        <span className={`energy-value-narrow ${colorClass}`}>{value}</span>
        {unit && <span className={`energy-unit-narrow font-normal ${colorClass}`}>{unit}</span>}
      </>
    )
  }

  // Helper function to render combined in/out values for narrow view
  const renderNarrowCombined = (inValue: string, outValue: string, unit: string | null, colorClass: string) => {
    return (
      <>
        <span className={`energy-value-narrow ${colorClass}`}>{`${inValue}/${outValue}`}</span>
        {unit && <span className={`energy-unit-narrow font-normal ${colorClass}`}>{unit}</span>}
      </>
    )
  }

  // Determine the appropriate unit for an energy value
  const getAppropriateUnit = (kWh: number | null | undefined): string => {
    if (kWh === null || kWh === undefined) return 'kWh'
    
    const absValue = Math.abs(kWh)
    if (absValue >= 1000000) return 'GWh'
    if (absValue >= 1000) return 'MWh'
    return 'kWh'
  }

  // Format energy value based on the specified unit
  const formatEnergyWithUnit = (kWh: number | null | undefined, unit: string): string => {
    if (kWh === null || kWh === undefined) return '—'
    
    switch (unit) {
      case 'GWh':
        return (kWh / 1000000).toFixed(1)
      case 'MWh':
        return (kWh / 1000).toFixed(1)
      case 'kWh':
      default:
        return kWh.toFixed(1)
    }
  }

  // Calculate average power from energy for today
  const calculateTodayPower = (energyKwh: number | null | undefined): number | null => {
    if (energyKwh === null || energyKwh === undefined) return null
    const now = new Date()
    const hoursToday = now.getHours() + (now.getMinutes() / 60)
    if (hoursToday === 0) return null
    return (energyKwh * 1000) / hoursToday // Convert kWh to W
  }

  // Calculate average power from energy for yesterday
  const calculateYesterdayPower = (energyKwh: number | null | undefined, intervalCount: number | undefined): number | null => {
    if (energyKwh === null || energyKwh === undefined || !intervalCount) return null
    const hoursYesterday = (intervalCount * 5) / 60 // Each interval is 5 minutes
    if (hoursYesterday === 0) return null
    return (energyKwh * 1000) / hoursYesterday // Convert kWh to W
  }

  // Format average power value
  const formatAvgPower = (watts: number | null): string => {
    if (watts === null) return '—'
    if (watts >= 1000) {
      return (watts / 1000).toFixed(1)
    }
    return watts.toFixed(0)
  }

  return (
    <div className="bg-gray-800 rounded p-3">
      <h3 
        className="text-sm font-semibold text-white mb-2 cursor-pointer hover:text-blue-400 transition-colors select-none"
        onClick={() => setShowPower(!showPower)}
      >
        {showPower ? 'Average Power' : 'Energy'}
      </h3>
      
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-1 text-gray-400 font-medium text-xs"></th>
              <th className="text-right py-1 text-gray-400 font-medium text-xs">Solar</th>
              <th className="text-right py-1 text-gray-400 font-medium text-xs">Load</th>
              <th className="text-right py-1 text-gray-400 font-medium text-xs hidden sm:table-cell">Battery In</th>
              <th className="text-right py-1 text-gray-400 font-medium text-xs hidden sm:table-cell">Battery Out</th>
              <th className="text-right py-1 text-gray-400 font-medium text-xs sm:hidden">Battery In/Out</th>
              {showGrid && (
                <>
                  <th className="text-right py-1 text-gray-400 font-medium text-xs hidden sm:table-cell">Grid In</th>
                  <th className="text-right py-1 text-gray-400 font-medium text-xs hidden sm:table-cell">Grid Out</th>
                  <th className="text-right py-1 text-gray-400 font-medium text-xs sm:hidden">Grid In/Out</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {/* Today Row */}
            <tr className="border-b border-gray-700">
              <td className="py-1.5 font-medium text-gray-300 text-xs">Today</td>
              <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.solarKwh))}</span>
                    {calculateTodayPower(energy.today.solarKwh) !== null && <span className="font-normal text-yellow-500 sm:text-yellow-400 energy-unit-narrow">{calculateTodayPower(energy.today.solarKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(energy.today.solarKwh, getAppropriateUnit(energy.today.solarKwh))}</span>
                    {energy.today.solarKwh !== null && energy.today.solarKwh !== undefined && <span className="font-normal text-yellow-500 sm:text-yellow-400 energy-unit-narrow">{getAppropriateUnit(energy.today.solarKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.loadKwh))}</span>
                    {calculateTodayPower(energy.today.loadKwh) !== null && <span className="font-normal text-blue-500 sm:text-blue-400 energy-unit-narrow">{calculateTodayPower(energy.today.loadKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(energy.today.loadKwh, getAppropriateUnit(energy.today.loadKwh))}</span>
                    {energy.today.loadKwh !== null && energy.today.loadKwh !== undefined && <span className="font-normal text-blue-500 sm:text-blue-400 energy-unit-narrow">{getAppropriateUnit(energy.today.loadKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.batteryInKwh))}</span>
                    {calculateTodayPower(energy.today.batteryInKwh) !== null && <span className="font-normal text-green-500 sm:text-green-400 energy-unit-narrow">{calculateTodayPower(energy.today.batteryInKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(energy.today.batteryInKwh, getAppropriateUnit(energy.today.batteryInKwh))}</span>
                    {energy.today.batteryInKwh !== null && energy.today.batteryInKwh !== undefined && <span className="font-normal text-green-500 sm:text-green-400 energy-unit-narrow">{getAppropriateUnit(energy.today.batteryInKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.batteryOutKwh))}</span>
                    {calculateTodayPower(energy.today.batteryOutKwh) !== null && <span className="font-normal text-orange-500 sm:text-orange-400 energy-unit-narrow">{calculateTodayPower(energy.today.batteryOutKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(energy.today.batteryOutKwh, getAppropriateUnit(energy.today.batteryOutKwh))}</span>
                    {energy.today.batteryOutKwh !== null && energy.today.batteryOutKwh !== undefined && <span className="font-normal text-orange-500 sm:text-orange-400 energy-unit-narrow">{getAppropriateUnit(energy.today.batteryOutKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">
                      {calculateTodayPower(energy.today.batteryInKwh) !== null && 
                       calculateTodayPower(energy.today.batteryOutKwh) !== null ? 
                        `${formatAvgPower(calculateTodayPower(energy.today.batteryInKwh))}/${formatAvgPower(calculateTodayPower(energy.today.batteryOutKwh))}` : 
                        '—'
                      }
                    </span>
                    {calculateTodayPower(energy.today.batteryInKwh) !== null && <span className="font-normal text-green-500" style={{ fontSize: '0.36em', opacity: 0.6 }}>kW</span>}
                  </>
                ) : (() => {
                  const inKwh = energy.today.batteryInKwh
                  const outKwh = energy.today.batteryOutKwh
                  
                  if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                    return <span className="font-bold">—</span>
                  }
                  
                  // Use the unit of the larger value for both
                  const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                  const unit = getAppropriateUnit(maxValue)
                  const inValue = formatEnergyWithUnit(inKwh, unit)
                  const outValue = formatEnergyWithUnit(outKwh, unit)
                  
                  return (
                    <>
                      <span className="font-bold">{`${inValue}/${outValue}`}</span>
                      {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                    </>
                  )
                })()}
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.gridInKwh))}</span>
                        {calculateTodayPower(energy.today.gridInKwh) !== null && <span className="font-normal"> {calculateTodayPower(energy.today.gridInKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">{formatEnergyWithUnit(energy.today.gridInKwh, getAppropriateUnit(energy.today.gridInKwh))}</span>
                        {energy.today.gridInKwh !== null && energy.today.gridInKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.today.gridInKwh)}</span>}
                      </>
                    )}
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">{formatAvgPower(calculateTodayPower(energy.today.gridOutKwh))}</span>
                        {calculateTodayPower(energy.today.gridOutKwh) !== null && <span className="font-normal"> {calculateTodayPower(energy.today.gridOutKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">{formatEnergyWithUnit(energy.today.gridOutKwh, getAppropriateUnit(energy.today.gridOutKwh))}</span>
                        {energy.today.gridOutKwh !== null && energy.today.gridOutKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.today.gridOutKwh)}</span>}
                      </>
                    )}
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">
                          {calculateTodayPower(energy.today.gridInKwh) !== null && 
                           calculateTodayPower(energy.today.gridOutKwh) !== null ? 
                            `${formatAvgPower(calculateTodayPower(energy.today.gridInKwh))}/${formatAvgPower(calculateTodayPower(energy.today.gridOutKwh))}` : 
                            '—'
                          }
                        </span>
                        {calculateTodayPower(energy.today.gridInKwh) !== null && <span className="energy-unit-narrow"> kW</span>}
                      </>
                    ) : (() => {
                      const inKwh = energy.today.gridInKwh
                      const outKwh = energy.today.gridOutKwh
                      
                      if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                        return <span className="font-bold">—</span>
                      }
                      
                      // Use the unit of the larger value for both
                      const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                      const unit = getAppropriateUnit(maxValue)
                      const inValue = formatEnergyWithUnit(inKwh, unit)
                      const outValue = formatEnergyWithUnit(outKwh, unit)
                      
                      return (
                        <>
                          <span className="font-bold">{`${inValue}/${outValue}`}</span>
                          {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                        </>
                      )
                    })()}
                  </td>
                </>
              )}
            </tr>

            {/* Yesterday Row */}
            <tr className="border-b border-gray-700">
              <td className="py-1.5 font-medium text-gray-300 text-xs">Yesterday</td>
              <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.solarKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                    {calculateYesterdayPower(historical?.yesterday?.energy?.solarKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.solarKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.solarKwh, getAppropriateUnit(historical?.yesterday?.energy?.solarKwh))}</span>
                    {historical?.yesterday?.energy?.solarKwh !== null && historical?.yesterday?.energy?.solarKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.solarKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.loadKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                    {calculateYesterdayPower(historical?.yesterday?.energy?.loadKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.loadKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.loadKwh, getAppropriateUnit(historical?.yesterday?.energy?.loadKwh))}</span>
                    {historical?.yesterday?.energy?.loadKwh !== null && historical?.yesterday?.energy?.loadKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.loadKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                    {calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.batteryChargeKwh, getAppropriateUnit(historical?.yesterday?.energy?.batteryChargeKwh))}</span>
                    {historical?.yesterday?.energy?.batteryChargeKwh !== null && historical?.yesterday?.energy?.batteryChargeKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.batteryChargeKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.batteryDischargeKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                    {calculateYesterdayPower(historical?.yesterday?.energy?.batteryDischargeKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.batteryDischargeKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.batteryDischargeKwh, getAppropriateUnit(historical?.yesterday?.energy?.batteryDischargeKwh))}</span>
                    {historical?.yesterday?.energy?.batteryDischargeKwh !== null && historical?.yesterday?.energy?.batteryDischargeKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.batteryDischargeKwh)}</span>}
                  </>
                )}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {showPower ? (
                  <>
                    <span className="font-bold">
                      {calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && 
                       calculateYesterdayPower(historical?.yesterday?.energy?.batteryDischargeKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null ? 
                        `${formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount))}/${formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.batteryDischargeKwh, historical?.yesterday?.dataQuality?.intervalCount))}` : 
                        '—'
                      }
                    </span>
                    {calculateYesterdayPower(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="energy-unit-narrow"> kW</span>}
                  </>
                ) : (() => {
                  const inKwh = historical?.yesterday?.energy?.batteryChargeKwh
                  const outKwh = historical?.yesterday?.energy?.batteryDischargeKwh
                  
                  if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                    return <span className="font-bold">—</span>
                  }
                  
                  // Use the unit of the larger value for both
                  const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                  const unit = getAppropriateUnit(maxValue)
                  const inValue = formatEnergyWithUnit(inKwh, unit)
                  const outValue = formatEnergyWithUnit(outKwh, unit)
                  
                  return (
                    <>
                      <span className="font-bold">{`${inValue}/${outValue}`}</span>
                      {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                    </>
                  )
                })()}
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                        {calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.gridImportKwh, getAppropriateUnit(historical?.yesterday?.energy?.gridImportKwh))}</span>
                        {historical?.yesterday?.energy?.gridImportKwh !== null && historical?.yesterday?.energy?.gridImportKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.gridImportKwh)}</span>}
                      </>
                    )}
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">{formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.gridExportKwh, historical?.yesterday?.dataQuality?.intervalCount))}</span>
                        {calculateYesterdayPower(historical?.yesterday?.energy?.gridExportKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(historical?.yesterday?.energy?.gridExportKwh, historical?.yesterday?.dataQuality?.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-bold">{formatEnergyWithUnit(historical?.yesterday?.energy?.gridExportKwh, getAppropriateUnit(historical?.yesterday?.energy?.gridExportKwh))}</span>
                        {historical?.yesterday?.energy?.gridExportKwh !== null && historical?.yesterday?.energy?.gridExportKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(historical?.yesterday?.energy?.gridExportKwh)}</span>}
                      </>
                    )}
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {showPower ? (
                      <>
                        <span className="font-bold">
                          {calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && 
                           calculateYesterdayPower(historical?.yesterday?.energy?.gridExportKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null ? 
                            `${formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount))}/${formatAvgPower(calculateYesterdayPower(historical?.yesterday?.energy?.gridExportKwh, historical?.yesterday?.dataQuality?.intervalCount))}` : 
                            '—'
                          }
                        </span>
                        {calculateYesterdayPower(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.dataQuality?.intervalCount) !== null && <span className="energy-unit-narrow"> kW</span>}
                      </>
                    ) : (() => {
                      const inKwh = historical?.yesterday?.energy?.gridImportKwh
                      const outKwh = historical?.yesterday?.energy?.gridExportKwh
                      
                      if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                        return <span className="font-bold">—</span>
                      }
                      
                      // Use the unit of the larger value for both
                      const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                      const unit = getAppropriateUnit(maxValue)
                      const inValue = formatEnergyWithUnit(inKwh, unit)
                      const outValue = formatEnergyWithUnit(outKwh, unit)
                      
                      return (
                        <>
                          <span className="font-bold">{`${inValue}/${outValue}`}</span>
                          {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                        </>
                      )
                    })()}
                  </td>
                </>
              )}
            </tr>

            {/* All-time Row */}
            <tr>
              <td className="py-1.5 font-medium text-gray-300 text-xs">All-time</td>
              <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                <span className="font-bold">{formatEnergyWithUnit(energy.total.solarKwh, getAppropriateUnit(energy.total.solarKwh))}</span>
                {energy.total.solarKwh !== null && energy.total.solarKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.solarKwh)}</span>}
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                <span className="font-bold">{formatEnergyWithUnit(energy.total.loadKwh, getAppropriateUnit(energy.total.loadKwh))}</span>
                {energy.total.loadKwh !== null && energy.total.loadKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.loadKwh)}</span>}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                <span className="font-bold">{formatEnergyWithUnit(energy.total.batteryInKwh, getAppropriateUnit(energy.total.batteryInKwh))}</span>
                {energy.total.batteryInKwh !== null && energy.total.batteryInKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.batteryInKwh)}</span>}
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                <span className="font-bold">{formatEnergyWithUnit(energy.total.batteryOutKwh, getAppropriateUnit(energy.total.batteryOutKwh))}</span>
                {energy.total.batteryOutKwh !== null && energy.total.batteryOutKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.batteryOutKwh)}</span>}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                {(() => {
                  const inKwh = energy.total.batteryInKwh
                  const outKwh = energy.total.batteryOutKwh
                  
                  if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                    return <span className="font-bold">—</span>
                  }
                  
                  // Use the unit of the larger value for both
                  const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                  const unit = getAppropriateUnit(maxValue)
                  const inValue = formatEnergyWithUnit(inKwh, unit)
                  const outValue = formatEnergyWithUnit(outKwh, unit)
                  
                  return (
                    <>
                      <span className="font-bold">{`${inValue}/${outValue}`}</span>
                      {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                    </>
                  )
                })()}
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    <span className="font-bold">{formatEnergyWithUnit(energy.total.gridInKwh, getAppropriateUnit(energy.total.gridInKwh))}</span>
                    {energy.total.gridInKwh !== null && energy.total.gridInKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.gridInKwh)}</span>}
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    <span className="font-bold">{formatEnergyWithUnit(energy.total.gridOutKwh, getAppropriateUnit(energy.total.gridOutKwh))}</span>
                    {energy.total.gridOutKwh !== null && energy.total.gridOutKwh !== undefined && <span className="font-normal"> {getAppropriateUnit(energy.total.gridOutKwh)}</span>}
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                    {(() => {
                      const inKwh = energy.total.gridInKwh
                      const outKwh = energy.total.gridOutKwh
                      
                      if ((inKwh === null || inKwh === undefined) && (outKwh === null || outKwh === undefined)) {
                        return <span className="font-bold">—</span>
                      }
                      
                      // Use the unit of the larger value for both
                      const maxValue = Math.max(Math.abs(inKwh || 0), Math.abs(outKwh || 0))
                      const unit = getAppropriateUnit(maxValue)
                      const inValue = formatEnergyWithUnit(inKwh, unit)
                      const outValue = formatEnergyWithUnit(outKwh, unit)
                      
                      return (
                        <>
                          <span className="font-bold">{`${inValue}/${outValue}`}</span>
                          {inValue !== '—' || outValue !== '—' ? <span className="font-normal text-green-500 energy-unit-narrow">{unit}</span> : null}
                        </>
                      )
                    })()}
                  </td>
                </>
              )}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}