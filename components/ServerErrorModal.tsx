'use client'

import { X, WifiOff, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ServerErrorModalProps {
  isOpen: boolean
  onClose: () => void
  errorType: 'connection' | 'server' | null
  errorDetails?: string
}

export default function ServerErrorModal({ isOpen, onClose, errorType, errorDetails }: ServerErrorModalProps) {
  const [isVisible, setIsVisible] = useState(false)
  const isDevelopment = process.env.NODE_ENV === 'development'

  useEffect(() => {
    if (isOpen) {
      // Small delay to trigger animation
      setTimeout(() => setIsVisible(true), 10)
    } else {
      setIsVisible(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const getErrorContent = () => {
    if (errorType === 'connection') {
      return {
        icon: <WifiOff className="w-12 h-12 text-red-500" />,
        title: 'Connection Lost',
        message: isDevelopment 
          ? 'Unable to connect to the server. The development server may have stopped or there might be a network issue.'
          : 'Unable to connect to the server. Please check your internet connection or try again later.',
        details: isDevelopment 
          ? [
              'Check if the development server is running (npm run dev)',
              'Verify your network connection',
              'Try refreshing the page'
            ]
          : [
              'Check your internet connection',
              'Try refreshing the page',
              'If the problem persists, please try again later'
            ]
      }
    } else if (errorType === 'server') {
      return {
        icon: <AlertTriangle className="w-12 h-12 text-yellow-500" />,
        title: 'Server Error',
        message: errorDetails || 'The server encountered an error while processing your request.',
        details: []
      }
    }
    return null
  }

  const content = getErrorContent()
  if (!content) return null

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black bg-opacity-50"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className={`relative bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4 transform transition-transform duration-200 ${isVisible ? 'scale-100' : 'scale-95'}`}>
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Content */}
        <div className="flex flex-col items-center text-center">
          {content.icon}
          
          <h2 className="text-xl font-semibold text-white mt-4 mb-2">
            {content.title}
          </h2>
          
          <p className="text-gray-300 mb-4">
            {content.message}
          </p>
          
          {content.details.length > 0 && (
            <div className="w-full bg-gray-900 rounded-lg p-4 mb-4">
              <p className="text-sm font-medium text-gray-400 mb-2">Troubleshooting steps:</p>
              <ul className="text-sm text-gray-300 text-left space-y-1">
                {content.details.map((detail, index) => (
                  <li key={index} className="flex items-start">
                    <span className="text-gray-500 mr-2">•</span>
                    <span>{detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}