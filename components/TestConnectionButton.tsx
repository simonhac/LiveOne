'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Zap } from 'lucide-react'
import TestConnectionModal from './TestConnectionModal'

interface TestConnectionButtonProps {
  displayName?: string | null  // Optional - we might not know it yet
  ownerClerkUserId: string
  vendorType: string
  vendorSiteId: string
  disabled?: boolean
  className?: string
}

export default function TestConnectionButton({
  displayName,
  ownerClerkUserId,
  vendorType,
  vendorSiteId,
  disabled = false,
  className = ''
}: TestConnectionButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Enable for both Selectronic and Enphase systems
  const isSupported = vendorType === 'select.live' || vendorType === 'enphase'
  const buttonDisabled = disabled || !ownerClerkUserId || !isSupported

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        disabled={buttonDisabled}
        className={`flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors ${className}`}
        title={!isSupported ? 'Test connection not available for this vendor type' : undefined}
      >
        <Zap className="w-4 h-4" />
        Test
      </button>

      {isModalOpen && typeof document !== 'undefined' && createPortal(
        <TestConnectionModal
          displayName={displayName}
          ownerClerkUserId={ownerClerkUserId}
          vendorType={vendorType}
          vendorSiteId={vendorSiteId}
          onClose={() => setIsModalOpen(false)}
        />,
        document.body
      )}
    </>
  )
}