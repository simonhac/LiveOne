'use client'

import { Clock } from 'lucide-react'

interface LastUpdateTimeProps {
  secondsSinceUpdate: number
  showIcon?: boolean
  className?: string
}

export default function LastUpdateTime({ 
  secondsSinceUpdate, 
  showIcon = true,
  className = '' 
}: LastUpdateTimeProps) {
  const formatTime = () => {
    if (secondsSinceUpdate === 0) return 'Just\u00A0now'
    if (secondsSinceUpdate === 1) return '1\u00A0second\u00A0ago'
    if (secondsSinceUpdate < 60) return `${secondsSinceUpdate}s\u00A0ago`
    if (secondsSinceUpdate < 3600) return `${Math.floor(secondsSinceUpdate / 60)}m\u00A0ago`
    if (secondsSinceUpdate < 86400) return `${Math.floor(secondsSinceUpdate / 3600)}h\u00A0ago`
    return `${Math.floor(secondsSinceUpdate / 86400)}d\u00A0ago`
  }

  const formatShortTime = () => {
    if (secondsSinceUpdate < 60) return `${secondsSinceUpdate}s`
    if (secondsSinceUpdate < 3600) return `${Math.floor(secondsSinceUpdate / 60)}m`
    if (secondsSinceUpdate < 86400) return `${Math.floor(secondsSinceUpdate / 3600)}h`
    return `${Math.floor(secondsSinceUpdate / 86400)}d`
  }

  return (
    <div className={`text-sm text-gray-400 flex items-center gap-2 ${className}`}>
      {showIcon && <Clock className="w-4 h-4" />}
      <span className="text-white hidden sm:inline">
        {formatTime()}
      </span>
      <span className="text-white sm:hidden">
        {formatShortTime()}
      </span>
    </div>
  )
}