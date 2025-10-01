'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreVertical, Play, Pause, Trash2, FlaskConical, BarChart3, Settings, RefreshCw, Database } from 'lucide-react'

interface SystemActionsMenuProps {
  systemId: number
  systemName: string
  status: 'active' | 'disabled' | 'removed'
  vendorType?: string
  supportsPolling?: boolean
  dataStore?: 'readings' | 'point_readings'
  onTest: () => void
  onPollNow?: () => void
  onStatusChange: (status: 'active' | 'disabled' | 'removed') => void
  onPollingStats?: () => void
  onSettings?: () => void
  onViewData?: () => void
}

export default function SystemActionsMenu({
  systemId,
  systemName,
  status,
  vendorType,
  supportsPolling = false,
  dataStore,
  onTest,
  onPollNow,
  onStatusChange,
  onPollingStats,
  onSettings,
  onViewData
}: SystemActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setMenuPosition({
        top: rect.top,
        left: rect.right + 8 // 8px gap to the right of button
      })
    }
  }, [isOpen])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isOpen && 
          !buttonRef.current?.contains(e.target as Node) && 
          !menuRef.current?.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [isOpen])

  const handleMenuClick = (action: () => void) => {
    action()
    setIsOpen(false)
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex p-1.5 hover:bg-gray-600 rounded transition-colors"
      >
        <MoreVertical className="w-4 h-4 text-gray-400" />
      </button>
      
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div 
          ref={menuRef}
          className="fixed z-[9999] bg-gray-800 border border-gray-700 rounded-md shadow-lg py-1 min-w-[160px]"
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`
          }}
        >
          {/* Test Connection - Only show for vendors that support polling */}
          {supportsPolling && (
            <button
              onClick={() => handleMenuClick(onTest)}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <FlaskConical className="w-4 h-4" />
              Test Connection
            </button>
          )}
          {/* Poll Now - Only show for vendors that support polling */}
          {supportsPolling && onPollNow && (
            <button
              onClick={() => handleMenuClick(onPollNow)}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Poll Now
            </button>
          )}
          {/* View Data - Only show for systems with point_readings */}
          {dataStore === 'point_readings' && onViewData && (
            <button
              onClick={() => handleMenuClick(onViewData)}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <Database className="w-4 h-4" />
              View Data
            </button>
          )}
          {onPollingStats && (
            <button
              onClick={() => handleMenuClick(onPollingStats)}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <BarChart3 className="w-4 h-4" />
              Polling Stats
            </button>
          )}
          <div className="border-t border-gray-700 my-1"></div>
          {status !== 'active' && (
            <button
              onClick={() => handleMenuClick(() => onStatusChange('active'))}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              Set Active
            </button>
          )}
          {status !== 'disabled' && (
            <button
              onClick={() => handleMenuClick(() => onStatusChange('disabled'))}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <Pause className="w-4 h-4" />
              Disable
            </button>
          )}
          {status !== 'removed' && (
            <button
              onClick={() => handleMenuClick(() => onStatusChange('removed'))}
              className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Mark Removed
            </button>
          )}
          {onSettings && (
            <>
              <div className="border-t border-gray-700 my-1"></div>
              <button
                onClick={() => handleMenuClick(onSettings)}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
              >
                <Settings className="w-4 h-4" />
                Settings
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  )
}