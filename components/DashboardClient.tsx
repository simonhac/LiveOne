'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import EnergyChart from '@/components/EnergyChart'
import EnergyPanel from '@/components/EnergyPanel'
import MobileMenu from '@/components/MobileMenu'
import LastUpdateTime from '@/components/LastUpdateTime'
import SystemInfoTooltip from '@/components/SystemInfoTooltip'
import PowerCard from '@/components/PowerCard'
import ConnectionNotification from '@/components/ConnectionNotification'
import TestConnectionModal from '@/components/TestConnectionModal'
import { 
  Sun, 
  Home, 
  Battery, 
  Zap, 
  AlertTriangle,
  Shield,
  ChevronDown,
  Settings as SettingsIcon,
  Wifi,
  Plus
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
  systemNumber?: string;
  displayName?: string;
  vendorType?: string;
  vendorSiteId?: string;
  ownerClerkUserId?: string;
}

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
}

interface DashboardClientProps {
  systemId?: string;
  hasAccess: boolean;
  systemExists: boolean;
  isAdmin: boolean;
  availableSystems?: AvailableSystem[];
  userId?: string;
}

// Helper function to get stale threshold based on vendor type
function getStaleThreshold(vendorType?: string): number {
  // 35 minutes (2100 seconds) for Enphase, 5 minutes (300 seconds) for select.live and others
  return vendorType === 'enphase' ? 2100 : 300;
}

export default function DashboardClient({ systemId, hasAccess, systemExists, isAdmin: isAdminProp, availableSystems = [], userId }: DashboardClientProps) {
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
  const dropdownRef = useRef<HTMLDivElement>(null)
  const settingsDropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

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
      const result = await response.json()
      
      if (result.success) {
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
      } else {
        setError(result.error || 'Failed to fetch data')
        setLoading(false)
      }
    } catch (err) {
      console.error('Error fetching data:', err)
      setError('Failed to fetch data')
      setLoading(false)
    }
  }, [systemId])

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
  const showGrid = data ? (
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
                        {availableSystems.map((system) => (
                          <Link
                            key={system.id}
                            href={`/dashboard/${system.id}`}
                            className={`block px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors ${
                              system.id === parseInt(systemId || '0') ? 'bg-gray-700' : ''
                            }`}
                            onClick={() => setShowSystemDropdown(false)}
                          >
                            {system.displayName || `System ${system.vendorSiteId}`}
                          </Link>
                        ))}
                        {isAdmin && availableSystems.length >= 10 && (
                          <div className="px-4 py-2 text-xs text-gray-500 border-t border-gray-700">
                            Showing first 10 systems
                          </div>
                        )}
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
                    <button
                      onClick={() => {
                        setShowTestConnection(true)
                        setShowSettingsDropdown(false)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                    >
                      <Wifi className="w-4 h-4" />
                      Test Connection
                    </button>
                    
                    {/* Only show Add Enphase if user doesn't have an Enphase system */}
                    {data?.vendorType !== 'enphase' && (
                      <>
                        <div className="border-t border-gray-700 my-1"></div>
                        <Link
                          href="/auth/enphase/connect"
                          onClick={() => setShowSettingsDropdown(false)}
                          className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2 block"
                        >
                          <Plus className="w-4 h-4" />
                          Add Enphase
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>
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
              </div>

              {/* Power Cards - 1/3 width on desktop, horizontal on mobile */}
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
                  secondsSinceUpdate={secondsSinceUpdate}
                  staleThresholdSeconds={getStaleThreshold(data.vendorType)}
                />
                <PowerCard
                  title="Battery"
                  value={`${data.latest.soc.battery.toFixed(1)}%`}
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
            </div>

            <EnergyPanel 
              energy={data.latest.energy}
              historical={data.historical}
              showGrid={showGrid}
            />
          </div>
        )}
      </main>
      
      {/* Test Connection Modal */}
      {showTestConnection && data && (
        <TestConnectionModal
          displayName={data.displayName}
          ownerClerkUserId={data.ownerClerkUserId || ''}
          vendorType={data.vendorType || 'select.live'}
          vendorSiteId={data.vendorSiteId || ''}
          onClose={() => setShowTestConnection(false)}
        />
      )}
    </div>
  )
}