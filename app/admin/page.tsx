'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, Info, Clock, Activity, Wifi, WifiOff, Users, Server, Gauge } from 'lucide-react'

interface SystemInfo {
  model?: string
  serial?: string
  ratings?: string
  solarSize?: string
  batterySize?: string
}

interface SystemData {
  owner: string
  displayName: string
  systemNumber: string
  lastLogin: string | null
  isLoggedIn: boolean
  activeSessions: number
  systemInfo?: SystemInfo | null
  polling: {
    isActive: boolean
    isAuthenticated: boolean
    lastPollTime: string | null
    lastError: string | null
  }
  data: {
    solarPower: number
    loadPower: number
    batteryPower: number
    batterySOC: number
    gridPower: number
    timestamp: string
  } | null
}

export default function AdminDashboard() {
  const [systems, setSystems] = useState<SystemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [hoveredSystem, setHoveredSystem] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    // Check if user is admin
    const userRole = sessionStorage.getItem('userRole')
    if (userRole !== 'admin') {
      router.push('/')
      return
    }

    // Set up SSE connection for real-time updates
    const eventSource = new EventSource('/api/sse')
    
    eventSource.onopen = () => {
      console.log('SSE connection established')
      setError(null)
    }
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        
        if (data.type === 'connected') {
          console.log('SSE connected:', data.timestamp)
        } else if (data.type === 'update') {
          setSystems(data.systems)
          setLastUpdate(new Date(data.timestamp))
          setLoading(false)
          setError(null)
        } else if (data.type === 'heartbeat') {
          console.log('SSE heartbeat:', data.timestamp)
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

  const handleLogout = async () => {
    // Clear the auth cookie
    await fetch('/api/auth/logout', { method: 'POST' })
    
    // Clear session storage
    sessionStorage.clear()
    router.push('/')
  }

  const formatPower = (watts: number | undefined | null) => {
    if (watts === undefined || watts === null) return '—'
    return `${(watts / 1000).toFixed(3)} kW`
  }

  const formatSOC = (soc: number | undefined | null) => {
    if (soc === undefined || soc === null) return '—'
    return `${soc.toFixed(1)}%`
  }

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    if (diff < 60000) return 'Just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return date.toLocaleDateString()
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading systems...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-white">LiveOne Admin</h1>
              <p className="text-sm text-gray-400">System Overview Dashboard</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Clock className="w-4 h-4" />
                Last update: {lastUpdate ? formatTime(lastUpdate.toISOString()) : 'Never'}
              </div>
              <button
                onClick={handleLogout}
                className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors"
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
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg mb-6">
            {error}
          </div>
        )}

        {/* Systems Table */}
        <div className="bg-gray-800 rounded-lg overflow-hidden mb-8">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-900">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    System
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Login
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Poll
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Solar
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Load
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Battery
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-medium text-gray-400 uppercase tracking-wider">
                    SOC
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Grid
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {systems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center text-gray-500 py-8">
                      No systems registered
                    </td>
                  </tr>
                ) : (
                  systems.map((system) => (
                    <tr key={system.systemNumber} className="hover:bg-gray-700/50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-gray-200">
                            {system.displayName}
                          </div>
                          <div className="text-xs text-gray-500">
                            {system.owner}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2 relative">
                          <span className="text-sm text-gray-300">
                            #{system.systemNumber}
                          </span>
                          {system.systemInfo && (
                            <div
                              className="relative inline-flex"
                              onMouseEnter={() => setHoveredSystem(system.systemNumber)}
                              onMouseLeave={() => setHoveredSystem(null)}
                            >
                              <Info className="w-4 h-4 text-blue-400 cursor-help" />
                              
                              {/* System Info Panel */}
                              {hoveredSystem === system.systemNumber && (
                                <div className="fixed z-[9999] bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-4 w-72"
                                     style={{ 
                                       position: 'fixed',
                                       left: '50%',
                                       top: '200px',
                                       transform: 'translateX(-50%)'
                                     }}
                                     onMouseEnter={() => setHoveredSystem(system.systemNumber)}
                                     onMouseLeave={() => setHoveredSystem(null)}>
                                  <div className="text-sm font-semibold text-blue-400 mb-3">
                                    System Information
                                  </div>
                                  <div className="space-y-2 text-xs">
                                    {system.systemInfo.model && (
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Model:</span>
                                        <span className="text-gray-200 font-medium">{system.systemInfo.model}</span>
                                      </div>
                                    )}
                                    {system.systemInfo.serial && (
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Serial:</span>
                                        <span className="text-gray-200 font-medium">{system.systemInfo.serial}</span>
                                      </div>
                                    )}
                                    {system.systemInfo.ratings && (
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Ratings:</span>
                                        <span className="text-gray-200 font-medium">{system.systemInfo.ratings}</span>
                                      </div>
                                    )}
                                    {system.systemInfo.solarSize && (
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Solar Size:</span>
                                        <span className="text-gray-200 font-medium">{system.systemInfo.solarSize}</span>
                                      </div>
                                    )}
                                    {system.systemInfo.batterySize && (
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Battery Size:</span>
                                        <span className="text-gray-200 font-medium">{system.systemInfo.batterySize}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {system.isLoggedIn ? (
                            <div className="bg-green-900/50 text-green-400 px-2 py-1 rounded text-xs flex items-center gap-1">
                              <Wifi className="w-3 h-3" />
                              Online
                            </div>
                          ) : (
                            <div className="bg-gray-700 text-gray-400 px-2 py-1 rounded text-xs flex items-center gap-1">
                              <WifiOff className="w-3 h-3" />
                              Offline
                            </div>
                          )}
                          {system.polling.isActive && (
                            <div className="bg-blue-900/50 text-blue-400 px-2 py-1 rounded text-xs flex items-center gap-1">
                              <Activity className="w-3 h-3" />
                              Polling
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {formatTime(system.lastLogin)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {formatTime(system.polling.lastPollTime)}
                      </td>
                      <td className="text-center">
                        <div className="text-sm font-mono text-yellow-400">
                          {formatPower(system.data?.solarPower)}
                        </div>
                      </td>
                      <td className="text-center">
                        <div className="text-sm font-mono text-blue-400">
                          {formatPower(system.data?.loadPower)}
                        </div>
                      </td>
                      <td className="text-center">
                        <div className={`text-sm font-mono ${
                          system.data && system.data.batteryPower > 0 
                            ? 'text-orange-400' 
                            : system.data && system.data.batteryPower < 0 
                            ? 'text-green-400' 
                            : 'text-gray-500'
                        }`}>
                          {formatPower(system.data?.batteryPower)}
                        </div>
                      </td>
                      <td className="text-center">
                        <div className={`text-sm font-mono ${
                          system.data && system.data.batterySOC > 80 
                            ? 'text-green-400' 
                            : system.data && system.data.batterySOC > 50 
                            ? 'text-yellow-400' 
                            : system.data && system.data.batterySOC > 20 
                            ? 'text-orange-400' 
                            : 'text-red-400'
                        }`}>
                          {formatSOC(system.data?.batterySOC)}
                        </div>
                      </td>
                      <td className="text-center">
                        <div className={`text-sm font-mono ${
                          system.data && Math.abs(system.data.gridPower) > 0 
                            ? 'text-purple-400' 
                            : 'text-gray-500'
                        }`}>
                          {formatPower(system.data?.gridPower)}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Total Systems</p>
                <p className="text-3xl font-bold text-white mt-1">{systems.length}</p>
              </div>
              <div className="text-blue-400">
                <Server className="w-10 h-10" />
              </div>
            </div>
          </div>
          
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Active Polling</p>
                <p className="text-3xl font-bold text-white mt-1">
                  {systems.filter(s => s.polling.isActive).length}
                </p>
              </div>
              <div className="text-green-400">
                <Gauge className="w-10 h-10" />
              </div>
            </div>
          </div>
          
          <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Users Online</p>
                <p className="text-3xl font-bold text-white mt-1">
                  {systems.filter(s => s.isLoggedIn).length}
                </p>
              </div>
              <div className="text-purple-400">
                <Users className="w-10 h-10" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}