'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import EnergyChart from '@/components/EnergyChart'
import { 
  Sun, 
  Home, 
  Battery, 
  Zap, 
  AlertTriangle,
  Info,
  Activity,
  Wifi,
  WifiOff,
  LogOut,
  Clock
} from 'lucide-react'

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface DashboardData {
  latest: {
    timestamp: string;
    power: {
      solarW: number;
      solarInverterW: number;
      shuntW: number;
      loadW: number;
      batteryW: number;
      gridW: number;
    };
    soc: {
      battery: number;
    };
    energy: {
      today: {
        solarKwh: number | null;
        loadKwh: number | null;
        batteryInKwh: number | null;
        batteryOutKwh: number | null;
        gridInKwh: number | null;
        gridOutKwh: number | null;
      };
      total: {
        solarKwh: number | null;
        loadKwh: number | null;
        batteryInKwh: number | null;
        batteryOutKwh: number | null;
        gridInKwh: number | null;
        gridOutKwh: number | null;
      };
    };
    system: {
      faultCode: number;
      faultTimestamp: number;
      generatorStatus: number;
    };
  };
  historical: {
    yesterday: {
      date: string;
      energy: {
        solarKwh: number | null;
        loadKwh: number | null;
        batteryChargeKwh: number | null;
        batteryDischargeKwh: number | null;
        gridImportKwh: number | null;
        gridExportKwh: number | null;
      };
      power: {
        solar: { minW: number | null; avgW: number | null; maxW: number | null };
        load: { minW: number | null; avgW: number | null; maxW: number | null };
        battery: { minW: number | null; avgW: number | null; maxW: number | null };
        grid: { minW: number | null; avgW: number | null; maxW: number | null };
      };
      soc: {
        minBattery: number | null;
        avgBattery: number | null;
        maxBattery: number | null;
        endBattery: number | null;
      };
      dataQuality: {
        intervalCount: number | null;
        coverage: string | null;
      };
    } | null;
  };
  polling: {
    lastPollTime: string | null;
    lastSuccessTime: string | null;
    lastErrorTime: string | null;
    lastError: string | null;
    consecutiveErrors: number;
    totalPolls: number;
    successfulPolls: number;
    isActive: boolean;
  };
  systemInfo: SystemInfo;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [showSystemInfo, setShowSystemInfo] = useState(false)
  const [showPower, setShowPower] = useState(false) // Toggle between energy (kWh) and power (W)
  const router = useRouter()

  // Function to fetch data from API
  const fetchData = async () => {
    try {
      const response = await fetch('/api/data')
      const result = await response.json()
      
      if (result.success) {
        setData(result)
        
        // Parse timestamp (now in AEST format)
        const dataTimestamp = new Date(result.latest.timestamp)
        setLastUpdate(dataTimestamp)
        
        // Calculate seconds since update
        const secondsAgo = Math.floor((Date.now() - dataTimestamp.getTime()) / 1000)
        setSecondsSinceUpdate(secondsAgo)
        
        // Update authentication status from the polling section
        const polling = result.polling || {}
        // Consider authenticated if we have recent successful data
        const lastSuccess = polling.lastSuccessTime ? new Date(polling.lastSuccessTime) : null
        const isAuth = lastSuccess ? ((Date.now() - lastSuccess.getTime()) / 1000 / 60) < 5 : false
        setIsAuthenticated(isAuth)
        
        setSystemInfo(result.systemInfo || null)
        setError('')
        setLoading(false)
      } else {
        setError(result.error || 'Failed to fetch data')
        setLoading(false)
      }
    } catch (err) {
      console.error('Error fetching data:', err)
      setError('Failed to fetch data')
      setLoading(false)
    }
  }

  useEffect(() => {
    // Check authentication
    const isAuthenticated = sessionStorage.getItem('authenticated')
    if (!isAuthenticated) {
      router.push('/')
      return
    }

    // Initial fetch
    fetchData()

    // Set up polling interval (30 seconds)
    const interval = setInterval(fetchData, 30000)

    // Cleanup on unmount
    return () => {
      clearInterval(interval)
    }
  }, [router])

  // Update seconds since last update and trigger refresh at 70 seconds
  useEffect(() => {
    if (!lastUpdate) return
    
    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000)
      setSecondsSinceUpdate(seconds)
      
      // Trigger refresh when reaching 70 seconds
      if (seconds === 70) {
        fetchData()
      }
    }, 1000)
    
    return () => clearInterval(interval)
  }, [lastUpdate])

  const handleLogout = async () => {
    // Clear the auth cookie
    await fetch('/api/auth/logout', { method: 'POST' })
    
    // Clear session storage
    sessionStorage.clear()
    router.push('/')
  }

  if (!data && loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading inverter data...</p>
        </div>
      </div>
    )
  }

  const formatPower = (watts: number) => {
    return `${(watts / 1000).toFixed(1)} kW`
  }

  // Calculate average power from energy for today
  const calculateTodayPower = (energyKwh: number | null | undefined): number | null => {
    if (energyKwh === null || energyKwh === undefined) return null;
    const now = new Date();
    const hoursToday = now.getHours() + (now.getMinutes() / 60);
    if (hoursToday === 0) return null;
    return (energyKwh * 1000) / hoursToday; // Convert kWh to W
  }

  // Calculate average power from energy for yesterday
  const calculateYesterdayPower = (energyKwh: number | null | undefined, intervalCount: number | null | undefined): number | null => {
    if (energyKwh === null || energyKwh === undefined || !intervalCount) return null;
    // Each interval is 5 minutes, so hours = intervalCount * 5 / 60
    const hours = (intervalCount * 5) / 60;
    if (hours === 0) return null;
    return (energyKwh * 1000) / hours; // Convert kWh to W
  }

  // Format power value for display
  const formatAvgPower = (watts: number | null): string => {
    if (watts === null) return '—';
    if (watts >= 1000) {
      return `${(watts / 1000).toFixed(3)}`;
    }
    return `${watts.toFixed(0)}`;
  }

  // Automatically determine if grid information should be shown
  const showGrid = data ? (
    (data.latest.energy.total.gridInKwh || 0) > 0 || 
    (data.latest.energy.total.gridOutKwh || 0) > 0
  ) : false

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-1 sm:px-6 lg:px-8 py-3 sm:py-4">
          {/* Mobile Layout */}
          <div className="sm:hidden">
            <div className="flex justify-between items-center">
              <h1 className="text-lg font-bold text-white">LiveOne</h1>
              <div className="flex items-center gap-2">
                <span className={`${
                  isAuthenticated ? 'text-green-400' : 'text-red-400'
                }`}>
                  {isAuthenticated ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                </span>
                <span className="text-gray-400 text-xs font-mono">
                  {!lastUpdate ? '-' :
                   secondsSinceUpdate < 60 ? `${secondsSinceUpdate}s` :
                   `${Math.floor(secondsSinceUpdate / 60)}m`}
                </span>
                <span className="text-gray-400 text-xs">•</span>
                <span className="text-gray-400 text-sm">
                  {sessionStorage.getItem('displayName')}
                </span>
                <button
                  onClick={handleLogout}
                  className="text-red-400 hover:text-red-300 p-1"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Desktop Layout */}
          <div className="hidden sm:flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-white">LiveOne Dashboard</h1>
              <p className="text-sm text-gray-400 mt-1">Selectronic SP PRO Monitoring</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm text-gray-400 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span className="font-mono text-white">
                  {!lastUpdate ? '-' :
                   secondsSinceUpdate === 0 ? 'Just now' : 
                   secondsSinceUpdate === 1 ? '1 second ago' : 
                   secondsSinceUpdate < 60 ? `${secondsSinceUpdate}s ago` :
                   `${Math.floor(secondsSinceUpdate / 60)}m ${secondsSinceUpdate % 60}s ago`}
                </span>
              </div>
              {systemInfo && (
                <div className="relative flex items-center">
                  <button
                    onMouseEnter={() => setShowSystemInfo(true)}
                    onMouseLeave={() => setShowSystemInfo(false)}
                    className="text-gray-400 hover:text-white transition-colors flex items-center"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                  {showSystemInfo && (
                    <div className="absolute top-full mt-2 right-1/2 translate-x-1/2 z-50 bg-gray-800 border border-gray-600 rounded shadow-xl p-4 min-w-[280px]" 
                         onMouseEnter={() => setShowSystemInfo(true)}
                         onMouseLeave={() => setShowSystemInfo(false)}>
                      <h4 className="font-semibold text-white mb-3">System Information</h4>
                      <div className="space-y-2 text-sm">
                        {systemInfo.model && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Model:</span>
                            <span className="text-white">{systemInfo.model}</span>
                          </div>
                        )}
                        {systemInfo.serial && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Serial:</span>
                            <span className="text-white">{systemInfo.serial}</span>
                          </div>
                        )}
                        {systemInfo.ratings && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Ratings:</span>
                            <span className="text-white">{systemInfo.ratings}</span>
                          </div>
                        )}
                        {systemInfo.solarSize && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Solar Size:</span>
                            <span className="text-white">{systemInfo.solarSize}</span>
                          </div>
                        )}
                        {systemInfo.batterySize && (
                          <div className="flex justify-between">
                            <span className="text-gray-400">Battery Size:</span>
                            <span className="text-white">{systemInfo.batterySize}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                isAuthenticated ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
              }`}>
                {isAuthenticated ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {isAuthenticated ? 'Connected' : 'Disconnected'}
              </div>
              <div className="text-sm text-gray-400">
                {sessionStorage.getItem('displayName')}
              </div>
              <button
                onClick={handleLogout}
                className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded text-sm flex items-center gap-2 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-1 sm:px-6 lg:px-8 py-4">
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        {data && (
          <div className="space-y-6">
            {/* Fault Warning */}
            {data.latest.system.faultCode !== 0 && (
              <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <div>
                  <span className="font-semibold">Fault Code {data.latest.system.faultCode}</span> encountered at {new Date(data.latest.system.faultTimestamp * 1000).toLocaleString()}
                </div>
              </div>
            )}

            {/* Main Dashboard Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Energy Chart - 2/3 width */}
              <div className="lg:col-span-2">
                <EnergyChart 
                  className="h-full min-h-[400px]" 
                  maxPowerHint={(() => {
                    // Parse solar size (format: "9 kW")
                    let solarKW: number | undefined
                    if (systemInfo?.solarSize) {
                      const solarMatch = systemInfo.solarSize.match(/^(\d+(?:\.\d+)?)\s+kW$/i)
                      if (solarMatch) {
                        solarKW = parseFloat(solarMatch[1])
                      }
                    }
                    
                    // Parse inverter rating (format: "7.5kW, 48V")
                    let inverterKW: number | undefined
                    if (systemInfo?.ratings) {
                      const ratingMatch = systemInfo.ratings.match(/(\d+(?:\.\d+)?)kW/i)
                      if (ratingMatch) {
                        inverterKW = parseFloat(ratingMatch[1])
                      }
                    }
                    
                    // Return the maximum of both values, or undefined if neither parsed
                    if (solarKW !== undefined && inverterKW !== undefined) {
                      return Math.max(solarKW, inverterKW)
                    }
                    return solarKW ?? inverterKW
                  })()}
                />
              </div>

              {/* Power Cards - 1/3 width on desktop, horizontal on mobile */}
              <div className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-4">
                <PowerCard
                  title="Solar"
                  value={formatPower(data.latest.power.solarW)}
                  icon={<Sun className="w-6 h-6" />}
                  iconColor="text-yellow-400"
                  bgColor="bg-yellow-900/20"
                  borderColor="border-yellow-700"
                  isOffline={!isAuthenticated}
                  extra={
                    <div className="text-xs space-y-1 text-gray-400">
                      <div>Remote: {formatPower(data.latest.power.solarInverterW)}</div>
                      <div>Local: {formatPower(data.latest.power.shuntW)}</div>
                    </div>
                  }
                />
                <PowerCard
                  title="Load"
                  value={formatPower(data.latest.power.loadW)}
                  icon={<Home className="w-6 h-6" />}
                  iconColor="text-blue-400"
                  bgColor="bg-blue-900/20"
                  borderColor="border-blue-700"
                  isOffline={!isAuthenticated}
                />
                <PowerCard
                  title="Battery"
                  value={`${data.latest.soc.battery.toFixed(1)}%`}
                  icon={<Battery className="w-6 h-6" />}
                  iconColor={data.latest.power.batteryW < 0 ? "text-green-400" : data.latest.power.batteryW > 0 ? "text-orange-400" : "text-gray-400"}
                  bgColor={data.latest.power.batteryW < 0 ? "bg-green-900/20" : data.latest.power.batteryW > 0 ? "bg-orange-900/20" : "bg-gray-900/20"}
                  borderColor={data.latest.power.batteryW < 0 ? "border-green-700" : data.latest.power.batteryW > 0 ? "border-orange-700" : "border-gray-700"}
                  isOffline={!isAuthenticated}
                  extraInfo={
                    data.latest.power.batteryW !== 0 
                      ? `${data.latest.power.batteryW < 0 ? 'Charging' : 'Discharging'} ${formatPower(Math.abs(data.latest.power.batteryW))}`
                      : 'Idle'
                  }
                />
                {showGrid && (
                  <PowerCard
                    title="Grid"
                    value={formatPower(data.latest.power.gridW)}
                    icon={<Zap className="w-6 h-6" />}
                    iconColor={data.latest.power.gridW > 0 ? "text-red-400" : data.latest.power.gridW < 0 ? "text-green-400" : "text-gray-400"}
                    bgColor={data.latest.power.gridW > 0 ? "bg-red-900/20" : data.latest.power.gridW < 0 ? "bg-green-900/20" : "bg-gray-900/20"}
                    borderColor={data.latest.power.gridW > 0 ? "border-red-700" : data.latest.power.gridW < 0 ? "border-green-700" : "border-gray-700"}
                    isOffline={!isAuthenticated}
                    extraInfo={data.latest.power.gridW > 0 ? 'Importing' : data.latest.power.gridW < 0 ? 'Exporting' : 'Neutral'}
                  />
                )}
              </div>
            </div>

            {/* Energy Statistics */}
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
                          <th className="text-right py-1 text-gray-400 font-medium text-xs">Grid In</th>
                          <th className="text-right py-1 text-gray-400 font-medium text-xs">Grid Out</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-700">
                      <td className="py-1.5 font-medium text-gray-300 text-xs">Today</td>
                      <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.solarKwh))}</span>
                            {calculateTodayPower(data.latest.energy.today.solarKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.solarKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.latest.energy.today.solarKwh?.toFixed(1) ?? '—'}</span>
                            {data.latest.energy.today.solarKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.loadKwh))}</span>
                            {calculateTodayPower(data.latest.energy.today.loadKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.loadKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.latest.energy.today.loadKwh?.toFixed(1) ?? '—'}</span>
                            {data.latest.energy.today.loadKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.batteryInKwh))}</span>
                            {calculateTodayPower(data.latest.energy.today.batteryInKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.batteryInKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.latest.energy.today.batteryInKwh?.toFixed(1) ?? '—'}</span>
                            {data.latest.energy.today.batteryInKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.batteryOutKwh))}</span>
                            {calculateTodayPower(data.latest.energy.today.batteryOutKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.batteryOutKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.latest.energy.today.batteryOutKwh?.toFixed(1) ?? '—'}</span>
                            {data.latest.energy.today.batteryOutKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">
                              {calculateTodayPower(data.latest.energy.today.batteryInKwh) !== null && 
                               calculateTodayPower(data.latest.energy.today.batteryOutKwh) !== null ? 
                                `${formatAvgPower(calculateTodayPower(data.latest.energy.today.batteryInKwh))}/${formatAvgPower(calculateTodayPower(data.latest.energy.today.batteryOutKwh))}` : 
                                '—'
                              }
                            </span>
                            {calculateTodayPower(data.latest.energy.today.batteryInKwh) !== null && <span className="font-normal"> kW</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">
                              {data.latest.energy.today.batteryInKwh !== null && data.latest.energy.today.batteryOutKwh !== null ? 
                                `${data.latest.energy.today.batteryInKwh.toFixed(1)}/${data.latest.energy.today.batteryOutKwh.toFixed(1)}` : 
                                '—'
                              }
                            </span>
                            {data.latest.energy.today.batteryInKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right py-1.5 text-red-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            {showPower ? (
                              <>
                                <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.gridInKwh))}</span>
                                {calculateTodayPower(data.latest.energy.today.gridInKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.gridInKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                              </>
                            ) : (
                              <>
                                <span className="font-bold">{data.latest.energy.today.gridInKwh?.toFixed(1) ?? '—'}</span>
                                {data.latest.energy.today.gridInKwh !== null && <span className="font-normal"> kWh</span>}
                              </>
                            )}
                          </td>
                          <td className="text-right py-1.5 text-green-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            {showPower ? (
                              <>
                                <span className="font-bold">{formatAvgPower(calculateTodayPower(data.latest.energy.today.gridOutKwh))}</span>
                                {calculateTodayPower(data.latest.energy.today.gridOutKwh) !== null && <span className="font-normal"> {calculateTodayPower(data.latest.energy.today.gridOutKwh)! >= 1000 ? 'kW' : 'W'}</span>}
                              </>
                            ) : (
                              <>
                                <span className="font-bold">{data.latest.energy.today.gridOutKwh?.toFixed(1) ?? '—'}</span>
                                {data.latest.energy.today.gridOutKwh !== null && <span className="font-normal"> kWh</span>}
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                    <tr className="border-b border-gray-700">
                      <td className="py-1.5 font-medium text-gray-300 text-xs">Yesterday</td>
                      <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.solarKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                            {calculateYesterdayPower(data.historical?.yesterday?.energy.solarKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.solarKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.historical?.yesterday?.energy.solarKwh?.toFixed(1) ?? '—'}</span>
                            {data.historical?.yesterday?.energy.solarKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.loadKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                            {calculateYesterdayPower(data.historical?.yesterday?.energy.loadKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.loadKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.historical?.yesterday?.energy.loadKwh?.toFixed(1) ?? '—'}</span>
                            {data.historical?.yesterday?.energy.loadKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                            {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.historical?.yesterday?.energy.batteryChargeKwh?.toFixed(1) ?? '—'}</span>
                            {data.historical?.yesterday?.energy.batteryChargeKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.batteryDischargeKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                            {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryDischargeKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryDischargeKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">{data.historical?.yesterday?.energy.batteryDischargeKwh?.toFixed(1) ?? '—'}</span>
                            {data.historical?.yesterday?.energy.batteryDischargeKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        {showPower ? (
                          <>
                            <span className="font-bold">
                              {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && 
                               calculateYesterdayPower(data.historical?.yesterday?.energy.batteryDischargeKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null ? 
                                `${formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount))}/${formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.batteryDischargeKwh, data.historical?.yesterday?.dataQuality.intervalCount))}` : 
                                '—'
                              }
                            </span>
                            {calculateYesterdayPower(data.historical?.yesterday?.energy.batteryChargeKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> kW</span>}
                          </>
                        ) : (
                          <>
                            <span className="font-bold">
                              {data.historical?.yesterday?.energy.batteryChargeKwh !== null && data.historical?.yesterday?.energy.batteryDischargeKwh !== null ? 
                                `${data.historical.yesterday?.energy.batteryChargeKwh?.toFixed(1)}/${data.historical.yesterday?.energy.batteryDischargeKwh?.toFixed(1)}` : 
                                '—'
                              }
                            </span>
                            {data.historical?.yesterday?.energy.batteryChargeKwh !== null && <span className="font-normal"> kWh</span>}
                          </>
                        )}
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right py-1.5 text-red-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            {showPower ? (
                              <>
                                <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.gridImportKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                                {calculateYesterdayPower(data.historical?.yesterday?.energy.gridImportKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.gridImportKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                              </>
                            ) : (
                              <>
                                <span className="font-bold">{data.historical?.yesterday?.energy.gridImportKwh?.toFixed(1) ?? '—'}</span>
                                {data.historical?.yesterday?.energy.gridImportKwh !== null && <span className="font-normal"> kWh</span>}
                              </>
                            )}
                          </td>
                          <td className="text-right py-1.5 text-green-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            {showPower ? (
                              <>
                                <span className="font-bold">{formatAvgPower(calculateYesterdayPower(data.historical?.yesterday?.energy.gridExportKwh, data.historical?.yesterday?.dataQuality.intervalCount))}</span>
                                {calculateYesterdayPower(data.historical?.yesterday?.energy.gridExportKwh, data.historical?.yesterday?.dataQuality.intervalCount) !== null && <span className="font-normal"> {calculateYesterdayPower(data.historical?.yesterday?.energy.gridExportKwh, data.historical?.yesterday?.dataQuality.intervalCount)! >= 1000 ? 'kW' : 'W'}</span>}
                              </>
                            ) : (
                              <>
                                <span className="font-bold">{data.historical?.yesterday?.energy.gridExportKwh?.toFixed(1) ?? '—'}</span>
                                {data.historical?.yesterday?.energy.gridExportKwh !== null && <span className="font-normal"> kWh</span>}
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                    <tr>
                      <td className="py-1.5 font-medium text-gray-300 text-xs">All Time</td>
                      <td className="text-right py-1.5 text-yellow-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        <span className="font-bold">{data.latest.energy.total.solarKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                      </td>
                      <td className="text-right py-1.5 text-blue-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        <span className="font-bold">{data.latest.energy.total.loadKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        <span className="font-bold">{data.latest.energy.total.batteryInKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                      </td>
                      <td className="text-right py-1.5 text-orange-400 text-sm hidden sm:table-cell" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        <span className="font-bold">{data.latest.energy.total.batteryOutKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                      </td>
                      <td className="text-right py-1.5 text-green-400 text-sm sm:hidden" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                        <span className="font-bold">{(data.latest.energy.total.batteryInKwh?.toFixed(1) ?? '—')}/{(data.latest.energy.total.batteryOutKwh?.toFixed(1) ?? '—')}</span> <span className="font-normal">kWh</span>
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right py-1.5 text-red-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            <span className="font-bold">{data.latest.energy.total.gridInKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                          </td>
                          <td className="text-right py-1.5 text-green-400 text-sm" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            <span className="font-bold">{data.latest.energy.total.gridOutKwh?.toFixed(1) ?? '—'}</span> <span className="font-normal">kWh</span>
                          </td>
                        </>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function PowerCard({ 
  title, 
  value, 
  icon, 
  iconColor,
  bgColor,
  borderColor,
  extra,
  extraInfo,
  isOffline = false
}: { 
  title: string
  value: string
  icon: React.ReactNode
  iconColor: string
  bgColor: string
  borderColor: string
  extra?: string | React.ReactNode
  extraInfo?: string
  isOffline?: boolean
}) {
  return (
    <div 
      className={`${bgColor} border ${borderColor} rounded p-3 lg:p-6 transition-all hover:bg-opacity-30 relative overflow-hidden`}
      style={isOffline ? {
        backgroundImage: `repeating-linear-gradient(
          135deg,
          transparent,
          transparent 10px,
          rgba(255, 255, 255, 0.08) 10px,
          rgba(255, 255, 255, 0.08) 20px
        )`
      } : undefined}>
      {/* Mobile layout: horizontal with icon on left */}
      <div className="lg:hidden">
        <div className="flex items-start gap-3">
          <div className={`${iconColor} flex-shrink-0`}>{icon}</div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-300">{title}</h3>
            <div className="text-xl font-bold text-white">
              {value}
            </div>
            {extraInfo && (
              <div className="text-xs text-gray-400">{extraInfo}</div>
            )}
            {extra && typeof extra === 'string' ? (
              <div className="text-xs text-gray-400 mt-1">{extra}</div>
            ) : extra}
          </div>
        </div>
      </div>
      
      {/* Desktop layout: original vertical layout */}
      <div className="hidden lg:block">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-medium text-gray-300">{title}</h3>
          <div className={iconColor}>{icon}</div>
        </div>
        <div className="text-3xl font-bold text-white mb-2">
          {value}
        </div>
        {extra && (
          <div className="mt-2">{extra}</div>
        )}
        {extraInfo && (
          <div className="text-xs text-gray-400 mt-1">{extraInfo}</div>
        )}
      </div>
    </div>
  )
}