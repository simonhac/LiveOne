'use client'

import { useEffect, useState } from 'react'
import { Database, Server, CheckCircle, XCircle, Info, AlertCircle, Globe, Shield, Download, X } from 'lucide-react'

interface DatabaseInfo {
  type: 'development' | 'production'
  provider: string
  stats?: {
    tables: number
    totalReadings: number
    oldestReading: string
    newestReading: string
    diskSize?: string
  }
}

export default function StoragePageClient() {
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncProgress, setSyncProgress] = useState<{
    isActive: boolean
    message: string
    progress: number
    total: number
  }>({ isActive: false, message: '', progress: 0, total: 0 })
  const [syncAbortController, setSyncAbortController] = useState<AbortController | null>(null)

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/admin/storage')
      
      if (!response.ok) {
        throw new Error('Failed to fetch settings')
      }
      
      const data = await response.json()
      
      if (data.success) {
        setDatabaseInfo(data.database)
        setError(null)
      } else {
        setError(data.error || 'Failed to load settings')
      }
    } catch (err) {
      console.error('Error fetching settings:', err)
      setError('Failed to connect to server')
    } finally {
      setLoading(false)
    }
  }

  const startSync = async () => {
    const controller = new AbortController()
    setSyncAbortController(controller)
    setSyncProgress({
      isActive: true,
      message: 'Connecting to production database...',
      progress: 0,
      total: 100
    })

    try {
      const response = await fetch('/api/admin/sync-database', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error('Sync failed')
      }

      // Handle streaming response for progress updates
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value)
          const lines = chunk.split('\n').filter(line => line.trim())
          
          for (const line of lines) {
            try {
              const update = JSON.parse(line)
              if (update.type === 'progress') {
                setSyncProgress({
                  isActive: true,
                  message: update.message || 'Syncing...',
                  progress: update.progress || 0,
                  total: update.total || 100
                })
              } else if (update.type === 'complete') {
                setSyncProgress({
                  isActive: true, // Keep modal open briefly to show success
                  message: 'Sync completed successfully!',
                  progress: 100,
                  total: 100
                })
                // Refresh the page data
                await fetchSettings()
                // Close modal after showing success message
                setTimeout(() => {
                  setSyncProgress({
                    isActive: false,
                    message: '',
                    progress: 0,
                    total: 0
                  })
                }, 2000)
              } else if (update.type === 'error') {
                throw new Error(update.message || 'Sync failed')
              }
            } catch (e) {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setSyncProgress({
          isActive: false,
          message: 'Sync cancelled',
          progress: 0,
          total: 0
        })
      } else {
        console.error('Sync error:', err)
        setError(err.message || 'Failed to sync database')
        setSyncProgress({
          isActive: false,
          message: '',
          progress: 0,
          total: 0
        })
      }
    } finally {
      setSyncAbortController(null)
    }
  }

  const cancelSync = () => {
    if (syncAbortController) {
      syncAbortController.abort()
      setSyncAbortController(null)
    }
  }

  useEffect(() => {
    fetchSettings()
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-2 sm:px-6 py-4 sm:py-8">
      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded mb-6 flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          {error}
        </div>
      )}

      {/* Sync Progress Modal */}
      {syncProgress.isActive && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-semibold text-white">Syncing Database</h3>
              <button
                onClick={cancelSync}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <p className="text-sm text-gray-400 mb-4">{syncProgress.message}</p>
            
            <div className="mb-4">
              <div className="bg-gray-900 rounded-full h-2 overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 ${
                    syncProgress.progress === 100 ? 'bg-green-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${(syncProgress.progress / syncProgress.total) * 100}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-gray-500 text-right">
                {Math.round((syncProgress.progress / syncProgress.total) * 100)}%
              </div>
            </div>
            
            {syncProgress.progress < 100 && (
              <button
                onClick={cancelSync}
                className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      
      {/* Database Information */}
      <div className="mb-8 -mx-2 sm:mx-0">
        <h2 className="text-xl font-semibold text-white mb-4 px-2 sm:px-0">
          Database
        </h2>
        
        <div className="bg-gray-800 border border-gray-700 sm:rounded-lg p-4 sm:p-6">
          {databaseInfo && (
            <div className="space-y-4">
              {/* Database Type Badge with Sync Button */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-gray-400">Environment:</span>
                  <span className={`inline-flex items-center gap-1 px-3 py-1 text-sm font-medium border rounded-full ${
                    databaseInfo.type === 'production' 
                      ? 'bg-green-900/50 text-green-300 border-green-700' 
                      : 'bg-yellow-900/50 text-yellow-300 border-yellow-700'
                  }`}>
                    {databaseInfo.type === 'production' ? (
                      <Globe className="w-4 h-4" />
                    ) : (
                      <Server className="w-4 h-4" />
                    )}
                    {databaseInfo.type === 'production' ? 'Production' : 'Development'}
                  </span>
                </div>
                
                {/* Sync Button for Development */}
                {databaseInfo.type === 'development' && (
                  <button
                    onClick={startSync}
                    disabled={syncProgress.isActive}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg transition-colors text-sm"
                  >
                    <Download className="w-4 h-4" />
                    Sync from Prod
                  </button>
                )}
              </div>

              {/* Database Provider */}
              <div className="flex items-center gap-4">
                <span className="text-gray-400">Provider:</span>
                <span className="text-white font-medium">{databaseInfo.provider}</span>
              </div>

              {/* Database Statistics */}
              {databaseInfo.stats && (
                <div className="mt-6 pt-6 border-t border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-400 mb-3">Database Statistics</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-gray-500">Tables</p>
                      <p className="text-lg font-semibold text-white">{databaseInfo.stats.tables}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Total Readings</p>
                      <p className="text-lg font-semibold text-white">
                        {databaseInfo.stats.totalReadings.toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Oldest Reading</p>
                      <div className="text-sm text-white">
                        {databaseInfo.stats.oldestReading === 'No data' ? (
                          'No data'
                        ) : (
                          <>
                            <div>{new Date(databaseInfo.stats.oldestReading).toLocaleDateString('en-AU', { 
                              day: 'numeric', 
                              month: 'short', 
                              year: 'numeric' 
                            })}</div>
                            <div className="text-xs text-gray-400">{new Date(databaseInfo.stats.oldestReading).toLocaleTimeString('en-AU', { 
                              hour: '2-digit', 
                              minute: '2-digit' 
                            })}</div>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Newest Reading</p>
                      <div className="text-sm text-white">
                        {databaseInfo.stats.newestReading === 'No data' ? (
                          'No data'
                        ) : (
                          <>
                            <div>{new Date(databaseInfo.stats.newestReading).toLocaleDateString('en-AU', { 
                              day: 'numeric', 
                              month: 'short', 
                              year: 'numeric' 
                            })}</div>
                            <div className="text-xs text-gray-400">{new Date(databaseInfo.stats.newestReading).toLocaleTimeString('en-AU', { 
                              hour: '2-digit', 
                              minute: '2-digit' 
                            })}</div>
                          </>
                        )}
                      </div>
                    </div>
                    {databaseInfo.stats.diskSize && (
                      <div>
                        <p className="text-xs text-gray-500">Disk Size</p>
                        <p className="text-lg font-semibold text-white">{databaseInfo.stats.diskSize}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Info Notice */}
      <div className="mt-8 -mx-2 sm:mx-0 bg-blue-900/20 border border-blue-700/50 sm:rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-300">
            <p className="font-semibold mb-1">Database Information</p>
            <p className="text-blue-200">
              {databaseInfo?.type === 'production' 
                ? 'You are connected to the production Turso database. All changes will affect live data.'
                : 'You are connected to the local SQLite development database. Changes will not affect production.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}