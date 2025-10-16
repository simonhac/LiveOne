'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import EnergyChart from '@/components/EnergyChart'
import EnergyPanel from '@/components/EnergyPanel'
import MobileMenu from '@/components/MobileMenu'
import LastUpdateTime from '@/components/LastUpdateTime'
import SystemInfoTooltip from '@/components/SystemInfoTooltip'
import PowerCard from '@/components/PowerCard'
import ConnectionNotification from '@/components/ConnectionNotification'
import TestConnectionModal from '@/components/TestConnectionModal'
import ServerErrorModal from '@/components/ServerErrorModal'
import SessionTimeoutModal from '@/components/SessionTimeoutModal'
import { AddSystemDialog } from '@/components/AddSystemDialog'
import SystemsMenu from '@/components/SystemsMenu'
import ViewDataModal from '@/components/ViewDataModal'
import MondoPowerChart, { type ChartData } from '@/components/MondoPowerChart'
import EnergyTable from '@/components/EnergyTable'
import PeriodSwitcher from '@/components/PeriodSwitcher'
import { formatDateTime } from '@/lib/fe-date-format'
import { formatDateRange, fromUnixTimestamp } from '@/lib/date-utils'
import { format } from 'date-fns'
import {
  Sun,
  Home,
  Battery,
  Zap,
  AlertTriangle,
  Shield,
  ChevronDown,
  Settings as SettingsIcon,
  FlaskConical,
  Plus,
  MoreHorizontal
} from 'lucide-react'
import Link from 'next/link'

interface SystemInfo {
  model?: string;
  serial?: string;
  ratings?: string;
  solarSize?: string;
  batterySize?: string;
}

interface DashboardData {
  timezoneOffsetMin?: number;
  latest: {
    timestamp: string;
    power: {
      solarW: number;
      solarLocalW: number | null;
      solarRemoteW: number | null;
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
      faultCode: number | null;
      faultTimestamp: number | null;
      generatorStatus: number | null;
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
  systemNumber?: string;
  displayName?: string;
  vendorType?: string;
  vendorSiteId?: string;
  ownerClerkUserId?: string;
  supportsPolling?: boolean;
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
}

interface DashboardClientProps {
  systemId?: string;
  system?: any;  // System object from database
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  availableSystems?: AvailableSystem[];
  userId?: string;
  dataStore?: 'readings' | 'point_readings';
}

// Helper function to get stale threshold based on vendor type
function getStaleThreshold(vendorType?: string): number {
  // 35 minutes (2100 seconds) for Enphase, 5 minutes (300 seconds) for select.live and craighack
  return vendorType === 'enphase' ? 2100 : 300;
}

export default function DashboardClient({ systemId, system, hasAccess, systemExists, isAdmin: isAdminProp, availableSystems = [], userId, dataStore }: DashboardClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [isAdmin, setIsAdmin] = useState(isAdminProp)
  const [showSystemDropdown, setShowSystemDropdown] = useState(false)
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false)
  const [showTestConnection, setShowTestConnection] = useState(false)
  const [showAddSystemDialog, setShowAddSystemDialog] = useState(false)
  const [serverError, setServerError] = useState<{ type: 'connection' | 'server' | null, details?: string }>({ type: null })
  const [showSessionTimeout, setShowSessionTimeout] = useState(false)
  const [showViewDataModal, setShowViewDataModal] = useState(false)
  const [mondoPeriod, setMondoPeriod] = useState<'1D' | '7D' | '30D'>('1D')
  const [loadChartData, setLoadChartData] = useState<ChartData | null>(null)
  const [generationChartData, setGenerationChartData] = useState<ChartData | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null) // Single hover index for both charts
  const dropdownRef = useRef<HTMLDivElement>(null)
  const settingsDropdownRef = useRef<HTMLDivElement>(null)

  // Function to fetch data from API
  const fetchData = useCallback(async () => {
    try {
      // systemId is now required
      if (!systemId) {
        setError('No system ID provided')
        setLoading(false)
        return
      }
      const url = `/api/data?systemId=${systemId}`
      const response = await fetch(url)
      
      // Check for token expiration specifically
      if (response.status === 404) {
        // Check the Clerk auth headers to see if this is due to token expiration
        const authStatus = response.headers.get('x-clerk-auth-status')
        const authReason = response.headers.get('x-clerk-auth-reason')
        const authMessage = response.headers.get('x-clerk-auth-message')
        
        if (authStatus === 'signed-out' || 
            authReason?.includes('token-expired') || 
            authMessage?.includes('expired')) {
          console.log('Session token expired')
          console.log('Auth message:', authMessage)
          // Show session timeout modal
          setShowSessionTimeout(true)
          setLoading(false)
          return
        }
        // Otherwise it's a real 404 - system doesn't exist
      }
      
      // Check for other non-OK responses
      if (!response.ok) {
        // Check if the response is HTML (like a 404 page) instead of JSON
        const contentType = response.headers.get('content-type')
        if (contentType && !contentType.includes('application/json')) {
          // If we get an HTML response, it's likely a token expiration that wasn't caught above
          console.log('Non-JSON response received, likely token expired')
          setShowSessionTimeout(true)
          setLoading(false)
          return
        }
        throw new Error(`Failed to fetch data: ${response.status}`)
      }
      
      const result = await response.json()
      
      // Check if we have latest data (system info is always present)
      if (result.latest) {
        setData(result)
        
        // Parse timestamp (now in AEST format)
        const dataTimestamp = new Date(result.latest.timestamp)
        setLastUpdate(dataTimestamp)
        
        // Calculate seconds since update
        const secondsAgo = Math.floor((Date.now() - dataTimestamp.getTime()) / 1000)
        setSecondsSinceUpdate(secondsAgo)
        
        
        setSystemInfo(result.systemInfo || null)
        setError('')
        setLoading(false)
      } else if (result.error) {
        setError(result.error)
        setLoading(false)
      } else {
        // We have system info but no readings yet
        setData(result)
        setSystemInfo(result.systemInfo || null)
        // Don't show error for removed systems
        if (system?.status !== 'removed') {
          // Show different message for point_readings systems
          if (dataStore === 'point_readings') {
            setError('POINT_READINGS_NO_CHARTS') // Special marker for point_readings systems
          } else {
            setError('No readings available yet')
          }
        }
        setLoading(false)
      }
    } catch (err) {
      console.error('Error fetching data:', err)
      
      // Check if error message indicates a 404 (which might mean token expired)
      if (err instanceof Error && err.message.includes('404')) {
        console.log('Session might be expired (404 error)')
        // Show session timeout modal
        setShowSessionTimeout(true)
        setLoading(false)
        return
      }
      
      // Check if it's a network/connection error
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        setServerError({ type: 'connection' })
        setError('Unable to connect to server')
      } else {
        setError('Failed to fetch data')
      }
      setLoading(false)
    }
  }, [systemId, system?.status, dataStore])

  useEffect(() => {
    // Initial fetch
    fetchData()

    // Set up polling interval (30 seconds)
    const interval = setInterval(fetchData, 30000)

    // Cleanup on unmount
    return () => {
      clearInterval(interval)
    }
  }, [fetchData])

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
  }, [lastUpdate, fetchData])

  // Handle clicks outside of the dropdowns
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSystemDropdown(false)
      }
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(event.target as Node)) {
        setShowSettingsDropdown(false)
      }
    }

    if (showSystemDropdown || showSettingsDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSystemDropdown, showSettingsDropdown])

  // Show access denied message if user doesn't have access
  if (!hasAccess || !systemExists) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">Access Denied</h2>
          <p className="text-gray-400 mb-6">
            You don&apos;t have permission to view this system. Please contact your system administrator if you believe this is an error.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            <Home className="w-4 h-4" />
            Go to Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const handleLogout = async () => {
    router.push('/sign-in')
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
    return `${(watts / 1000).toFixed(1)}\u00A0kW`
  }

  // Determine the appropriate unit for an energy value

  // Automatically determine if grid information should be shown
  const showGrid = data?.latest ? (
    (data.latest.energy.total.gridInKwh || 0) > 0 || 
    (data.latest.energy.total.gridOutKwh || 0) > 0
  ) : false

  // Get display name for the system
  const systemDisplayName = data?.displayName || (systemId ? `System ${data?.systemNumber || systemId}` : 'LiveOne Dashboard')

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Connection Notification */}
      <ConnectionNotification />
      
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 py-2 sm:py-4">
          {/* Mobile Layout */}
          <MobileMenu
            displayName={systemDisplayName}
            secondsSinceUpdate={!lastUpdate ? 0 : secondsSinceUpdate}
            onLogout={handleLogout}
            systemInfo={systemInfo}
            availableSystems={availableSystems}
            currentSystemId={systemId as string}
            onTestConnection={() => setShowTestConnection(true)}
            vendorType={data?.vendorType}
            supportsPolling={data?.supportsPolling}
            isAdmin={isAdmin}
            systemStatus={system?.status}
            userId={userId}
          />

          {/* Desktop Layout */}
          <div className="hidden sm:flex justify-between items-center">
            <div className="relative" ref={dropdownRef}>
              {availableSystems.length > 1 ? (
                <>
                  <button
                    onClick={() => setShowSystemDropdown(!showSystemDropdown)}
                    className="flex items-center gap-2 hover:bg-gray-700 rounded-lg px-3 py-2 transition-colors"
                  >
                    <h1 className="text-2xl font-bold text-white">{systemDisplayName}</h1>
                    <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${showSystemDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  
                  {showSystemDropdown && (
                    <div className="absolute top-full left-0 mt-2 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                      <div className="py-1">
                        <SystemsMenu
                          availableSystems={availableSystems}
                          currentSystemId={systemId}
                          userId={userId}
                          isAdmin={isAdmin}
                          onSystemSelect={() => setShowSystemDropdown(false)}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <h1 className="text-2xl font-bold text-white">{systemDisplayName}</h1>
              )}
            </div>
            <div className="flex items-center gap-4">
              <LastUpdateTime 
                secondsSinceUpdate={!lastUpdate ? 0 : secondsSinceUpdate}
              />
              {systemInfo && (
                <SystemInfoTooltip 
                  systemInfo={systemInfo}
                  systemNumber={data?.systemNumber || ""}
                />
              )}
              {isAdmin && (
                <Link
                  href="/admin"
                  className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  <Shield className="w-4 h-4" />
                  Admin
                </Link>
              )}
              {/* Settings dropdown - Only show for admin or non-removed systems */}
              {(isAdmin || system?.status !== 'removed') && (
              <div className="relative" ref={settingsDropdownRef}>
                <button
                  onClick={() => setShowSettingsDropdown(!showSettingsDropdown)}
                  className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                  title="Settings"
                >
                  <SettingsIcon className="w-5 h-5" />
                </button>
                
                {showSettingsDropdown && (
                  <div className="absolute right-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                    {/* Track if we have any items above the divider */}
                    {(() => {
                      const hasItemsAbove = data?.supportsPolling;
                      return (
                        <>
                          {/* Test Connection - Only show for vendors that support polling */}
                          {data?.supportsPolling && (
                            <button
                              onClick={() => {
                                setShowTestConnection(true)
                                setShowSettingsDropdown(false)
                              }}
                              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                            >
                              <FlaskConical className="w-4 h-4" />
                              Test Connection
                            </button>
                          )}
                          
                          {/* Show divider if there are items above */}
                          {hasItemsAbove && <div className="border-t border-gray-700 my-1"></div>}
                          
                          {/* Always show Add System */}
                          <button
                            onClick={() => {
                              setShowSettingsDropdown(false);
                              setShowAddSystemDialog(true);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                          >
                            <Plus className="w-4 h-4" />
                            Add System…
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              )}
              <UserButton 
                afterSignOutUrl="/sign-in"
                appearance={{
                  elements: {
                    avatarBox: "w-8 h-8"
                  }
                }}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-1 sm:px-6 lg:px-8 py-4">
        {/* Removed System Banner - Show regardless of data availability */}
        {system?.status === 'removed' && (
          <div className="mb-4 p-4 bg-orange-900/50 border border-orange-700 text-orange-300 rounded-lg flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <div>
              <span className="font-semibold">This system has been marked as removed.</span>
              {!isAdmin && <span> Limited access is available.</span>}
            </div>
          </div>
        )}

        {error && (
          error === 'POINT_READINGS_NO_CHARTS' && data?.vendorType !== 'mondo' ? (
            <div className="bg-blue-900/50 border border-blue-700 text-blue-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              <span>
                Charts coming soon. For now{' '}
                <button
                  onClick={() => setShowViewDataModal(true)}
                  className="underline hover:text-blue-200 transition-colors"
                >
                  raw data is available
                </button>
                .
              </span>
            </div>
          ) : error !== 'POINT_READINGS_NO_CHARTS' ? (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          ) : null
        )}

        {(data?.latest || (data && data.vendorType === 'mondo')) && (
          <div className="space-y-6">

            {/* Fault Warning */}
            {data.latest?.system.faultCode && data.latest.system.faultCode !== 0 && data.latest.system.faultTimestamp && data.latest.system.faultTimestamp > 0 && (
              <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                <div>
                  <span className="font-semibold">Fault Code {data.latest.system.faultCode}</span> encountered at {formatDateTime(new Date(data.latest.system.faultTimestamp * 1000)).display}
                </div>
              </div>
            )}

            {/* Main Dashboard Grid - Only show for admin or non-removed systems */}
            {(isAdmin || system?.status !== 'removed') && (
            <div className={data?.vendorType === 'mondo' ? '' : 'grid grid-cols-1 lg:grid-cols-3 gap-4'}>
              {/* Charts - Full width for mondo, 2/3 width for others */}
              <div className={data?.vendorType === 'mondo' ? '' : 'lg:col-span-2'}>
                {data?.vendorType === 'mondo' ? (
                  // For mondo systems, show charts with tables
                  <div className="space-y-6">
                    {/* Shared header with date/time and period switcher */}
                    <div className="bg-gray-800 border border-gray-700 rounded p-4">
                      <div className="flex justify-between items-center">
                        <h2 className="text-lg font-medium text-gray-200">Power Charts</h2>
                        <div className="flex items-center gap-4">
                          <span className="text-sm text-gray-400" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
                            {hoveredIndex !== null && (loadChartData || generationChartData) ? (
                              // Show hovered timestamp from whichever chart has data
                              format(
                                loadChartData?.timestamps[hoveredIndex] || generationChartData?.timestamps[hoveredIndex] || new Date(),
                                mondoPeriod === '1D' ? 'h:mma' : mondoPeriod === '7D' ? 'EEE, d MMM h:mma' : 'EEE, d MMM'
                              )
                            ) : (
                              // Show date range from actual chart data when not hovering
                              (() => {
                                const chartData = loadChartData || generationChartData
                                // Get timezone offset from API data or system prop
                                const timezoneOffset = data?.timezoneOffsetMin ?? system?.timezoneOffsetMin
                                if (!timezoneOffset) {
                                  return 'Loading...' // No timezone data yet
                                }
                                if (chartData && chartData.timestamps.length > 0) {
                                  const start = fromUnixTimestamp(chartData.timestamps[0].getTime() / 1000, timezoneOffset)
                                  const end = fromUnixTimestamp(chartData.timestamps[chartData.timestamps.length - 1].getTime() / 1000, timezoneOffset)
                                  return formatDateRange(start, end, true)  // Include times
                                } else {
                                  // Fallback to calculated range if no data yet
                                  const now = new Date()
                                  let windowHours: number
                                  if (mondoPeriod === '1D') windowHours = 24
                                  else if (mondoPeriod === '7D') windowHours = 24 * 7
                                  else windowHours = 24 * 30
                                  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000)
                                  const start = fromUnixTimestamp(windowStart.getTime() / 1000, timezoneOffset)
                                  const end = fromUnixTimestamp(now.getTime() / 1000, timezoneOffset)
                                  return formatDateRange(start, end, true)  // Include times
                                }
                              })()
                            )}
                          </span>
                          <PeriodSwitcher
                            value={mondoPeriod}
                            onChange={(newPeriod) => {
                              setMondoPeriod(newPeriod)
                              const params = new URLSearchParams(searchParams.toString())
                              params.set('period', newPeriod)
                              router.push(`?${params.toString()}`, { scroll: false })
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Loads Chart with Table */}
                    <div className="bg-gray-800 border border-gray-700 rounded p-4">
                      <div className="flex gap-4">
                        <div className="flex-1">
                          <MondoPowerChart
                            systemId={parseInt(systemId as string)}
                            mode="load"
                            title="Loads"
                            className="h-full min-h-[375px]"
                            period={mondoPeriod}
                            onPeriodChange={(newPeriod) => {
                              setMondoPeriod(newPeriod)
                              const params = new URLSearchParams(searchParams.toString())
                              params.set('period', newPeriod)
                              router.push(`?${params.toString()}`, { scroll: false })
                            }}
                            showPeriodSwitcher={false}
                            onDataChange={setLoadChartData}
                            onHoverIndexChange={setHoveredIndex}
                          />
                        </div>
                        <div className="w-64">
                          <EnergyTable
                            chartData={loadChartData}
                            mode="load"
                            hoveredIndex={hoveredIndex}
                            className="h-full"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Generation Chart with Table */}
                    <div className="bg-gray-800 border border-gray-700 rounded p-4">
                      <div className="flex gap-4">
                        <div className="flex-1">
                          <MondoPowerChart
                            systemId={parseInt(systemId as string)}
                            mode="generation"
                            title="Generation"
                            className="h-full min-h-[375px]"
                            period={mondoPeriod}
                            onPeriodChange={(newPeriod) => {
                              setMondoPeriod(newPeriod)
                              const params = new URLSearchParams(searchParams.toString())
                              params.set('period', newPeriod)
                              router.push(`?${params.toString()}`, { scroll: false })
                            }}
                            showPeriodSwitcher={false}
                            onDataChange={setGenerationChartData}
                            onHoverIndexChange={setHoveredIndex}
                          />
                        </div>
                        <div className="w-64">
                          <EnergyTable
                            chartData={generationChartData}
                            mode="generation"
                            hoveredIndex={hoveredIndex}
                            className="h-full"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  // For other systems, show the regular energy chart
                  <EnergyChart
                    systemId={parseInt(systemId as string)}
                    vendorType={data?.vendorType}
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
                )}
              </div>

              {/* Power Cards - 1/3 width on desktop, horizontal on mobile - Only for systems with latest data */}
              {data.latest && (
              <div className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-4 px-1">
                <PowerCard
                  title="Solar"
                  value={formatPower(data.latest.power.solarW)}
                  icon={<Sun className="w-6 h-6" />}
                  iconColor="text-yellow-400"
                  bgColor="bg-yellow-900/20"
                  borderColor="border-yellow-700"
                  secondsSinceUpdate={secondsSinceUpdate}
                  staleThresholdSeconds={getStaleThreshold(data.vendorType)}
                  extra={
                    (data.latest.power.solarRemoteW !== null || data.latest.power.solarLocalW !== null) ? (
                      <div className="text-xs space-y-1 text-gray-400">
                        {data.latest.power.solarLocalW !== null && (
                          <div>Local: {formatPower(data.latest.power.solarLocalW)}</div>
                        )}
                        {data.latest.power.solarRemoteW !== null && (
                          <div>Remote: {formatPower(data.latest.power.solarRemoteW)}</div>
                        )}
                      </div>
                    ) : undefined
                  }
                />
                <PowerCard
                  title="Load"
                  value={formatPower(data.latest.power.loadW)}
                  icon={<Home className="w-6 h-6" />}
                  iconColor="text-blue-400"
                  bgColor="bg-blue-900/20"
                  borderColor="border-blue-700"
                  secondsSinceUpdate={secondsSinceUpdate}
                  staleThresholdSeconds={getStaleThreshold(data.vendorType)}
                />
                <PowerCard
                  title="Battery"
                  value={data.latest.soc.battery !== null ? `${data.latest.soc.battery.toFixed(1)}%` : '—'}
                  icon={<Battery className="w-6 h-6" />}
                  iconColor={data.latest.power.batteryW < 0 ? "text-green-400" : data.latest.power.batteryW > 0 ? "text-orange-400" : "text-gray-400"}
                  bgColor={data.latest.power.batteryW < 0 ? "bg-green-900/20" : data.latest.power.batteryW > 0 ? "bg-orange-900/20" : "bg-gray-900/20"}
                  borderColor={data.latest.power.batteryW < 0 ? "border-green-700" : data.latest.power.batteryW > 0 ? "border-orange-700" : "border-gray-700"}
                  secondsSinceUpdate={secondsSinceUpdate}
                  staleThresholdSeconds={getStaleThreshold(data.vendorType)}
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
                    secondsSinceUpdate={secondsSinceUpdate}
                    staleThresholdSeconds={getStaleThreshold(data.vendorType)}
                    extraInfo={data.latest.power.gridW > 0 ? 'Importing' : data.latest.power.gridW < 0 ? 'Exporting' : 'Neutral'}
                  />
                )}
              </div>
              )}
            </div>
            )}

            {/* Energy Panel - Only show for admin or non-removed systems */}
            {(isAdmin || system?.status !== 'removed') && data.latest && (
              <EnergyPanel
                energy={data.latest.energy}
                historical={data.historical}
                showGrid={showGrid}
              />
            )}
          </div>
        )}
      </main>
      
      {/* Test Connection Modal */}
      {showTestConnection && systemId && (
        <TestConnectionModal
          systemId={parseInt(systemId)}
          displayName={data?.displayName || systemDisplayName}
          vendorType={data?.vendorType}
          onClose={() => setShowTestConnection(false)}
        />
      )}

      {/* Add System Dialog */}
      <AddSystemDialog
        open={showAddSystemDialog}
        onOpenChange={setShowAddSystemDialog}
      />
      
      <ServerErrorModal
        isOpen={serverError.type !== null}
        onClose={() => setServerError({ type: null })}
        errorType={serverError.type}
        errorDetails={serverError.details}
      />
      
      <SessionTimeoutModal
        isOpen={showSessionTimeout}
        onReconnect={() => {
          setShowSessionTimeout(false)
          window.location.reload()
        }}
      />

      {/* View Data Modal for point_readings systems */}
      {showViewDataModal && systemId && (
        <ViewDataModal
          isOpen={showViewDataModal}
          onClose={() => setShowViewDataModal(false)}
          systemId={parseInt(systemId)}
          systemName={data?.displayName || system?.displayName || 'System'}
          vendorType={data?.vendorType || system?.vendorType}
          vendorSiteId={data?.vendorSiteId || system?.vendorSiteId || ''}
        />
      )}
    </div>
  )
}