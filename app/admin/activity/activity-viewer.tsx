'use client'

import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { Info, X, RefreshCw } from 'lucide-react'
import { JsonView, darkStyles, allExpanded } from 'react-json-view-lite'
import 'react-json-view-lite/dist/index.css'

interface Session {
  id: number
  sessionLabel?: string
  systemId: number
  vendorType: string
  systemName: string
  cause: string
  started: string
  duration: number
  successful: boolean
  errorCode?: string
  error?: string
  response?: any
  numRows: number
  createdAt: string
}

export default function ActivityViewer() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [rotateKey, setRotateKey] = useState(0)
  const [maxSessionId, setMaxSessionId] = useState<number | null>(null)

  const fetchSessions = useCallback(async (isRefresh = false) => {
    try {
      // On refresh, use start from maxSessionId, otherwise use last=100
      const url = isRefresh && maxSessionId
        ? `/api/admin/sessions?start=${maxSessionId}&count=100`
        : '/api/admin/sessions?last=100'

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.status}`)
      }
      const data = await response.json()

      if (isRefresh) {
        // On refresh, merge new sessions with existing ones
        setSessions(prev => {
          // Create a Map for deduplication
          const sessionMap = new Map<number, Session>()

          // Add existing sessions
          prev.forEach(session => sessionMap.set(session.id, session))

          // Add new sessions (will overwrite duplicates)
          data.sessions.forEach((session: Session) => sessionMap.set(session.id, session))

          // Convert back to array and sort by ID descending (newest first)
          return Array.from(sessionMap.values()).sort((a, b) => b.id - a.id)
        })
      } else {
        // Initial load - replace all sessions
        setSessions(data.sessions)
      }

      // Update the max session ID to the highest (most recent) session ID
      if (data.sessions.length > 0) {
        const newMaxId = Math.max(...data.sessions.map((s: Session) => s.id))
        setMaxSessionId(prevMax => prevMax ? Math.max(prevMax, newMaxId) : newMaxId)
      }

      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [maxSessionId])

  useEffect(() => {
    // Only fetch on initial load
    if (loading) {
      fetchSessions()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefresh = () => {
    setRefreshing(true)
    setRotateKey(prev => prev + 1) // Increment to trigger animation
    fetchSessions(true) // Pass true to indicate it's a refresh
  }

  // Handle modal close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedSession(null)
        // Remove focus from any button
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
      }
    }
    if (selectedSession) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedSession])

  const getCauseColor = (cause: string) => {
    switch (cause) {
      case 'POLL': return 'text-blue-400'
      case 'PUSH': return 'text-green-400'
      case 'USER': return 'text-yellow-400'
      case 'ADMIN': return 'text-purple-400'
      default: return 'text-gray-400'
    }
  }

  const getStatusColor = (successful: boolean) => {
    return successful ? 'text-green-500' : 'text-red-500'
  }

  const getStatusBadge = (successful: boolean, errorCode?: string) => {
    if (successful) {
      return <span className="px-2 py-0.5 text-xs rounded bg-green-500/20 text-green-400">Success</span>
    }
    return (
      <span className="px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400">
        {errorCode ? `Error ${errorCode}` : 'Failed'}
      </span>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading activity…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="text-red-400">Error: {error}</p>
        <button
          onClick={() => fetchSessions()}
          className="mt-2 px-3 py-1 text-sm bg-red-500/20 hover:bg-red-500/30 rounded transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      {/* Sessions table - matches admin dashboard structure */}
      <div className="bg-gray-800 border-t md:border border-gray-700 md:rounded-t overflow-hidden flex flex-col min-h-0 flex-1">
        <div className="overflow-auto flex-1">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  <div className="flex items-center gap-2">
                    <span>Time</span>
                    <button
                      onClick={handleRefresh}
                      disabled={refreshing}
                      className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                      title="Refresh"
                    >
                      <RefreshCw
                        className="h-4 w-4"
                        style={{
                          transform: `rotate(${rotateKey * 180}deg)`,
                          transition: 'transform 500ms ease'
                        }}
                      />
                    </button>
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  System
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Vendor
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Cause
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Duration
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Rows
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Label
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, index) => (
                <tr key={session.id} className={`${index % 2 === 0 ? 'bg-gray-900/50' : 'bg-gray-800/50'} hover:bg-gray-700 transition-colors`}>
                  <td className="px-4 py-3 text-sm text-gray-300 align-top">
                    <div className="flex items-start gap-1">
                      <span>{format(new Date(session.started), 'h:mm:ss aa').toLowerCase()}</span>
                      <button
                        onClick={() => setSelectedSession(session)}
                        className="text-gray-500 hover:text-gray-300 transition-colors"
                        title="View details"
                      >
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="text-gray-300">
                      {session.systemName} <span className="text-gray-500">ID: {session.systemId}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {session.vendorType}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`font-medium ${getCauseColor(session.cause)}`}>
                      {session.cause}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {session.duration}ms
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {getStatusBadge(session.successful, session.errorCode)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {session.numRows > 0 ? session.numRows : '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">
                    {session.sessionLabel ? (
                      <span className="font-mono text-xs">{session.sessionLabel}</span>
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-500">
            No sessions recorded yet
          </div>
        )}
      </div>

      {/* Modal for session details */}
      {selectedSession && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-4xl w-full max-h-[80vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-lg font-medium text-white">
                Session Details - {selectedSession.systemName}
              </h3>
              <button
                onClick={() => {
                  setSelectedSession(null)
                  // Remove focus from any button
                  if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur()
                  }
                }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Modal body */}
            <div className="p-4 overflow-auto flex-1">
              {/* Collapsed info line */}
              <div className="text-sm mb-4 flex justify-between items-center">
                <div>
                  <span className="text-gray-400">Time:</span>{' '}
                  <span className="text-gray-200">
                    {format(new Date(selectedSession.started), 'h:mm:ss aa').toLowerCase()} ({selectedSession.duration}ms)
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">Cause:</span>{' '}
                  <span className={getCauseColor(selectedSession.cause)}>
                    {selectedSession.cause}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">Status:</span>{' '}
                  <span className={selectedSession.successful ? 'text-green-400' : 'text-red-400'}>
                    {selectedSession.successful ? 'Success' : 'Failed'}
                    {selectedSession.errorCode && ` (${selectedSession.errorCode})`}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">Rows:</span>{' '}
                  <span className="text-gray-200">{selectedSession.numRows}</span>
                </div>
                {selectedSession.sessionLabel && (
                  <div>
                    <span className="text-gray-400">Label:</span>{' '}
                    <span className="text-gray-200 font-mono">{selectedSession.sessionLabel}</span>
                  </div>
                )}
              </div>

              {/* Error details if present */}
              {selectedSession.error && (
                <div className="text-sm mb-4 bg-red-500/10 border border-red-500/20 rounded p-3">
                  <span className="text-gray-400">Error:</span>{' '}
                  <span className="text-red-400">{selectedSession.error}</span>
                </div>
              )}

              {/* Response data */}
              {selectedSession.response && (
                <div>
                  <h4 className="text-sm font-medium text-gray-400 mb-2">Raw Remote Data:</h4>
                  <div className="bg-gray-950 border border-gray-700 rounded-lg">
                    <div className="overflow-x-auto font-mono text-sm">
                      <JsonView
                        data={selectedSession.response}
                        shouldExpandNode={allExpanded}
                        style={darkStyles}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}