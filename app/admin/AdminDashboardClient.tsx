'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Activity, Wifi, WifiOff, Server, Battery, Sun, Home, TrendingUp, TrendingDown, X, RefreshCw, AlertCircle, Zap, PauseCircle } from 'lucide-react'
import SystemInfoTooltip from '@/components/SystemInfoTooltip'
import SummaryCard from '@/components/SummaryCard'
import SystemActionsMenu from '@/components/SystemActionsMenu'
import PollingStatsModal from '@/components/PollingStatsModal'

interface SystemInfo {
  model?: string
  serial?: string
  ratings?: string
  solarSize?: string
  batterySize?: string
}

interface SystemData {
  systemId: number  // Our internal ID
  owner: {
    clerkId: string
    email: string | null
    userName: string | null
    firstName: string | null
    lastName: string | null
  }
  displayName: string  // Non-null from database
  vendor: {
    type: string
    siteId: string  // Vendor's identifier
    userId: string | null  // Vendor-specific user ID
  }
  status: 'active' | 'disabled' | 'removed'  // System status
  location?: any  // Location data
  systemInfo?: SystemInfo | null
  polling: {
    isActive: boolean
    lastPollTime: string | null
    lastSuccessTime: string | null
    lastErrorTime: string | null
    lastError: string | null
    consecutiveErrors: number
    totalPolls: number
    successfulPolls: number
    failedPolls: number
    successRate: number
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
  vendorType: string
  vendorSiteId: string
  did: string
  data: TestData | null
}

export default function AdminDashboardClient() {
  const [systems, setSystems] = useState<SystemData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'active' | 'removed'>('active')
  const [testModal, setTestModal] = useState<TestModalData>({
    isOpen: false,
    loading: false,
    error: null,
    systemName: '',
    ownerClerkUserId: '',
    vendorType: '',
    vendorSiteId: '',
    did: '',
    data: null
  })
  const [pollingStatsModal, setPollingStatsModal] = useState<{
    isOpen: boolean
    systemName: string
    stats: SystemData['polling'] | null
  }>({
    isOpen: false,
    systemName: '',
    stats: null
  })

  const testConnection = async (systemName: string, ownerClerkUserId: string, vendorType: string, vendorSiteId: string, isRefresh: boolean = false) => {
    if (!isRefresh) {
      // Initial load - set everything
      setTestModal({
        isOpen: true,
        loading: true,
        error: null,
        systemName,
        ownerClerkUserId,
        vendorType,
        vendorSiteId,
        did: `${vendorType}/${vendorSiteId}`,
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
        body: JSON.stringify({ ownerClerkUserId, vendorType, vendorSiteId })
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
    if (testModal.ownerClerkUserId && testModal.vendorType && testModal.vendorSiteId) {
      testConnection(testModal.systemName, testModal.ownerClerkUserId, testModal.vendorType, testModal.vendorSiteId, true)
    }
  }

  const closeTestModal = () => {
    setTestModal({
      isOpen: false,
      loading: false,
      error: null,
      systemName: '',
      ownerClerkUserId: '',
      vendorType: '',
      vendorSiteId: '',
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

  const updateSystemStatus = async (systemId: number, newStatus: 'active' | 'disabled' | 'removed') => {
    try {
      const response = await fetch(`/api/admin/systems/${systemId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to update status')
      }

      const result = await response.json()
      
      // Update local state
      setSystems(prevSystems => 
        prevSystems.map(sys => 
          sys.systemId === systemId 
            ? { ...sys, status: newStatus }
            : sys
        )
      )
      
      return result
    } catch (err) {
      console.error('Error updating system status:', err)
      alert(`Failed to update status: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
      <div className="flex flex-col h-full max-h-full">
        <div className="flex-1 px-0 md:px-6 py-8 overflow-hidden">
          {error && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6">
              {error}
            </div>
          )}
          
          {/* Systems Table */}
          <div className="bg-gray-800 border border-gray-700 md:rounded overflow-hidden flex-1 flex flex-col">
            <div className="border-b border-gray-700">
              <div className="flex items-end -mb-px">
                <button
                  onClick={() => setActiveTab('active')}
                  className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === 'active' 
                      ? 'text-white border-blue-500 bg-gray-700/50' 
                      : 'text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600'
                  }`}
                >
                  Active Systems
                </button>
                <button
                  onClick={() => setActiveTab('removed')}
                  className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors border-b-2 ${
                    activeTab === 'removed' 
                      ? 'text-white border-blue-500 bg-gray-700/50' 
                      : 'text-gray-400 border-transparent hover:text-gray-300 hover:border-gray-600'
                  }`}
                >
                  Removed
                </button>
              </div>
            </div>
          
          <div className="overflow-auto flex-1">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="w-5"></th>
                  <th className="text-left px-1.5 md:px-1.5 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    System
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Readings
                  </th>
                  <th className="text-left px-2 md:px-6 py-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Poll
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {systems
                  .filter(system => 
                    activeTab === 'active' 
                      ? system.status === 'active' || system.status === 'disabled'
                      : system.status === 'removed'
                  )
                  .map((system, index, filteredSystems) => (
                  <tr 
                    key={system.systemId}
                    className={`hover:bg-gray-700/50 transition-colors relative ${
                      system.status === 'disabled' ? 'opacity-40' : ''
                    }`}
                    style={system.status === 'removed' ? {
                      backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(251,146,60,0.15) 10px, rgba(251,146,60,0.15) 20px)'
                    } : undefined}
                  >
                    <td className="w-5 align-top pt-3 text-center">
                      <SystemActionsMenu
                        systemId={system.systemId}
                        systemName={system.displayName}
                        status={system.status}
                        onTest={() => testConnection(system.displayName, system.owner.clerkId, system.vendor.type, system.vendor.siteId)}
                        onStatusChange={(newStatus) => updateSystemStatus(system.systemId, newStatus)}
                        onPollingStats={() => {
                          setPollingStatsModal({
                            isOpen: true,
                            systemName: system.displayName,
                            stats: system.polling
                          })
                        }}
                      />
                    </td>
                    <td className="px-1.5 md:px-1.5 py-4 whitespace-nowrap align-top">
                      <Link 
                        href={`/dashboard/${system.systemId}`}
                        className="block group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                            {system.displayName}
                          </span>
                          {system.status === 'disabled' && (
                            <div className="relative group/pause">
                              <PauseCircle className="w-4 h-4 text-orange-400" />
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover/pause:opacity-100 pointer-events-none transition-opacity z-10 border border-gray-700">
                                System Disabled
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400 group-hover:text-blue-400 transition-colors">
                              {system.vendor.type}/{system.vendor.siteId}
                            </span>
                            {system.systemInfo && (
                              <div onClick={(e) => e.preventDefault()}>
                                <SystemInfoTooltip 
                                  systemInfo={system.systemInfo}
                                  systemNumber={system.vendor.siteId}
                                />
                              </div>
                            )}
                          </div>
                          {system.vendor.userId && (
                            <span className="text-xs text-gray-500">
                              {system.vendor.userId}
                            </span>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="px-2 md:px-6 py-4 whitespace-nowrap align-top">
                      <div className="text-sm">
                        <div className="text-gray-300">
                          {system.owner.userName || system.owner.clerkId || 'unknown'}
                          {(system.owner.firstName || system.owner.lastName) && (
                            <span className="text-gray-400 hidden xl:inline">
                              {' '}({system.owner.firstName || ''}{system.owner.firstName && system.owner.lastName ? ' ' : ''}{system.owner.lastName || ''})
                            </span>
                          )}
                        </div>
                        {(system.owner.firstName || system.owner.lastName) && (
                          <div className="text-xs text-gray-400 xl:hidden">
                            {system.owner.firstName || ''}{system.owner.firstName && system.owner.lastName ? ' ' : ''}{system.owner.lastName || ''}
                          </div>
                        )}
                        {system.owner.email && (
                          <a 
                            href={`mailto:${system.owner.email}`}
                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                          >
                            {system.owner.email}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-2 md:px-6 py-4 whitespace-nowrap">
                      {system.data ? (
                        <div className="text-sm">
                          <div className="flex flex-col items-start gap-1 xl:flex-row xl:items-center xl:gap-4">
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
                    <td className="px-2 md:px-6 py-4 whitespace-nowrap align-baseline">
                      <div className="sm:block flex flex-col min-h-full">
                        <div>
                          {!system.polling.isActive ? (
                            <div>
                              <span className="text-sm text-red-400">Polling disabled</span>
                            </div>
                          ) : system.polling.lastPollTime ? (
                            <div className="text-xs text-gray-400">
                              <Clock className="w-3 h-3 inline mr-1" />
                              {(() => {
                                const pollDate = new Date(system.polling.lastPollTime)
                                const today = new Date()
                                const isToday = 
                                  pollDate.getDate() === today.getDate() &&
                                  pollDate.getMonth() === today.getMonth() &&
                                  pollDate.getFullYear() === today.getFullYear()
                                
                                if (isToday) {
                                  return pollDate.toLocaleTimeString()
                                } else {
                                  return (
                                    <>
                                      <div>{pollDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                                      <div className="ml-4">{pollDate.toLocaleTimeString()}</div>
                                    </>
                                  )
                                }
                              })()}
                            </div>
                          ) : (
                            <span className="text-sm text-gray-500">Never</span>
                          )}
                          {system.polling.lastError && (
                            <p className="text-xs text-red-400 mt-1 max-w-xs truncate" title={system.polling.lastError}>
                              {system.polling.lastError}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </div>
        
        {/* Summary Cards - Pinned to bottom */}
        <div className="px-4 pb-2">
          <div className="flex gap-2 w-full">
            <SummaryCard 
              label="Total Systems"
              value={systems.length}
              icon={Server}
              iconColor="text-blue-400"
            />
            <SummaryCard 
              label="Active Systems"
              value={systems.filter(s => s.status === 'active').length}
              icon={Activity}
              iconColor="text-green-400"
            />
            <SummaryCard 
              label="Total Solar"
              value={`${(systems.reduce((sum, s) => sum + (s.data?.solarPower || 0), 0) / 1000).toFixed(1)} kW`}
              icon={Sun}
              iconColor="text-yellow-400"
            />
          </div>
        </div>
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

      {/* Polling Stats Modal */}
      {pollingStatsModal.isOpen && pollingStatsModal.stats && (
        <PollingStatsModal
          isOpen={pollingStatsModal.isOpen}
          onClose={() => setPollingStatsModal({ isOpen: false, systemName: '', stats: null })}
          systemName={pollingStatsModal.systemName}
          stats={pollingStatsModal.stats}
        />
      )}
      </>
  )
}