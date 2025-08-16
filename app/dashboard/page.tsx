'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { SelectronicData } from '@/config'
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

export default function DashboardPage() {
  const [data, setData] = useState<SelectronicData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0)
  const [isPolling, setIsPolling] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [showSystemInfo, setShowSystemInfo] = useState(false)
  const router = useRouter()

  useEffect(() => {
    // Check authentication
    const isAuthenticated = sessionStorage.getItem('authenticated')
    if (!isAuthenticated) {
      router.push('/')
      return
    }

    // Set up SSE connection for real-time updates
    const eventSource = new EventSource('/api/sse/user')
    
    eventSource.onopen = () => {
      console.log('SSE connection established')
      setError('')
    }
    
    eventSource.onmessage = (event) => {
      try {
        const result = JSON.parse(event.data)
        
        if (result.type === 'connected') {
          console.log('SSE connected:', result.timestamp)
        } else if (result.type === 'update') {
          if (result.data) {
            setData(result.data)
            // Use the timestamp from the actual data, which represents when it was captured from the inverter
            const dataTimestamp = new Date(result.data.timestamp)
            setLastUpdate(dataTimestamp)
            // Calculate the actual seconds since the data timestamp
            const secondsAgo = Math.floor((Date.now() - dataTimestamp.getTime()) / 1000)
            setSecondsSinceUpdate(secondsAgo)
            setIsPolling(result.status?.isPolling || false)
            setIsAuthenticated(result.status?.isAuthenticated || false)
            setSystemInfo(result.systemInfo || null)
            setError('')
          } else if (result.status?.lastError) {
            setError(result.status.lastError)
            setIsPolling(result.status?.isPolling || false)
            setIsAuthenticated(result.status?.isAuthenticated || false)
          }
          setLoading(false)
        } else if (result.type === 'heartbeat') {
          console.log('SSE heartbeat:', result.timestamp)
        }
      } catch (err) {
        console.error('Error parsing SSE data:', err)
      }
    }
    
    eventSource.onerror = (error) => {
      console.error('SSE error:', error)
      setError('Connection lost. Reconnecting...')
      // Browser will automatically reconnect
    }

    // Cleanup on unmount
    return () => {
      eventSource.close()
    }
  }, [router])

  // Update seconds since last update
  useEffect(() => {
    if (!lastUpdate) return
    
    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000)
      setSecondsSinceUpdate(seconds)
    }, 1000)
    
    return () => clearInterval(interval)
  }, [lastUpdate])

  const handleLogout = () => {
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
    return `${(watts / 1000).toFixed(3)} kW`
  }

  // Automatically determine if grid information should be shown
  const showGrid = data ? (data.gridInKwhTotal > 0 || data.gridOutKwhTotal > 0) : false

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
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
                <div className="relative">
                  <button
                    onMouseEnter={() => setShowSystemInfo(true)}
                    onMouseLeave={() => setShowSystemInfo(false)}
                    className="text-gray-400 hover:text-white transition-colors"
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
                isPolling ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
              }`}>
                <Activity className="w-3 h-3" />
                {isPolling ? 'Polling' : 'Stopped'}
              </div>
              <div className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                isAuthenticated ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
              }`}>
                {isAuthenticated ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {isAuthenticated ? 'Connected' : 'Disconnected'}
              </div>
              <div className="bg-green-900/50 text-green-400 px-2 py-1 rounded text-xs flex items-center gap-1">
                <Activity className="w-3 h-3" />
                Live
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
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>{error}</span>
          </div>
        )}

        {data && (
          <div className="space-y-6">
            {/* Fault Warning */}
            {data.faultCode !== 0 && (
              <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <div>
                  <span className="font-semibold">Fault Code {data.faultCode}</span> encountered at {new Date(data.faultTimestamp * 1000).toLocaleString()}
                </div>
              </div>
            )}

            {/* Main Dashboard Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Chart Placeholder - 2/3 width */}
              <div className="lg:col-span-2">
                <div className="bg-gray-800 border border-gray-700 rounded p-6 h-full min-h-[400px] flex items-center justify-center">
                  <div className="text-center">
                    <div className="text-gray-500 text-lg mb-2">Chart Placeholder</div>
                    <div className="text-gray-600 text-sm">Energy visualization coming soon</div>
                  </div>
                </div>
              </div>

              {/* Power Cards - 1/3 width, stacked vertically */}
              <div className="space-y-4">
                <PowerCard
                  title="Solar"
                  value={formatPower(data.solarPower)}
                  icon={<Sun className="w-6 h-6" />}
                  iconColor="text-yellow-400"
                  bgColor="bg-yellow-900/20"
                  borderColor="border-yellow-700"
                  extra={
                    <div className="text-xs space-y-1 text-gray-400">
                      <div>Remote: {formatPower(data.solarInverterPower)}</div>
                      <div>Local: {formatPower(data.shuntPower)}</div>
                    </div>
                  }
                />
                <PowerCard
                  title="Load"
                  value={formatPower(data.loadPower)}
                  icon={<Home className="w-6 h-6" />}
                  iconColor="text-blue-400"
                  bgColor="bg-blue-900/20"
                  borderColor="border-blue-700"
                />
                <PowerCard
                  title="Battery"
                  value={formatPower(data.batteryPower)}
                  icon={<Battery className="w-6 h-6" />}
                  iconColor={data.batteryPower < 0 ? "text-green-400" : data.batteryPower > 0 ? "text-orange-400" : "text-gray-400"}
                  bgColor={data.batteryPower < 0 ? "bg-green-900/20" : data.batteryPower > 0 ? "bg-orange-900/20" : "bg-gray-900/20"}
                  borderColor={data.batteryPower < 0 ? "border-green-700" : data.batteryPower > 0 ? "border-orange-700" : "border-gray-700"}
                  extra={
                    <div className="text-sm font-semibold text-white">{data.batterySOC.toFixed(1)}% SOC</div>
                  }
                  extraInfo={data.batteryPower < 0 ? 'Charging' : data.batteryPower > 0 ? 'Discharging' : 'Idle'}
                />
                {showGrid && (
                  <PowerCard
                    title="Grid"
                    value={formatPower(data.gridPower)}
                    icon={<Zap className="w-6 h-6" />}
                    iconColor={data.gridPower > 0 ? "text-red-400" : data.gridPower < 0 ? "text-green-400" : "text-gray-400"}
                    bgColor={data.gridPower > 0 ? "bg-red-900/20" : data.gridPower < 0 ? "bg-green-900/20" : "bg-gray-900/20"}
                    borderColor={data.gridPower > 0 ? "border-red-700" : data.gridPower < 0 ? "border-green-700" : "border-gray-700"}
                    extraInfo={data.gridPower > 0 ? 'Importing' : data.gridPower < 0 ? 'Exporting' : 'Neutral'}
                  />
                )}
              </div>
            </div>

            {/* Energy Statistics */}
            <div className="bg-gray-800 rounded p-3">
              <h3 className="text-sm font-semibold text-white mb-2">Energy</h3>
              
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-1 text-gray-400 font-medium text-xs"></th>
                      <th className="text-right py-1 text-gray-400 font-medium text-xs">Solar</th>
                      <th className="text-right py-1 text-gray-400 font-medium text-xs">Load</th>
                      <th className="text-right py-1 text-gray-400 font-medium text-xs">Battery In</th>
                      <th className="text-right py-1 text-gray-400 font-medium text-xs">Battery Out</th>
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
                      <td className="text-right py-1.5 text-yellow-400 font-mono text-sm">
                        {data.solarKwhToday.toFixed(3)}
                      </td>
                      <td className="text-right py-1.5 text-blue-400 font-mono text-sm">
                        {data.loadKwhToday.toFixed(3)}
                      </td>
                      <td className="text-right py-1.5 text-green-400 font-mono text-sm">
                        {data.batteryInKwhToday.toFixed(3)}
                      </td>
                      <td className="text-right py-1.5 text-orange-400 font-mono text-sm">
                        {data.batteryOutKwhToday.toFixed(3)}
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right py-1.5 text-red-400 font-mono text-sm">
                            {data.gridInKwhToday.toFixed(3)}
                          </td>
                          <td className="text-right py-1.5 text-green-400 font-mono text-sm">
                            {data.gridOutKwhToday.toFixed(3)}
                          </td>
                        </>
                      )}
                    </tr>
                    <tr>
                      <td className="py-1.5 font-medium text-gray-300 text-xs">Total</td>
                      <td className="text-right py-1.5 text-yellow-400 font-mono text-sm">
                        {data.solarKwhTotal.toFixed(1)}
                      </td>
                      <td className="text-right py-1.5 text-blue-400 font-mono text-sm">
                        {data.loadKwhTotal.toFixed(1)}
                      </td>
                      <td className="text-right py-1.5 text-green-400 font-mono text-sm">
                        {data.batteryInKwhTotal.toFixed(1)}
                      </td>
                      <td className="text-right py-1.5 text-orange-400 font-mono text-sm">
                        {data.batteryOutKwhTotal.toFixed(1)}
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right py-1.5 text-red-400 font-mono text-sm">
                            {data.gridInKwhTotal.toFixed(1)}
                          </td>
                          <td className="text-right py-1.5 text-green-400 font-mono text-sm">
                            {data.gridOutKwhTotal.toFixed(1)}
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
  extraInfo
}: { 
  title: string
  value: string
  icon: React.ReactNode
  iconColor: string
  bgColor: string
  borderColor: string
  extra?: string | React.ReactNode
  extraInfo?: string
}) {
  return (
    <div className={`${bgColor} border ${borderColor} rounded p-6 transition-all hover:bg-opacity-30`}>
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
  )
}