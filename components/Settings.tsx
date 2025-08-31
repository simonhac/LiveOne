'use client'

import { useState, useEffect } from 'react'
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink, Power, Zap } from 'lucide-react'

interface SettingsProps {
  isOpen: boolean
  onClose: () => void
}

interface EnphaseStatus {
  connected: boolean
  systemId?: string
  expiresAt?: number
}

export default function Settings({ isOpen, onClose }: SettingsProps) {
  const [enphaseStatus, setEnphaseStatus] = useState<EnphaseStatus>({ connected: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Check Enphase connection status
  useEffect(() => {
    if (isOpen) {
      checkEnphaseStatus()
    }
  }, [isOpen])

  const checkEnphaseStatus = async () => {
    try {
      const response = await fetch('/api/auth/enphase/disconnect')
      if (response.ok) {
        const data = await response.json()
        setEnphaseStatus(data)
        console.log('ENPHASE: Connection status:', data.connected)
      }
    } catch (error) {
      console.error('ENPHASE: Error checking status:', error)
    }
  }

  const handleConnectEnphase = async () => {
    setLoading(true)
    setError(null)
    setSuccess(null)
    
    console.log('ENPHASE: Initiating connection')
    
    try {
      const response = await fetch('/api/auth/enphase/connect', {
        method: 'POST'
      })
      
      if (!response.ok) {
        throw new Error('Failed to initiate Enphase connection')
      }
      
      const data = await response.json()
      console.log('ENPHASE: Redirecting to authorization URL:', data.authUrl)
      
      // Redirect to Enphase authorization page
      if (data.authUrl) {
        // Small delay to ensure modal doesn't interfere
        setTimeout(() => {
          window.location.href = data.authUrl
        }, 100)
      } else {
        throw new Error('No authorization URL received')
      }
    } catch (error) {
      console.error('ENPHASE: Connection error:', error)
      setError('Failed to connect to Enphase. Please try again.')
      setLoading(false)
    }
  }

  const handleDisconnectEnphase = async () => {
    if (!confirm('Are you sure you want to disconnect your Enphase system?')) {
      return
    }
    
    setLoading(true)
    setError(null)
    setSuccess(null)
    
    console.log('ENPHASE: Disconnecting system')
    
    try {
      const response = await fetch('/api/auth/enphase/disconnect', {
        method: 'POST'
      })
      
      if (!response.ok) {
        throw new Error('Failed to disconnect Enphase')
      }
      
      setEnphaseStatus({ connected: false })
      setSuccess('Enphase system disconnected successfully')
      console.log('ENPHASE: Disconnection successful')
    } catch (error) {
      console.error('ENPHASE: Disconnection error:', error)
      setError('Failed to disconnect Enphase. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-2xl bg-gray-800 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-700">
            <h2 className="text-xl font-semibold text-white">Settings</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          {/* Content */}
          <div className="p-6 space-y-6">
            {/* Enphase Integration Section */}
            <div>
              <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-green-500" />
                Enphase Integration
              </h3>
              
              {/* Status Messages */}
              {error && (
                <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300">
                  <AlertCircle className="w-5 h-5" />
                  <span>{error}</span>
                </div>
              )}
              
              {success && (
                <div className="mb-4 p-3 bg-green-900/50 border border-green-700 rounded-lg flex items-center gap-2 text-green-300">
                  <CheckCircle className="w-5 h-5" />
                  <span>{success}</span>
                </div>
              )}
              
              <div className="bg-gray-900 rounded-lg p-4">
                {enphaseStatus.connected ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-medium">Status: Connected</p>
                        <p className="text-sm text-gray-400">System ID: {enphaseStatus.systemId}</p>
                        {enphaseStatus.expiresAt && (
                          <p className="text-sm text-gray-400">
                            Token expires: {new Date(enphaseStatus.expiresAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-green-500">
                        <CheckCircle className="w-5 h-5" />
                        <span className="font-medium">Active</span>
                      </div>
                    </div>
                    
                    <button
                      onClick={handleDisconnectEnphase}
                      disabled={loading}
                      className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {loading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Power className="w-4 h-4" />
                      )}
                      Disconnect Enphase System
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-white font-medium mb-2">Connect Your Enphase System</p>
                      <p className="text-sm text-gray-400 mb-4">
                        Connect your Enphase solar system to monitor production, consumption, and battery data.
                      </p>
                      
                      <div className="bg-gray-800 rounded-lg p-3 mb-4">
                        <p className="text-sm text-gray-300 font-medium mb-1">What happens next:</p>
                        <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
                          <li>You&apos;ll be redirected to Enphase to log in</li>
                          <li>Review and approve access permissions</li>
                          <li>You&apos;ll be redirected back here</li>
                          <li>Your system will start syncing data</li>
                        </ol>
                      </div>
                      
                      {process.env.NODE_ENV === 'development' && (
                        <div className="bg-blue-900/50 border border-blue-700 rounded-lg p-3 mb-4">
                          <p className="text-sm text-blue-300 font-medium mb-1">Development Mode</p>
                          <p className="text-sm text-blue-300">
                            Using mock Enphase service. No real system required.
                          </p>
                        </div>
                      )}
                    </div>
                    
                    <button
                      onClick={handleConnectEnphase}
                      disabled={loading}
                      className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {loading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-4 h-4" />
                          Connect Enphase System
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}