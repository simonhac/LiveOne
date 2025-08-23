'use client'

import { useState } from 'react'
import { Menu, X, User, LogOut, Info } from 'lucide-react'
import ConnectionStatus from './ConnectionStatus'
import LastUpdateTime from './LastUpdateTime'

interface SystemInfo {
  model?: string
  serial?: string
  ratings?: string
  solarSize?: string
  batterySize?: string
}

interface MobileMenuProps {
  displayName: string | null
  isAuthenticated: boolean
  secondsSinceUpdate: number
  onLogout: () => void
  systemInfo?: SystemInfo | null
}

export default function MobileMenu({ 
  displayName, 
  isAuthenticated, 
  secondsSinceUpdate,
  onLogout,
  systemInfo
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false)

  const toggleMenu = () => setIsOpen(!isOpen)

  return (
    <>
      {/* Mobile Header Bar */}
      <div className="sm:hidden">
        <div className="flex justify-between items-center">
          <h1 className="text-lg font-bold text-white">LiveOne</h1>
          
          <div className="flex items-center gap-3">
            {/* Connection Status and Time */}
            <ConnectionStatus isAuthenticated={isAuthenticated} />
            <LastUpdateTime 
              secondsSinceUpdate={secondsSinceUpdate}
              showIcon={true}
              className="text-xs"
            />
            
            {/* Hamburger Menu Button */}
            <button
              onClick={toggleMenu}
              className="p-2 text-gray-400 hover:text-white transition-colors"
              aria-label="Toggle menu"
            >
              {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {isOpen && (
        <div className="sm:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />
          
          {/* Menu Panel */}
          <div className="absolute right-0 top-0 h-full w-64 bg-gray-800 shadow-xl">
            {/* Menu Header */}
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
              <h2 className="text-lg font-semibold text-white">Menu</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-gray-400 hover:text-white transition-colors"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Menu Content */}
            <div className="p-4 space-y-4">
              {/* User Section */}
              <div className="flex items-center gap-3 p-3 bg-gray-700/50 rounded">
                <User className="w-5 h-5 text-gray-400" />
                <div>
                  <p className="text-sm text-gray-400">Logged in as</p>
                  <p className="text-white font-medium">{displayName || 'User'}</p>
                </div>
              </div>
              
              {/* System Info Section */}
              {systemInfo && (
                <div className="p-3 bg-gray-700/50 rounded space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-gray-400" />
                    <p className="text-white font-medium text-sm">System Information</p>
                  </div>
                  <div className="space-y-1 text-xs">
                    {systemInfo.model && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Model:</span>
                        <span className="text-white">{systemInfo.model}</span>
                      </div>
                    )}
                    {systemInfo.serial && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Serial:</span>
                        <span className="text-white">{systemInfo.serial}</span>
                      </div>
                    )}
                    {systemInfo.ratings && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Ratings:</span>
                        <span className="text-white">{systemInfo.ratings}</span>
                      </div>
                    )}
                    {systemInfo.solarSize && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Solar:</span>
                        <span className="text-white">{systemInfo.solarSize}</span>
                      </div>
                    )}
                    {systemInfo.batterySize && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Battery:</span>
                        <span className="text-white">{systemInfo.batterySize}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Logout Button */}
              <button
                onClick={() => {
                  setIsOpen(false)
                  onLogout()
                }}
                className="w-full bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded flex items-center justify-center gap-2 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}