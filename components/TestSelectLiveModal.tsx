'use client'

import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Loader2, X, Zap, Sun, Home, Battery, AlertCircle, RefreshCw } from 'lucide-react'

interface TestSelectLiveModalProps {
  displayName?: string | null  // Optional - we might not know it yet
  ownerClerkUserId: string
  vendorType: string
  vendorSiteId: string
  onClose: () => void
}

export default function TestSelectLiveModal({
  displayName,
  ownerClerkUserId,
  vendorType,
  vendorSiteId,
  onClose
}: TestSelectLiveModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<any>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const testConnection = async (isRefresh: boolean = false) => {
    if (isRefresh) {
      setIsRefreshing(true)
    } else {
      setLoading(true)
      setData(null)
    }
    setError(null)

    try {
      const response = await fetch('/api/admin/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ownerClerkUserId,
          vendorType,
          vendorSiteId
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Connection test failed')
      }

      if (result.success && result.latest) {
        setData({
          latest: result.latest,
          systemInfo: result.systemInfo
        })
        setError(null)
      } else {
        throw new Error(result.error || 'No data received')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed')
      if (!isRefresh) {
        setData(null)
      }
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  const refreshTest = () => {
    testConnection(true)
  }

  // Automatically test connection when modal opens
  useEffect(() => {
    testConnection(false)
  }, []) // Empty dependency array means this runs once on mount

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            {displayName || 'System'} — Test Connection
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Error Display */}
        {error && (
          <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-400" />
              <p className="text-red-400">{error}</p>
            </div>
          </div>
        )}
        
        {/* Loading State - Initial */}
        {(loading && !data) && (
          <div className="text-center py-8">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-gray-400">Connecting to Select.Live...</p>
          </div>
        )}
        
        {/* Data Display */}
        {data && (
          <div className="relative">
            {/* Refreshing Overlay */}
            {isRefreshing && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="bg-gray-800/90 rounded-lg p-4 flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-300">Refreshing...</span>
                </div>
              </div>
            )}
            
            <div className={`space-y-4 transition-opacity ${isRefreshing ? 'opacity-40' : ''}`}>
              {/* Power Flow Section */}
              <div className="bg-gray-900 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-400 mb-3">Current Power Flow</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="flex items-start gap-2">
                    <Sun className="w-5 h-5 text-yellow-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Solar</p>
                      <p className="text-lg font-semibold text-yellow-400">
                        {(data.latest.power.solarW / 1000).toFixed(1)} kW
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-start gap-2">
                    <Home className="w-5 h-5 text-blue-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Load</p>
                      <p className="text-lg font-semibold text-blue-400">
                        {(data.latest.power.loadW / 1000).toFixed(1)} kW
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-start gap-2">
                    <Battery className="w-5 h-5 text-green-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Battery</p>
                      <p className="text-lg font-semibold text-green-400">
                        {data.latest.soc.battery.toFixed(1)}%
                      </p>
                      <p className="text-xs text-gray-400">
                        {data.latest.power.batteryW < 0 
                          ? `Charging ${Math.abs(data.latest.power.batteryW / 1000).toFixed(1)} kW`
                          : data.latest.power.batteryW > 0
                          ? `Discharging ${(data.latest.power.batteryW / 1000).toFixed(1)} kW`
                          : 'Idle'}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-start gap-2">
                    <Zap className="w-5 h-5 text-purple-400 mt-0.5" />
                    <div>
                      <p className="text-xs text-gray-400">Grid</p>
                      <p className="text-lg font-semibold text-purple-400">
                        {Math.abs(data.latest.power.gridW / 1000).toFixed(1)} kW
                      </p>
                      <p className="text-xs text-gray-400">
                        {data.latest.power.gridW > 0 ? 'Importing' : data.latest.power.gridW < 0 ? 'Exporting' : 'No flow'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Today's Energy Section */}
              <div className="bg-gray-900 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-400 mb-3">Today&apos;s Energy</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-gray-400">Solar Generated</p>
                    <p className="text-lg font-semibold text-white">
                      {data.latest.energy.today.solarKwh.toFixed(1)} kWh
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Load Consumed</p>
                    <p className="text-lg font-semibold text-white">
                      {data.latest.energy.today.loadKwh.toFixed(1)} kWh
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Battery In/Out</p>
                    <p className="text-lg font-semibold text-white">
                      +{data.latest.energy.today.batteryInKwh.toFixed(1)} / -{data.latest.energy.today.batteryOutKwh.toFixed(1)} kWh
                    </p>
                  </div>
                </div>
              </div>

              {/* System Info Section */}
              {data.systemInfo && (
                <div className="bg-gray-900 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-400 mb-3">System Information</h4>
                  <div className="grid grid-cols-2 gap-4">
                    {data.systemInfo.model && (
                      <div>
                        <p className="text-xs text-gray-400">Model</p>
                        <p className="text-sm text-white">{data.systemInfo.model}</p>
                      </div>
                    )}
                    {data.systemInfo.serial && (
                      <div>
                        <p className="text-xs text-gray-400">Serial</p>
                        <p className="text-sm text-white">{data.systemInfo.serial}</p>
                      </div>
                    )}
                    {data.systemInfo.solarSize && (
                      <div>
                        <p className="text-xs text-gray-400">Solar Size</p>
                        <p className="text-sm text-white">{data.systemInfo.solarSize}</p>
                      </div>
                    )}
                    {data.systemInfo.batterySize && (
                      <div>
                        <p className="text-xs text-gray-400">Battery Size</p>
                        <p className="text-sm text-white">{data.systemInfo.batterySize}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Timestamp */}
              <div className="text-xs text-gray-500 text-center">
                Last updated: {new Date(data.latest.timestamp).toLocaleString('en-AU', { 
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </div>
            </div>
          </div>
        )}
        
        {/* Action Buttons */}
        <div className="mt-6 flex gap-3">
          {data && (
            <button
              onClick={refreshTest}
              disabled={isRefreshing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
          
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}