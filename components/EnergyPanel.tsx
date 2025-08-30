'use client'

import { useState } from 'react'
import { formatValue, formatValuePair } from '@/lib/energy-formatting'

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
  yesterday: {
    date: string
    energy: {
      solarKwh: number | null
      loadKwh: number | null
      batteryChargeKwh: number | null
      batteryDischargeKwh: number | null
      gridImportKwh: number | null
      gridExportKwh: number | null
    }
    power: {
      solar: { minW: number | null; avgW: number | null; maxW: number | null }
      load: { minW: number | null; avgW: number | null; maxW: number | null }
      battery: { minW: number | null; avgW: number | null; maxW: number | null }
      grid: { minW: number | null; avgW: number | null; maxW: number | null }
    }
    soc: {
      minBattery: number | null
      avgBattery: number | null
      maxBattery: number | null
      endBattery: number | null
    }
    dataQuality: {
      intervalCount: number | null
      coverage: string | null
    }
  } | null
}

interface EnergyPanelProps {
  energy: EnergyData
  historical: HistoricalData | null
  showGrid: boolean
}

export default function EnergyPanel({ energy, historical, showGrid }: EnergyPanelProps) {
  const [showPower, setShowPower] = useState(false)


  // Calculate average power from energy for today
  const calculateTodayPower = (energyKwh: number | null | undefined): number | null => {
    if (energyKwh === null || energyKwh === undefined) return null
    const now = new Date()
    const hoursToday = now.getHours() + (now.getMinutes() / 60)
    if (hoursToday === 0) return null
    return (energyKwh * 1000) / hoursToday // Convert kWh to W
  }

  // Calculate average power from energy for yesterday
  const calculateYesterdayPower = (energyKwh: number | null, intervalCount: number | null): number | null => {
    if (energyKwh === null || !intervalCount) return null
    const hoursYesterday = (intervalCount * 5) / 60 // Each interval is 5 minutes
    if (hoursYesterday === 0) return null
    return (energyKwh * 1000) / hoursYesterday // Convert kWh to W
  }

  // Helper to safely get yesterday power values
  const getYesterdayPower = (energyField: 'solarKwh' | 'loadKwh' | 'batteryChargeKwh' | 'batteryDischargeKwh' | 'gridImportKwh' | 'gridExportKwh'): number | null => {
    if (!historical?.yesterday) return null
    return calculateYesterdayPower(historical.yesterday.energy[energyField], historical.yesterday.dataQuality.intervalCount)
  }

  // Helper function to convert formatted result to JSX
  const toJSX = (formatted: { value: string; unit: string }): React.JSX.Element => {
    if (formatted.unit === '') {
      return <span className="energy-value">{formatted.value}</span>
    }
    return (
      <>
        <span className="energy-value">{formatted.value}</span>
        <span className="energy-unit">{formatted.unit}</span>
      </>
    )
  }

  // Format value and return JSX
  const formatValueJSX = (value: number | null | undefined, unit: string): React.JSX.Element => {
    return toJSX(formatValue(value, unit))
  }

  // Format value pair and return JSX
  const formatValuePairJSX = (inValue: number | null | undefined, outValue: number | null | undefined, unit: string): React.JSX.Element => {
    return toJSX(formatValuePair(inValue, outValue, unit))
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
        <table className="w-full energy-table">
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
              <td className="text-right py-1.5 text-yellow-400 text-sm">
                {showPower ? 
                  formatValueJSX(calculateTodayPower(energy.today.solarKwh), 'W') :
                  formatValueJSX(energy.today.solarKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm">
                {showPower ? 
                  formatValueJSX(calculateTodayPower(energy.today.loadKwh), 'W') :
                  formatValueJSX(energy.today.loadKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                {showPower ? 
                  formatValueJSX(calculateTodayPower(energy.today.batteryInKwh), 'W') :
                  formatValueJSX(energy.today.batteryInKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell">
                {showPower ? 
                  formatValueJSX(calculateTodayPower(energy.today.batteryOutKwh), 'W') :
                  formatValueJSX(energy.today.batteryOutKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden">
                {showPower ? 
                  formatValuePairJSX(calculateTodayPower(energy.today.batteryInKwh), calculateTodayPower(energy.today.batteryOutKwh), 'W') :
                  formatValuePairJSX(energy.today.batteryInKwh, energy.today.batteryOutKwh, 'kWh')
                }
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell">
                    {showPower ? 
                      formatValueJSX(calculateTodayPower(energy.today.gridInKwh), 'W') :
                      formatValueJSX(energy.today.gridInKwh, 'kWh')
                    }
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                    {showPower ? 
                      formatValueJSX(calculateTodayPower(energy.today.gridOutKwh), 'W') :
                      formatValueJSX(energy.today.gridOutKwh, 'kWh')
                    }
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden">
                    {showPower ? 
                      formatValuePairJSX(calculateTodayPower(energy.today.gridInKwh), calculateTodayPower(energy.today.gridOutKwh), 'W') :
                      formatValuePairJSX(energy.today.gridInKwh, energy.today.gridOutKwh, 'kWh')
                    }
                  </td>
                </>
              )}
            </tr>

            {/* Yesterday Row */}
            <tr className="border-b border-gray-700">
              <td className="py-1.5 font-medium text-gray-300 text-xs">Yesterday</td>
              <td className="text-right py-1.5 text-yellow-400 text-sm">
                {showPower ? 
                  formatValueJSX(getYesterdayPower('solarKwh'), 'W') :
                  formatValueJSX(historical?.yesterday?.energy?.solarKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm">
                {showPower ? 
                  formatValueJSX(getYesterdayPower('loadKwh'), 'W') :
                  formatValueJSX(historical?.yesterday?.energy?.loadKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                {showPower ? 
                  formatValueJSX(getYesterdayPower('batteryChargeKwh'), 'W') :
                  formatValueJSX(historical?.yesterday?.energy?.batteryChargeKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell">
                {showPower ? 
                  formatValueJSX(getYesterdayPower('batteryDischargeKwh'), 'W') :
                  formatValueJSX(historical?.yesterday?.energy?.batteryDischargeKwh, 'kWh')
                }
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden">
                {showPower ? 
                  formatValuePairJSX(getYesterdayPower('batteryChargeKwh'), getYesterdayPower('batteryDischargeKwh'), 'W') :
                  formatValuePairJSX(historical?.yesterday?.energy?.batteryChargeKwh, historical?.yesterday?.energy?.batteryDischargeKwh, 'kWh')
                }
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell">
                    {showPower ? 
                      formatValueJSX(getYesterdayPower('gridImportKwh'), 'W') :
                      formatValueJSX(historical?.yesterday?.energy?.gridImportKwh, 'kWh')
                    }
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                    {showPower ? 
                      formatValueJSX(getYesterdayPower('gridExportKwh'), 'W') :
                      formatValueJSX(historical?.yesterday?.energy?.gridExportKwh, 'kWh')
                    }
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden">
                    {showPower ? 
                      formatValuePairJSX(getYesterdayPower('gridImportKwh'), getYesterdayPower('gridExportKwh'), 'W') :
                      formatValuePairJSX(historical?.yesterday?.energy?.gridImportKwh, historical?.yesterday?.energy?.gridExportKwh, 'kWh')
                    }
                  </td>
                </>
              )}
            </tr>

            {/* All-time Row */}
            <tr>
              <td className="py-1.5 font-medium text-gray-300 text-xs">All-time</td>
              <td className="text-right py-1.5 text-yellow-400 text-sm">
                {formatValueJSX(energy.total.solarKwh, 'kWh')}
              </td>
              <td className="text-right py-1.5 text-blue-400 text-sm">
                {formatValueJSX(energy.total.loadKwh, 'kWh')}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                {formatValueJSX(energy.total.batteryInKwh, 'kWh')}
              </td>
              <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell">
                {formatValueJSX(energy.total.batteryOutKwh, 'kWh')}
              </td>
              <td className="text-right py-1.5 text-green-400 text-sm sm:hidden">
                {formatValuePairJSX(energy.total.batteryInKwh, energy.total.batteryOutKwh, 'kWh')}
              </td>
              {showGrid && (
                <>
                  <td className="text-right py-1.5 text-red-400 text-sm hidden sm:table-cell">
                    {formatValueJSX(energy.total.gridInKwh, 'kWh')}
                  </td>
                  <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell">
                    {formatValueJSX(energy.total.gridOutKwh, 'kWh')}
                  </td>
                  <td className="text-right py-1.5 text-red-400 text-sm sm:hidden">
                    {formatValuePairJSX(energy.total.gridInKwh, energy.total.gridOutKwh, 'kWh')}
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