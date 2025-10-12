'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, CheckCircle2, XCircle } from 'lucide-react'

interface PointInfo {
  pointDbId: number
  pointSubId: string | null
  subsystem: string | null
  defaultName: string
  name: string | null
  metricType: string
  metricUnit: string | null
}

interface PointInfoModalProps {
  isOpen: boolean
  onClose: () => void
  pointInfo: PointInfo | null
  onUpdate: (pointDbId: number, updates: { subsystem: string | null, name: string | null }) => Promise<void>
}

export default function PointInfoModal({
  isOpen,
  onClose,
  pointInfo,
  onUpdate
}: PointInfoModalProps) {
  const [editedSubsystem, setEditedSubsystem] = useState(pointInfo?.subsystem || '')
  const [editedName, setEditedName] = useState(pointInfo?.name || '')
  const [isSubsystemDirty, setIsSubsystemDirty] = useState(false)
  const [isNameDirty, setIsNameDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setEditedSubsystem(pointInfo?.subsystem || '')
    setEditedName(pointInfo?.name || '')
    setIsSubsystemDirty(false)
    setIsNameDirty(false)
  }, [pointInfo, isOpen])

  const handleSubsystemChange = (value: string) => {
    setEditedSubsystem(value)
    setIsSubsystemDirty(value !== (pointInfo?.subsystem || ''))
  }

  const handleNameChange = (value: string) => {
    setEditedName(value)
    setIsNameDirty(value !== (pointInfo?.name || ''))
  }

  const handleSaveSubsystem = async () => {
    if (!isSubsystemDirty || !pointInfo) return

    setIsSaving(true)
    try {
      await onUpdate(pointInfo.pointDbId, {
        subsystem: editedSubsystem || null,
        name: pointInfo.name
      })
      setIsSubsystemDirty(false)
    } catch (error) {
      console.error('Failed to update subsystem:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveName = async () => {
    if (!isNameDirty || !pointInfo) return

    setIsSaving(true)
    try {
      await onUpdate(pointInfo.pointDbId, {
        subsystem: pointInfo.subsystem,
        name: editedName || null
      })
      setIsNameDirty(false)
    } catch (error) {
      console.error('Failed to update name:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancelSubsystem = () => {
    setEditedSubsystem(pointInfo?.subsystem || '')
    setIsSubsystemDirty(false)
  }

  const handleCancelName = () => {
    setEditedName(pointInfo?.name || '')
    setIsNameDirty(false)
  }

  if (!isOpen || !pointInfo || typeof document === 'undefined') return null

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
            <h2 className="text-lg font-medium text-gray-100">Point Information</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-2">
            {/* Read-only fields */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Point Sub ID:
              </label>
              <div className="px-3 py-2 bg-gray-800 rounded-md text-gray-400 font-mono text-sm flex-1">
                {pointInfo.pointSubId || 'N/A'}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Default Name:
              </label>
              <div className="px-3 py-2 bg-gray-800 rounded-md text-gray-400 text-sm flex-1">
                {pointInfo.defaultName}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Metric Type:
              </label>
              <div className="px-3 py-2 bg-gray-800 rounded-md text-gray-400 text-sm flex-1">
                {pointInfo.metricType}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Metric Unit:
              </label>
              <div className="px-3 py-2 bg-gray-800 rounded-md text-gray-400 text-sm flex-1">
                {pointInfo.metricUnit || 'N/A'}
              </div>
            </div>

            {/* Editable: Subsystem */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Subsystem:
              </label>
              <input
                type="text"
                value={editedSubsystem}
                onChange={(e) => handleSubsystemChange(e.target.value)}
                placeholder="e.g., solar, battery, grid, load"
                className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                disabled={isSaving}
              />
              {/* Always reserve space for buttons to prevent layout shift */}
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSaveSubsystem}
                  disabled={isSaving || !isSubsystemDirty}
                  className={`p-1 rounded-full transition-all ${
                    isSubsystemDirty
                      ? 'text-green-500 hover:text-green-400 cursor-pointer'
                      : 'text-gray-800 cursor-default'
                  } disabled:opacity-50`}
                  title="Save"
                >
                  <CheckCircle2 className="w-6 h-6" />
                </button>
                <button
                  onClick={handleCancelSubsystem}
                  disabled={isSaving || !isSubsystemDirty}
                  className={`p-1 rounded-full transition-all ${
                    isSubsystemDirty
                      ? 'text-red-500 hover:text-red-400 cursor-pointer'
                      : 'text-gray-800 cursor-default'
                  } disabled:opacity-50`}
                  title="Cancel"
                >
                  <XCircle className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Default Name:
              </label>
              <div className="px-3 py-2 bg-gray-800 rounded-md text-gray-400 text-sm flex-1">
                {pointInfo.defaultName}
              </div>
            </div>

            {/* Editable: Name */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 w-32 flex-shrink-0">
                Custom Name:
              </label>
              <input
                type="text"
                value={editedName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={pointInfo.defaultName}
                className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                disabled={isSaving}
              />
              {/* Always reserve space for buttons to prevent layout shift */}
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSaveName}
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
                  onClick={handleCancelName}
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
