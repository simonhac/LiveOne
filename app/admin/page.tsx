'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

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

  const handleLogout = () => {
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
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <div className="text-xl">Loading systems...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-blue-400">LiveOne Admin</h1>
              <p className="text-sm text-gray-400">System Overview Dashboard</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm text-gray-400">
                Last update: {lastUpdate ? formatTime(lastUpdate.toISOString()) : 'Never'}
              </div>
              <button
                onClick={handleLogout}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-900/50 border border-red-700 rounded-lg text-red-200">
            {error}
          </div>
        )}

        {/* Systems Table */}
        <div className="bg-gray-900 rounded-lg overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-800">
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
              <tbody className="divide-y divide-gray-800">
                {systems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-8 text-center text-gray-500">
                      No systems registered
                    </td>
                  </tr>
                ) : (
                  systems.map((system) => (
                    <tr key={system.systemNumber} className="hover:bg-gray-800/50 transition-colors">
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
                              {/* Info Icon */}
                              <svg
                                className="w-4 h-4 text-blue-400 cursor-help"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                />
                              </svg>
                              
                              {/* System Info Panel */}
                              {hoveredSystem === system.systemNumber && (
                                <div className="absolute z-50 left-6 top-0 ml-2 w-72 p-4 bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
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
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {system.isLoggedIn ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-400 border border-green-800">
                              Online
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700">
                              Offline
                            </span>
                          )}
                          {system.polling.isActive && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-900/50 text-blue-400 border border-blue-800">
                              Polling
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {formatTime(system.lastLogin)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                        {formatTime(system.polling.lastPollTime)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="text-sm font-mono text-yellow-400">
                          {formatPower(system.data?.solarPower)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="text-sm font-mono text-orange-400">
                          {formatPower(system.data?.loadPower)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className={`text-sm font-mono ${
                          system.data && system.data.batteryPower > 0 
                            ? 'text-green-400' 
                            : system.data && system.data.batteryPower < 0 
                            ? 'text-red-400' 
                            : 'text-gray-400'
                        }`}>
                          {formatPower(system.data?.batteryPower)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
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
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className={`text-sm font-mono ${
                          system.data && Math.abs(system.data.gridPower) > 0 
                            ? 'text-purple-400' 
                            : 'text-gray-400'
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
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-900 rounded-lg p-6">
            <div className="text-sm text-gray-400 mb-2">Total Systems</div>
            <div className="text-3xl font-bold text-blue-400">{systems.length}</div>
          </div>
          <div className="bg-gray-900 rounded-lg p-6">
            <div className="text-sm text-gray-400 mb-2">Active Polling</div>
            <div className="text-3xl font-bold text-green-400">
              {systems.filter(s => s.polling.isActive).length}
            </div>
          </div>
          <div className="bg-gray-900 rounded-lg p-6">
            <div className="text-sm text-gray-400 mb-2">Users Online</div>
            <div className="text-3xl font-bold text-purple-400">
              {systems.filter(s => s.isLoggedIn).length}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}