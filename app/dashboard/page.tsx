'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { SelectronicData } from '@/config'

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
  const [showGrid, setShowGrid] = useState(false)
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
            setLastUpdate(new Date(result.timestamp))
            setSecondsSinceUpdate(0)
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
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-gray-900 to-purple-900 flex items-center justify-center">
        <div className="text-center">
          <div className="relative w-24 h-24 mx-auto">
            <div className="absolute inset-0 rounded-full border-4 border-blue-500/20"></div>
            <div className="absolute inset-0 rounded-full border-4 border-t-blue-500 animate-spin"></div>
          </div>
          <p className="mt-6 text-blue-200 text-lg">Loading inverter data...</p>
        </div>
      </div>
    )
  }

  const formatPower = (watts: number) => {
    return `${(watts / 1000).toFixed(3)} kW`
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-gray-900 to-purple-900">
      {/* Header */}
      <header className="bg-black/30 backdrop-blur-lg border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-white">LiveOne Dashboard</h1>
              <p className="text-sm text-blue-200 mt-1">Selectronic SP PRO Monitoring</p>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-blue-200">
                {sessionStorage.getItem('displayName')}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">Live Updates</span>
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
              </div>
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm bg-red-600/80 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 rounded-lg bg-red-900/50 backdrop-blur-sm border border-red-500/50 p-4">
            <div className="text-sm text-red-200">{error}</div>
          </div>
        )}

        {data && (
          <div className="space-y-6">
            {/* Fault Warning */}
            {data.faultCode !== 0 && (
              <div className="mb-4 bg-red-900/50 backdrop-blur-sm rounded-lg border border-red-500/50 p-4">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">⚠️</span>
                  <div className="text-sm text-red-200">
                    <span className="font-semibold">Fault Code {data.faultCode}</span> encountered at {new Date(data.faultTimestamp * 1000).toLocaleString()}
                  </div>
                </div>
              </div>
            )}

            {/* Status Bar */}
            <div className="bg-black/30 backdrop-blur-sm rounded-lg border border-white/10 p-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="text-sm text-blue-200 flex items-center gap-2">
                  <div>
                    Last Update: <span className="text-white font-mono">
                      {secondsSinceUpdate === 0 ? 'Just now' : 
                       secondsSinceUpdate === 1 ? '1 second ago' : 
                       secondsSinceUpdate < 60 ? `${secondsSinceUpdate} seconds ago` :
                       `${Math.floor(secondsSinceUpdate / 60)}m ${secondsSinceUpdate % 60}s ago`}
                    </span>
                  </div>
                  {systemInfo && (
                    <div>
                      <button
                        onMouseEnter={() => setShowSystemInfo(true)}
                        onMouseLeave={() => setShowSystemInfo(false)}
                        className="text-gray-400 hover:text-blue-300 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                      {showSystemInfo && (
                        <div className="fixed z-[9999] bg-gray-900 border border-gray-700 rounded-lg p-4 shadow-xl min-w-[280px]" 
                             style={{ top: '140px', left: '50%', transform: 'translateX(-50%)' }}
                             onMouseEnter={() => setShowSystemInfo(true)}
                             onMouseLeave={() => setShowSystemInfo(false)}>
                          <h4 className="text-white font-semibold mb-2">System Information</h4>
                          <div className="space-y-1 text-sm">
                            {systemInfo.model && <div className="flex justify-between"><span className="text-gray-400">Model:</span><span className="text-white">{systemInfo.model}</span></div>}
                            {systemInfo.serial && <div className="flex justify-between"><span className="text-gray-400">Serial:</span><span className="text-white">{systemInfo.serial}</span></div>}
                            {systemInfo.ratings && <div className="flex justify-between"><span className="text-gray-400">Ratings:</span><span className="text-white">{systemInfo.ratings}</span></div>}
                            {systemInfo.solarSize && <div className="flex justify-between"><span className="text-gray-400">Solar Size:</span><span className="text-white">{systemInfo.solarSize}</span></div>}
                            {systemInfo.batterySize && <div className="flex justify-between"><span className="text-gray-400">Battery Size:</span><span className="text-white">{systemInfo.batterySize}</span></div>}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {data.timestamp && (
                    <div className="text-xs text-gray-400 mt-1">
                      Inverter time: {new Date(data.timestamp).toLocaleTimeString()}
                      {(() => {
                        const delay = Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 1000);
                        if (delay > 0) {
                          return ` (${delay}s delay)`;
                        }
                        return '';
                      })()}
                    </div>
                  )}
                </div>
                <div className="text-sm flex items-center gap-6">
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isPolling ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></span>
                    <span className="text-gray-400">Polling</span>
                    <span className={`font-semibold ${isPolling ? 'text-green-400' : 'text-red-400'}`}>
                      {isPolling ? 'Active' : 'Inactive'}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isAuthenticated ? 'bg-green-400' : 'bg-red-400'}`}></span>
                    <span className="text-gray-400">API</span>
                    <span className={`font-semibold ${isAuthenticated ? 'text-green-400' : 'text-red-400'}`}>
                      {isAuthenticated ? 'Connected' : 'Disconnected'}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* Power Flow Grid */}
            <div className={`grid grid-cols-1 md:grid-cols-2 ${showGrid ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
              <PowerCard
                title="Solar"
                value={formatPower(data.solarPower)}
                rawValue={data.solarPower}
                gradient="from-yellow-400 to-orange-500"
                icon="☀️"
                extra={
                  <div className="text-xs space-y-0.5">
                    <div>Remote: {formatPower(data.solarInverterPower)}</div>
                    <div>Local: {formatPower(data.shuntPower)}</div>
                  </div>
                }
              />
              <PowerCard
                title="Load"
                value={formatPower(data.loadPower)}
                rawValue={data.loadPower}
                gradient="from-blue-400 to-cyan-500"
                icon="🏠"
              />
              <PowerCard
                title="Battery"
                value={formatPower(data.batteryPower)}
                rawValue={data.batteryPower}
                gradient={data.batteryPower < 0 ? "from-green-400 to-emerald-500" : "from-red-400 to-pink-500"}
                icon="🔋"
                extra={`${data.batterySOC.toFixed(1)}% SOC`}
                extraInfo={data.batteryPower < 0 ? 'Charging' : data.batteryPower > 0 ? 'Discharging' : 'Idle'}
              />
              {showGrid && (
                <PowerCard
                  title="Grid"
                  value={formatPower(data.gridPower)}
                  rawValue={data.gridPower}
                  gradient={data.gridPower > 0 ? "from-red-400 to-rose-500" : data.gridPower < 0 ? "from-green-400 to-teal-500" : "from-gray-400 to-gray-500"}
                  icon="⚡"
                  extra={data.gridPower > 0 ? 'Importing' : data.gridPower < 0 ? 'Exporting' : 'Neutral'}
                />
              )}
            </div>

            {/* Energy Statistics */}
            <div className="bg-black/30 backdrop-blur-sm rounded-lg border border-white/10 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Energy</h3>
              
              {/* Table layout */}
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-left text-xs text-gray-400 font-medium pb-3 pr-4"></th>
                      <th className="text-right text-xs text-gray-400 font-medium pb-3 px-2">Solar</th>
                      <th className="text-right text-xs text-gray-400 font-medium pb-3 px-2">Load</th>
                      <th className="text-right text-xs text-gray-400 font-medium pb-3 px-2">Battery In</th>
                      <th className="text-right text-xs text-gray-400 font-medium pb-3 px-2">Battery Out</th>
                      {showGrid && (
                        <>
                          <th className="text-right text-xs text-gray-400 font-medium pb-3 px-2">Grid In</th>
                          <th className="text-right text-xs text-gray-400 font-medium pb-3 pl-2">Grid Out</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="text-sm text-gray-300 font-medium pr-4 py-2">Today</td>
                      <td className="text-right text-yellow-400 font-bold px-2 py-2">
                        {data.solarKwhToday.toFixed(3)} kWh
                      </td>
                      <td className="text-right text-blue-400 font-bold px-2 py-2">
                        {data.loadKwhToday.toFixed(3)} kWh
                      </td>
                      <td className="text-right text-green-400 font-bold px-2 py-2">
                        {data.batteryInKwhToday.toFixed(3)} kWh
                      </td>
                      <td className="text-right text-red-400 font-bold px-2 py-2">
                        {data.batteryOutKwhToday.toFixed(3)} kWh
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right text-purple-400 font-bold px-2 py-2">
                            {data.gridInKwhToday.toFixed(3)} kWh
                          </td>
                          <td className="text-right text-teal-400 font-bold pl-2 py-2">
                            {data.gridOutKwhToday.toFixed(3)} kWh
                          </td>
                        </>
                      )}
                    </tr>
                    <tr className="border-t border-gray-700">
                      <td className="text-sm text-gray-300 font-medium pr-4 pt-3 pb-1">All Time</td>
                      <td className="text-right text-yellow-400 font-bold px-2 pt-3 pb-1">
                        {data.solarKwhTotal.toFixed(1)} kWh
                      </td>
                      <td className="text-right text-blue-400 font-bold px-2 pt-3 pb-1">
                        {data.loadKwhTotal.toFixed(1)} kWh
                      </td>
                      <td className="text-right text-green-400 font-bold px-2 pt-3 pb-1">
                        {data.batteryInKwhTotal.toFixed(1)} kWh
                      </td>
                      <td className="text-right text-red-400 font-bold px-2 pt-3 pb-1">
                        {data.batteryOutKwhTotal.toFixed(1)} kWh
                      </td>
                      {showGrid && (
                        <>
                          <td className="text-right text-purple-400 font-bold px-2 pt-3 pb-1">
                            {data.gridInKwhTotal.toFixed(1)} kWh
                          </td>
                          <td className="text-right text-teal-400 font-bold pl-2 pt-3 pb-1">
                            {data.gridOutKwhTotal.toFixed(1)} kWh
                          </td>
                        </>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            
            {/* Grid Toggle */}
            <div className="bg-black/30 backdrop-blur-sm rounded-lg border border-white/10 p-4">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm text-gray-300">Show Grid Information</span>
                <button
                  onClick={() => setShowGrid(!showGrid)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    showGrid ? 'bg-blue-600' : 'bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      showGrid ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
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
  rawValue,
  gradient, 
  icon, 
  extra,
  extraInfo
}: { 
  title: string
  value: string
  rawValue: number
  gradient: string
  icon: string
  extra?: string | React.ReactNode
  extraInfo?: string
}) {
  return (
    <div className="relative bg-black/30 backdrop-blur-sm rounded-lg border border-white/10 p-6 overflow-hidden">
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-10`}></div>
      <div className="relative">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-400">{title}</h3>
          <span className="text-2xl">{icon}</span>
        </div>
        <div className="text-3xl font-bold text-white">
          {value}
        </div>
        {extra && (
          <div className="text-sm mt-2 text-blue-300">{extra}</div>
        )}
        {extraInfo && (
          <div className="text-xs mt-1 text-gray-500">{extraInfo}</div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-400 text-sm">{label}</span>
      <span className="font-medium text-white">{value}</span>
    </div>
  )
}