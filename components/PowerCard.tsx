import React from 'react'

interface PowerCardProps {
  title: string
  value: string
  icon: React.ReactNode
  iconColor: string
  bgColor: string
  borderColor: string
  secondsSinceUpdate?: number
  staleThresholdSeconds: number
  extraInfo?: string
  extra?: React.ReactNode
}

export default function PowerCard({
  title,
  value,
  icon,
  iconColor,
  bgColor,
  borderColor,
  secondsSinceUpdate = 0,
  staleThresholdSeconds,
  extraInfo,
  extra
}: PowerCardProps) {
  const isStale = secondsSinceUpdate > staleThresholdSeconds
  
  return (
    <div className={`${bgColor} border ${borderColor} rounded-lg p-4 relative overflow-hidden ${isStale ? 'opacity-75' : ''}`}>
      {isStale && (
        <div 
          className="absolute inset-0 opacity-30 pointer-events-none"
          style={{
            backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(255,255,255,0.15) 10px, rgba(255,255,255,0.15) 20px)'
          }}
        />
      )}
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-400 text-sm">{title}</span>
          <div className={iconColor}>{icon}</div>
        </div>
        <p className="text-2xl font-bold text-white">{value}</p>
        {extraInfo && (
          <p className="text-xs text-gray-500 mt-1">{extraInfo}</p>
        )}
        {extra && (
          <div className="mt-2">
            {extra}
          </div>
        )}
      </div>
    </div>
  )
}