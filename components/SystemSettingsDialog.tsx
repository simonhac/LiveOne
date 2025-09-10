'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, CheckCircle2, XCircle } from 'lucide-react'

interface SystemSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  system: {
    systemId: number
    displayName: string
  } | null
  onRename: (systemId: number, newName: string) => Promise<void>
}

export default function SystemSettingsDialog({
  isOpen,
  onClose,
  system,
  onRename
}: SystemSettingsDialogProps) {
  const [editedName, setEditedName] = useState(system?.displayName || '')
  const [isNameDirty, setIsNameDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  
  useEffect(() => {
    setEditedName(system?.displayName || '')
    setIsNameDirty(false)
  }, [system, isOpen])
  
  const handleNameChange = (value: string) => {
    setEditedName(value)
    setIsNameDirty(value !== system?.displayName)
  }
  
  const handleSave = async () => {
    if (!isNameDirty || !system) return
    
    setIsSaving(true)
    try {
      await onRename(system.systemId, editedName)
      setIsNameDirty(false)
    } catch (error) {
      console.error('Failed to rename system:', error)
    } finally {
      setIsSaving(false)
    }
  }
  
  const handleCancel = () => {
    setEditedName(system?.displayName || '')
    setIsNameDirty(false)
  }
  
  if (!isOpen || !system || typeof document === 'undefined') return null
  
  return createPortal(
    <>
      {/* Backdrop with blur */}
      <div 
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]"
        onClick={onClose}
      />
      
      {/* Dialog */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-md">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-medium text-gray-100">System Settings</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
          
          {/* Content */}
          <div className="px-6 py-4 space-y-4">
            {/* Name field */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Display Name
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isSaving}
                />
                {/* Always reserve space for buttons to prevent layout shift */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleSave}
                    disabled={isSaving || !isNameDirty}
                    className={`p-1 rounded-full transition-all ${
                      isNameDirty 
                        ? 'text-green-500 hover:text-green-400 cursor-pointer' 
                        : 'text-gray-800 cursor-default'
                    } disabled:opacity-50`}
                    title="Save"
                  >
                    <CheckCircle2 className="w-6 h-6" />
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={isSaving || !isNameDirty}
                    className={`p-1 rounded-full transition-all ${
                      isNameDirty 
                        ? 'text-red-500 hover:text-red-400 cursor-pointer' 
                        : 'text-gray-800 cursor-default'
                    } disabled:opacity-50`}
                    title="Cancel"
                  >
                    <XCircle className="w-6 h-6" />
                  </button>
                </div>
              </div>
            </div>
            
            {/* Additional settings can be added here */}
          </div>
          
          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-md transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}