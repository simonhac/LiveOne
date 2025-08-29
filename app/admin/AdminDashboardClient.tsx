'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Activity, Wifi, WifiOff, Server, Zap, Battery, Sun, Home, TrendingUp, TrendingDown, X, RefreshCw, AlertCircle } from 'lucide-react'
import SystemInfoTooltip from '@/components/SystemInfoTooltip'

interface SystemInfo {
  model?: string
  serial?: string
  ratings?: string
  solarSize?: string
  batterySize?: string
}

interface SystemData {
  owner: string
  ownerClerkUserId: string
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

interface TestData {
  latest: {
    timestamp: string
    power: {
      solarW: number
      loadW: number
      batteryW: number
      gridW: number
    }
    soc: {
      battery: number
    }
    energy: {
      today: {
        solarKwh: number
        loadKwh: number
        batteryInKwh: number
        batteryOutKwh: number
        gridInKwh: number
        gridOutKwh: number
      }
    }
  }
  systemInfo?: {
    model?: string | null
    serial?: string | null
    ratings?: string | null
    solarSize?: string | null
    batterySize?: string | null
  }
}

interface TestModalData {
  isOpen: boolean
  loading: boolean
  error: string | null
  systemName: string
  ownerClerkUserId: string
  did: string
  data: TestData | null
}

export default function AdminDashboardClient() {
  const [systems, setSystems] = useState<SystemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [testModal, setTestModal] = useState<TestModalData>({
    isOpen: false,
    loading: false,
    error: null,
    systemName: '',
    ownerClerkUserId: '',
    did: '',
    data: null
  })

  const testConnection = async (systemName: string, ownerClerkUserId: string, did: string, isRefresh: boolean = false) => {
    if (!isRefresh) {
      // Initial load - set everything
      setTestModal({
        isOpen: true,
        loading: true,
        error: null,
        systemName,
        ownerClerkUserId,
        did,
        data: null
      })
    } else {
      // Refresh - only set loading to true, keep existing data
      setTestModal(prev => ({
        ...prev,
        loading: true,
        error: null
      }))
    }

    try {
      const response = await fetch('/api/admin/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clerkUserId: ownerClerkUserId, did })
      })

      const result = await response.json()

      if (!response.ok) {
        setTestModal(prev => ({
          ...prev,
          loading: false,
          error: result.error || 'Failed to test connection'
        }))
        return
      }

      setTestModal(prev => ({
        ...prev,
        loading: false,
        error: null,
        data: result.latest ? {
          latest: result.latest,
          systemInfo: result.systemInfo
        } : null
      }))
    } catch (err) {
      setTestModal(prev => ({
        ...prev,
        loading: false,
        error: 'Network error: Failed to connect'
      }))
    }
  }

  const refreshTest = () => {
    if (testModal.ownerClerkUserId) {
      testConnection(testModal.systemName, testModal.ownerClerkUserId, testModal.did, true)
    }
  }

  const closeTestModal = () => {
    setTestModal({
      isOpen: false,
      loading: false,
      error: null,
      systemName: '',
      ownerClerkUserId: '',
      did: '',
      data: null
    })
  }

  const fetchSystems = async () => {
    try {
      const response = await fetch('/api/admin/systems')
      
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/sign-in'
          return
        }
        throw new Error('Failed to fetch systems')
      }
      
      const data = await response.json()
      
      if (data.success) {
        setSystems(data.systems || [])
        setLastUpdate(new Date())
        setError(null)
      } else {
        setError(data.error || 'Failed to load systems')
      }
    } catch (err) {
      console.error('Error fetching systems:', err)
      setError('Failed to connect to server')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSystems()
    const interval = setInterval(fetchSystems, 30000) // Refresh every 30 seconds
    
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading admin dashboard...</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="px-6 py-8">
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}
        
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-800 border border-gray-700 rounded p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Total Systems</p>
                <p className="text-2xl font-bold text-white">{systems.length}</p>
              </div>
              <Server className="w-8 h-8 text-blue-400" />
            </div>
          </div>
          
          <div className="bg-gray-800 border border-gray-700 rounded p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Active Systems</p>
                <p className="text-2xl font-bold text-white">
                  {systems.filter(s => s.polling.isActive).length}
                </p>
              </div>
              <Activity className="w-8 h-8 text-green-400" />
            </div>
          </div>
          
          <div className="bg-gray-800 border border-gray-700 rounded p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Total Solar</p>
                <p className="text-2xl font-bold text-white">
                  {(systems.reduce((sum, s) => sum + (s.data?.solarPower || 0), 0) / 1000).toFixed(1)} kW
                </p>
              </div>
              <Sun className="w-8 h-8 text-yellow-400" />
            </div>
          </div>
        </div>
        
        {/* Systems Table */}
        <div className="bg-gray-800 border border-gray-700 rounded overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-semibold text-white">Registered Systems</h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    System
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Latest Readings
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Poll
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {systems.map((system) => (
                  <tr 
                    key={system.systemNumber}
                    className="hover:bg-gray-700/50 transition-colors"
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <Link 
                          href={`/dashboard/${system.systemNumber}`}
                          className="text-sm font-medium text-white hover:text-blue-400 transition-colors"
                        >
                          {system.displayName || `System ${system.systemNumber}`}
                        </Link>
                        <div className="flex items-center gap-2">
                          <Link 
                            href={`/dashboard/${system.systemNumber}`}
                            className="text-xs text-gray-400 hover:text-blue-400 transition-colors flex items-center gap-1"
                          >
                            #{system.systemNumber}
                          </Link>
                          <SystemInfoTooltip 
                            systemInfo={system.systemInfo}
                            systemNumber={system.systemNumber}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-sm text-gray-300">{system.owner}</p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {system.polling.isActive ? (
                          <span className="flex items-center gap-1">
                            <Wifi className="w-4 h-4 text-green-400" />
                            <span className="text-sm text-green-400">Active</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <WifiOff className="w-4 h-4 text-red-400" />
                            <span className="text-sm text-red-400">Inactive</span>
                          </span>
                        )}
                      </div>
                      {system.polling.lastError && (
                        <p className="text-xs text-red-400 mt-1 max-w-xs truncate" title={system.polling.lastError}>
                          {system.polling.lastError}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {system.data ? (
                        <div className="text-sm">
                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-1.5">
                              <Sun className="w-3.5 h-3.5 text-yellow-400" />
                              <span className="text-yellow-400">{(system.data.solarPower / 1000).toFixed(1)} kW</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Home className="w-3.5 h-3.5 text-blue-400" />
                              <span className="text-blue-400">{(system.data.loadPower / 1000).toFixed(1)} kW</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Battery className="w-3.5 h-3.5 text-green-400" />
                              <span className="text-green-400">{system.data.batterySOC.toFixed(1)}%</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-sm text-gray-500">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {system.polling.lastPollTime ? (
                        <div className="text-xs text-gray-400">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {new Date(system.polling.lastPollTime).toLocaleTimeString()}
                        </div>
                      ) : (
                        <span className="text-sm text-gray-500">Never</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button
                        onClick={() => testConnection(
                          system.displayName || `System ${system.systemNumber}`,
                          system.ownerClerkUserId,
                          system.systemNumber
                        )}
                        disabled={!system.ownerClerkUserId}
                        className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                      >
                        <Zap className="w-4 h-4" />
                        Test
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        
        {lastUpdate && (
          <div className="mt-4 text-center text-xs text-gray-500">
            Last updated: {lastUpdate.toLocaleTimeString()}
          </div>
        )}
      </div>
      
      {/* Test Connection Modal - Outside main content */}
      {testModal.isOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 overflow-y-auto">
          <div className="bg-gray-800/95 backdrop-blur border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg font-semibold text-white">
                  {testModal.systemName} — Test Connection
                </h3>
                <button
                  onClick={closeTestModal}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              {testModal.error && (
                <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-4">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-red-400" />
                    <p className="text-red-400">{testModal.error}</p>
                  </div>
                </div>
              )}
              
              {(testModal.loading && !testModal.data) && (
                <div className="text-center py-8">
                  <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-gray-400">Connecting to Select.Live...</p>
                </div>
              )}
              
              {testModal.data && (
                <div className="relative">
                  {testModal.loading && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      <div className="bg-gray-800/90 rounded-lg p-4 flex items-center gap-3">
                        <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-gray-300">Refreshing...</span>
                      </div>
                    </div>
                  )}
                  <div className={`space-y-4 transition-opacity ${testModal.loading ? 'opacity-40' : ''}`}>
                  {/* Power Flow Section */}
                  <div className="bg-gray-900 rounded-lg p-4">
                    <h4 className="text-sm font-semibold text-gray-400 mb-3">Current Power Flow</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="flex items-start gap-2">
                        <Sun className="w-5 h-5 text-yellow-400 mt-0.5" />
                        <div>
                          <p className="text-xs text-gray-400">Solar</p>
                          <p className="text-lg font-semibold text-yellow-400">
                            {(testModal.data.latest.power.solarW / 1000).toFixed(1)} kW
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex items-start gap-2">
                        <Home className="w-5 h-5 text-blue-400 mt-0.5" />
                        <div>
                          <p className="text-xs text-gray-400">Load</p>
                          <p className="text-lg font-semibold text-blue-400">
                            {(testModal.data.latest.power.loadW / 1000).toFixed(1)} kW
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex items-start gap-2">
                        <Battery className="w-5 h-5 text-green-400 mt-0.5" />
                        <div>
                          <p className="text-xs text-gray-400">Battery</p>
                          <p className="text-lg font-semibold text-green-400">
                            {testModal.data.latest.soc.battery.toFixed(1)}%
                          </p>
                          <p className="text-xs text-gray-400">
                            {testModal.data.latest.power.batteryW < 0 
                              ? `Charging ${Math.abs(testModal.data.latest.power.batteryW / 1000).toFixed(1)} kW`
                              : testModal.data.latest.power.batteryW > 0
                              ? `Discharging ${(testModal.data.latest.power.batteryW / 1000).toFixed(1)} kW`
                              : 'Idle'}
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex items-start gap-2">
                        <Zap className="w-5 h-5 text-purple-400 mt-0.5" />
                        <div>
                          <p className="text-xs text-gray-400">Grid</p>
                          <p className="text-lg font-semibold text-purple-400">
                            {Math.abs(testModal.data.latest.power.gridW / 1000).toFixed(1)} kW
                          </p>
                          <p className="text-xs text-gray-400">
                            {testModal.data.latest.power.gridW > 0 ? 'Importing' : testModal.data.latest.power.gridW < 0 ? 'Exporting' : 'No flow'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Today's Energy Section */}
                  <div className="bg-gray-900 rounded-lg p-4">
                    <h4 className="text-sm font-semibold text-gray-400 mb-3">Today&apos;s Energy</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Sun className="w-3 h-3" /> Solar Generated
                          </span>
                          <span className="text-sm text-yellow-400">{testModal.data.latest.energy.today.solarKwh.toFixed(1)} kWh</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Home className="w-3 h-3" /> Load Consumed
                          </span>
                          <span className="text-sm text-blue-400">{testModal.data.latest.energy.today.loadKwh.toFixed(1)} kWh</span>
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <TrendingDown className="w-3 h-3" /> Battery In
                          </span>
                          <span className="text-sm text-green-400">{testModal.data.latest.energy.today.batteryInKwh.toFixed(1)} kWh</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <TrendingUp className="w-3 h-3" /> Battery Out
                          </span>
                          <span className="text-sm text-orange-400">{testModal.data.latest.energy.today.batteryOutKwh.toFixed(1)} kWh</span>
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Zap className="w-3 h-3" /> Grid Import
                          </span>
                          <span className="text-sm text-purple-400">{testModal.data.latest.energy.today.gridInKwh.toFixed(1)} kWh</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Zap className="w-3 h-3" /> Grid Export
                          </span>
                          <span className="text-sm text-purple-400">{testModal.data.latest.energy.today.gridOutKwh.toFixed(1)} kWh</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* System Information */}
                  {testModal.data.systemInfo && (
                    <div className="bg-gray-900 rounded-lg p-4">
                      <h4 className="text-sm font-semibold text-gray-400 mb-3">System Information</h4>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                        {testModal.data.systemInfo.model && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Model:</span>
                            <span className="text-white text-right">{testModal.data.systemInfo.model}</span>
                          </div>
                        )}
                        {testModal.data.systemInfo.serial && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Serial:</span>
                            <span className="text-white text-right">{testModal.data.systemInfo.serial}</span>
                          </div>
                        )}
                        {testModal.data.systemInfo.ratings && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Ratings:</span>
                            <span className="text-white text-right">{testModal.data.systemInfo.ratings}</span>
                          </div>
                        )}
                        {testModal.data.systemInfo.solarSize && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Solar Size:</span>
                            <span className="text-white text-right">{testModal.data.systemInfo.solarSize}</span>
                          </div>
                        )}
                        {testModal.data.systemInfo.batterySize && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Battery:</span>
                            <span className="text-white text-right">{testModal.data.systemInfo.batterySize}</span>
                          </div>
                        )}
                        {!testModal.data.systemInfo.model && !testModal.data.systemInfo.serial && 
                         !testModal.data.systemInfo.ratings && !testModal.data.systemInfo.solarSize && 
                         !testModal.data.systemInfo.batterySize && (
                          <div className="col-span-2 text-gray-500 italic">
                            System information not available
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  </div>
                </div>
              )}
              
              {/* Action Buttons and Last Update */}
              <div className="flex justify-between items-end mt-6">
                {testModal.data && (
                  <div className="text-xs text-gray-500 pb-2">
                    Last update: {new Date(testModal.data.latest.timestamp).toLocaleString('en-AU', { 
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    })}
                  </div>
                )}
                {!testModal.data && <div></div>}
                <div className="flex gap-2">
                  {testModal.data && (
                    <button
                      onClick={refreshTest}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Refresh
                    </button>
                  )}
                  <button
                    onClick={closeTestModal}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
  )
}