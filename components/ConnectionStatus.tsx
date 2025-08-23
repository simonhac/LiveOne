'use client'

import { Wifi, WifiOff } from 'lucide-react'

interface ConnectionStatusProps {
  isAuthenticated: boolean
  className?: string
}

export default function ConnectionStatus({ isAuthenticated, className = '' }: ConnectionStatusProps) {
  return (
    <div className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
      isAuthenticated ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
    } ${className}`}>
      {isAuthenticated ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      <span className="hidden lg:inline">
        {isAuthenticated ? 'Connected' : 'Disconnected'}
      </span>
    </div>
  )
}