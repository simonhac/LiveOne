'use client'

import { useState } from 'react'
import { Zap } from 'lucide-react'
import TestSelectLiveModal from './TestSelectLiveModal'

interface TestSelectLiveButtonProps {
  displayName?: string | null  // Optional - we might not know it yet
  ownerClerkUserId: string
  vendorType: string
  vendorSiteId: string
  disabled?: boolean
  className?: string
}

export default function TestSelectLiveButton({
  displayName,
  ownerClerkUserId,
  vendorType,
  vendorSiteId,
  disabled = false,
  className = ''
}: TestSelectLiveButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        disabled={disabled || !ownerClerkUserId}
        className={`flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors ${className}`}
      >
        <Zap className="w-4 h-4" />
        Test
      </button>

      {isModalOpen && (
        <TestSelectLiveModal
          displayName={displayName}
          ownerClerkUserId={ownerClerkUserId}
          vendorType={vendorType}
          vendorSiteId={vendorSiteId}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  )
}