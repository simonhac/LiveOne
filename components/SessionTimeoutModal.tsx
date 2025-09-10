'use client'

import { RefreshCw } from 'lucide-react'

interface SessionTimeoutModalProps {
  isOpen: boolean
  onReconnect: () => void
}

export default function SessionTimeoutModal({ isOpen, onReconnect }: SessionTimeoutModalProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-w-md w-full p-6">
        <h2 className="text-xl font-semibold text-white mb-3">
          Session Timed Out
        </h2>
        
        <p className="text-gray-300 mb-6">
          Your session has expired due to inactivity. Please reconnect to continue.
        </p>
        
        <button
          onClick={onReconnect}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reconnect
        </button>
      </div>
    </div>
  )
}