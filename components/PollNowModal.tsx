'use client'

import { useEffect, useState, useRef } from 'react'
import { X, Loader2, Check, AlertCircle, RefreshCw, ChevronRight, ChevronDown } from 'lucide-react'

interface PollNowModalProps {
  systemId: number
  displayName: string | null
  onClose: () => void
}

export default function PollNowModal({ systemId, displayName, onClose }: PollNowModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const hasInitiatedPoll = useRef(false)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  useEffect(() => {
    // Use ref to ensure poll only happens once, even in StrictMode
    if (!hasInitiatedPoll.current) {
      hasInitiatedPoll.current = true
      pollNow(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty dependency array means this runs once on mount

  const pollNow = async (isRefresh: boolean = false) => {
    if (isRefresh) {
      setIsRefreshing(true)
    } else {
      setLoading(true)
      setResult(null)
    }
    setError(null)

    try {
      const response = await fetch(`/api/cron/minutely?systemId=${systemId}&force=true`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || `Failed to poll: ${response.status}`)
      }

      // Extract the result for this specific system
      const systemResult = data.results?.find((r: any) => r.systemId === systemId)
      setResult(systemResult || data)
    } catch (err) {
      console.error('Poll now error:', err)
      setError(err instanceof Error ? err.message : 'Failed to poll system')
      if (!isRefresh) {
        setResult(null)
      }
    } finally {
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  const refreshPoll = () => {
    pollNow(true)
  }

  // Format JSON with syntax highlighting
  const formatJson = (obj: any, indent = 0): React.ReactElement => {
    if (obj === null) return <span className="text-gray-500">null</span>
    if (obj === undefined) return <span className="text-gray-500">undefined</span>
    if (typeof obj === 'boolean') return <span className="text-yellow-400">{String(obj)}</span>
    if (typeof obj === 'number') return <span className="text-blue-400">{obj}</span>
    if (typeof obj === 'string') {
      // Check if it's a date string
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
        return <span className="text-green-400">"{obj}"</span>
      }
      return <span className="text-green-400">"{obj}"</span>
    }

    const spaces = '  '.repeat(indent)
    const nextIndent = indent + 1
    const nextSpaces = '  '.repeat(nextIndent)

    if (Array.isArray(obj)) {
      if (obj.length === 0) return <><span>[</span><span>]</span></>

      return (
        <>
          <span>[</span>
          {obj.map((item, i) => (
            <div key={i}>
              <span>{nextSpaces}</span>
              {formatJson(item, nextIndent)}
              {i < obj.length - 1 && <span>,</span>}
            </div>
          ))}
          <span>{spaces}]</span>
        </>
      )
    }

    if (typeof obj === 'object') {
      const entries = Object.entries(obj)
      if (entries.length === 0) return <><span>{'{'}</span><span>{'}'}</span></>

      return (
        <>
          <span>{'{'}</span>
          {entries.map(([key, value], i) => (
            <div key={key}>
              <span>{nextSpaces}</span>
              <span className="text-cyan-400">"{key}"</span>
              <span>: </span>
              {formatJson(value, nextIndent)}
              {i < entries.length - 1 && <span>,</span>}
            </div>
          ))}
          <span>{spaces}{'}'}</span>
        </>
      )
    }

    return <span>{String(obj)}</span>
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-lg p-6 max-w-2xl w-full mx-4 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-white">
            {displayName || `System ${systemId}`} — Poll Now
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
        {(loading && !result) && (
          <div className="text-center py-8">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-gray-400">Polling system...</p>
          </div>
        )}

        {/* Data Display */}
        {result && (
          <div className="relative">
            {/* Refreshing Overlay */}
            {isRefreshing && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="bg-gray-800/90 rounded-lg p-4 flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-300">Polling again...</span>
                </div>
              </div>
            )}

            <div className={`space-y-4 transition-opacity ${isRefreshing ? 'opacity-40' : ''}`}>
              {/* Status Section */}
              <div className="bg-gray-900 rounded-lg p-4">
                <div className="flex items-center gap-3">
                  {result.status === 'polled' ? (
                    <>
                      <Check className="w-6 h-6 text-green-500" />
                      <div className="flex-1">
                        <p className="text-green-400 font-semibold">Successfully Polled</p>
                        {result.recordsUpserted !== undefined && (
                          <p className="text-sm text-gray-400">
                            {result.recordsUpserted} records processed
                          </p>
                        )}
                      </div>
                    </>
                  ) : result.status === 'skipped' ? (
                    <>
                      <AlertCircle className="w-6 h-6 text-yellow-500" />
                      <div className="flex-1">
                        <p className="text-yellow-400 font-semibold">Skipped</p>
                        {result.skipReason && (
                          <p className="text-sm text-gray-400">{result.skipReason}</p>
                        )}
                      </div>
                    </>
                  ) : result.status === 'error' ? (
                    <>
                      <AlertCircle className="w-6 h-6 text-red-500" />
                      <div className="flex-1">
                        <p className="text-red-400 font-semibold">Error</p>
                        {result.error && (
                          <p className="text-sm text-gray-400">{result.error}</p>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Details Disclosure */}
              <div>
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  {showDetails ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  Details
                </button>

                {showDetails && (
                  <div className="mt-3 bg-gray-950 border border-gray-700 rounded-lg p-4">
                    <pre className="font-mono text-sm text-gray-300 overflow-x-auto">
                      {formatJson(result)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3">
          {result && (
            <button
              onClick={refreshPoll}
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