'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, RefreshCw } from 'lucide-react'
import { formatDateTime, formatTime } from '@/lib/fe-date-format'

interface ColumnHeader {
  key: string
  label: string
  type: string
  unit: string | null
  subsystem: string | null
  pointId?: string
  pointSubId?: string | null
}

interface ViewDataModalProps {
  isOpen: boolean
  onClose: () => void
  systemId: number
  systemName: string
  vendorType?: string
}

export default function ViewDataModal({
  isOpen,
  onClose,
  systemId,
  systemName,
  vendorType
}: ViewDataModalProps) {
  const [headers, setHeaders] = useState<ColumnHeader[]>([])
  const [data, setData] = useState<any[]>([])
  const [metadata, setMetadata] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null)
  const [initialLoad, setInitialLoad] = useState(true)
  const [rotateKey, setRotateKey] = useState(0)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/admin/systems/${systemId}/point-readings?limit=200`)
      if (!response.ok) throw new Error('Failed to fetch data')

      const result = await response.json()
      setHeaders(result.headers || [])
      setData(result.data || [])
      setMetadata(result.metadata || null)
      setLastFetchTime(new Date())
      setInitialLoad(false) // Mark initial load as complete
    } catch (error) {
      console.error('Error fetching point readings:', error)
    } finally {
      setLoading(false)
    }
  }, [systemId])

  useEffect(() => {
    if (isOpen) {
      setInitialLoad(true)
      fetchData()
    } else {
      // Reset state when modal closes
      setInitialLoad(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]) // Intentionally exclude fetchData to prevent double calls

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const handleRefresh = () => {
    setRotateKey(prev => prev + 1) // Increment to trigger animation
    setInitialLoad(false) // Not initial load when manually refreshing
    fetchData()
  }

  if (!isOpen) return null

  // Format value based on metric type
  const formatValue = (value: number | null, header: ColumnHeader) => {
    if (value === null) return '-'

    if (header.type === 'energy') {
      // Convert Wh to MWh for energy (divide by 1,000,000)
      return `${(value / 1000000).toFixed(1)}`
    } else if (header.type === 'power') {
      // Always show power in kW to match header unit
      return `${(value / 1000).toFixed(1)}`
    } else {
      // Default formatting
      return `${value.toFixed(0)}`
    }
  }

  // Get unit display for header
  const getUnitDisplay = (header: ColumnHeader) => {
    if (header.key === 'timestamp') return ''

    if (header.type === 'energy') {
      return 'MWh'
    } else if (header.type === 'power') {
      // For power, we'll show kW for most values
      return 'kW'
    } else if (header.unit) {
      return header.unit
    }
    return ''
  }

  // Get subsystem color
  const getSubsystemColor = (subsystem: string | null) => {
    switch(subsystem) {
      case 'solar': return 'text-yellow-400'
      case 'battery': return 'text-green-400'
      case 'grid': return 'text-blue-400'
      case 'load': return 'text-purple-400'
      case 'inverter': return 'text-orange-400'
      default: return 'text-gray-400'
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-7xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h3 className="text-lg font-semibold text-white">
              Data for {systemName} <span className="text-gray-500">ID: {systemId}</span>
              {vendorType && <> — {vendorType}</>}
            </h3>
            <p className="text-sm text-gray-400">
              {metadata && (
                <>
                  Showing {metadata.rowCount} readings from {metadata.pointCount} monitoring points
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {lastFetchTime && (
              <span className="text-xs text-gray-400">
                Last updated: {formatTime(lastFetchTime)}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw
                className="w-5 h-5 text-gray-400"
                style={{
                  transform: `rotate(${rotateKey * 180}deg)`,
                  transition: 'transform 500ms ease'
                }}
              />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {initialLoad && loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : data.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              No data available
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-400 border-b border-gray-700 sticky top-0 bg-gray-900">
                  <tr>
                    {headers.map((header) => (
                      <th key={header.key} className="pb-2 px-2">
                        <div className="flex flex-col gap-0.5">
                          <span className={header.key === 'timestamp' ? 'text-gray-300' : getSubsystemColor(header.subsystem)}>
                            {header.label}
                          </span>
                          {getUnitDisplay(header) && (
                            <span className="text-xs text-gray-500">
                              {getUnitDisplay(header)}
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {data.map((row, idx) => (
                    <tr
                      key={idx}
                      className={`border-b border-gray-700 ${
                        idx % 2 === 0 ? 'bg-gray-900/50' : 'bg-gray-800/50'
                      } hover:bg-gray-700/50 transition-colors`}
                    >
                      {headers.map((header) => (
                        <td key={header.key} className="py-2 px-2">
                          {header.key === 'timestamp' ? (
                            <span className="text-xs font-mono text-gray-300">
                              {formatDateTime(row[header.key]).display}
                            </span>
                          ) : (
                            <span className={`font-mono text-xs ${getSubsystemColor(header.subsystem)}`}>
                              {formatValue(row[header.key], header)}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}