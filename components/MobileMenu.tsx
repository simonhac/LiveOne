'use client'

import { useState, useRef, useEffect } from 'react'
import { Menu, X, User, LogOut, Info, ChevronDown, Settings, FlaskConical, Plus, Shield } from 'lucide-react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import LastUpdateTime from './LastUpdateTime'

interface SystemInfo {
  model?: string
  serial?: string
  ratings?: string
  solarSize?: string
  batterySize?: string
}

interface AvailableSystem {
  id: number
  displayName: string
}

interface MobileMenuProps {
  displayName: string | null
  secondsSinceUpdate: number
  onLogout: () => void
  systemInfo?: SystemInfo | null
  availableSystems?: AvailableSystem[]
  currentSystemId?: string
  onTestConnection?: () => void
  vendorType?: string
  supportsPolling?: boolean
  isAdmin?: boolean
  systemStatus?: 'active' | 'disabled' | 'removed'
}

export default function MobileMenu({ 
  displayName, 
  secondsSinceUpdate,
  onLogout,
  systemInfo,
  availableSystems = [],
  currentSystemId,
  onTestConnection,
  vendorType,
  supportsPolling = false,
  isAdmin = false,
  systemStatus
}: MobileMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isSystemDropdownOpen, setIsSystemDropdownOpen] = useState(false)
  const router = useRouter()
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { user } = useUser()

  const toggleMenu = () => setIsOpen(!isOpen)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsSystemDropdownOpen(false)
      }
    }

    if (isSystemDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isSystemDropdownOpen])

  const handleSystemSelect = (systemId: number) => {
    router.push(`/dashboard/${systemId}`)
    setIsSystemDropdownOpen(false)
  }

  return (
    <>
      {/* Mobile Header Bar */}
      <div className="sm:hidden">
        <div className="flex justify-between items-center">
          <div className="relative" ref={dropdownRef}>
            {availableSystems.length > 1 ? (
              <button
                onClick={() => setIsSystemDropdownOpen(!isSystemDropdownOpen)}
                className="flex items-center gap-1 text-base font-bold text-white hover:text-blue-400 transition-colors"
              >
                {displayName || 'Select System'}
                <ChevronDown className={`w-4 h-4 transition-transform ${isSystemDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
            ) : (
              <h1 className="text-base font-bold text-white">{displayName || 'LiveOne'}</h1>
            )}
            
            {/* System Dropdown Menu */}
            {isSystemDropdownOpen && availableSystems.length > 1 && (
              <div className="absolute top-full left-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-50">
                {availableSystems.map((system) => (
                  <button
                    key={system.id}
                    onClick={() => handleSystemSelect(system.id)}
                    className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-700 transition-colors first:rounded-t-lg last:rounded-b-lg ${
                      system.id.toString() === currentSystemId ? 'text-blue-400 bg-gray-700/50' : 'text-white'
                    }`}
                  >
                    {system.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {/* Connection Status and Time */}
            <LastUpdateTime 
              secondsSinceUpdate={secondsSinceUpdate}
              showIcon={true}
              className="text-xs"
            />
            
            {/* Admin Link */}
            {isAdmin && (
              <Link
                href="/admin"
                className="p-1.5 text-blue-500 hover:text-blue-400 transition-colors"
                aria-label="Admin"
              >
                <Shield className="w-4 h-4" />
              </Link>
            )}
            
            {/* Hamburger Menu Button */}
            <button
              onClick={toggleMenu}
              className="p-1.5 text-gray-400 hover:text-white transition-colors"
              aria-label="Toggle menu"
            >
              {isOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
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
                  <p className="text-white font-medium">
                    {user?.firstName && user?.lastName 
                      ? `${user.firstName} ${user.lastName}`
                      : user?.username 
                      || user?.primaryEmailAddress?.emailAddress
                      || 'User'}
                  </p>
                </div>
              </div>
              
              {/* Settings Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <Settings className="w-4 h-4 text-gray-400" />
                  <p className="text-white font-medium text-sm">Settings</p>
                </div>
                
                {/* Test Connection - Only show for vendors that support polling and for admin or non-removed systems */}
                {onTestConnection && supportsPolling && (isAdmin || systemStatus !== 'removed') && (
                  <button
                    onClick={() => {
                      setIsOpen(false)
                      onTestConnection()
                    }}
                    className="w-full p-3 bg-gray-700/50 hover:bg-gray-700 rounded text-left text-sm text-white transition-colors flex items-center gap-2"
                  >
                    <FlaskConical className="w-4 h-4" />
                    Test Connection
                  </button>
                )}
                
                {vendorType !== 'enphase' && (
                  <Link
                    href="/auth/enphase/connect"
                    onClick={() => setIsOpen(false)}
                    className="w-full p-3 bg-gray-700/50 hover:bg-gray-700 rounded text-left text-sm text-white transition-colors flex items-center gap-2 block"
                  >
                    <Plus className="w-4 h-4" />
                    Add Enphase
                  </Link>
                )}
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