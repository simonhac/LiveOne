'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle, XCircle, X } from 'lucide-react'

export default function ConnectionNotification() {
  const searchParams = useSearchParams()
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<'success' | 'error' | null>(null)
  const [message, setMessage] = useState<string>('')

  useEffect(() => {
    const enphaseStatus = searchParams.get('enphase_status')
    const enphaseMessage = searchParams.get('enphase_message')
    
    if (enphaseStatus && enphaseMessage) {
      setStatus(enphaseStatus as 'success' | 'error')
      setMessage(decodeURIComponent(enphaseMessage))
      setShow(true)
      
      // Auto-hide success messages after 5 seconds
      if (enphaseStatus === 'success') {
        const timer = setTimeout(() => {
          setShow(false)
        }, 5000)
        return () => clearTimeout(timer)
      }
    }
  }, [searchParams])

  if (!show || !status) return null

  return (
    <div className={`fixed top-4 right-4 max-w-md z-50 animate-slide-in-right`}>
      <div className={`rounded-lg shadow-lg border ${
        status === 'success' 
          ? 'bg-green-900/90 border-green-700 text-green-100' 
          : 'bg-red-900/90 border-red-700 text-red-100'
      } backdrop-blur-sm`}>
        <div className="p-4 flex items-start gap-3">
          {status === 'success' ? (
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          ) : (
            <XCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <h3 className="font-semibold mb-1">
              {status === 'success' ? 'Connection Successful' : 'Connection Failed'}
            </h3>
            <p className="text-sm opacity-90">{message}</p>
          </div>
          <button
            onClick={() => setShow(false)}
            className="text-current opacity-70 hover:opacity-100 transition-opacity"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}