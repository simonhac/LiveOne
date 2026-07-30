'use client'

import { useState, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'

interface SystemInfo {
  model?: string | null
  serial?: string | null
  ratings?: string | null
  solarSize?: string | null
  batterySize?: string | null
}

interface SystemInfoTooltipProps {
  systemInfo: SystemInfo
  systemNumber: string
}

export default function SystemInfoTooltip({ systemInfo, systemNumber }: SystemInfoTooltipProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const iconRef = useRef<HTMLDivElement>(null)

  const handleMouseEnter = () => {
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect()
      setPosition({
        x: rect.right + 8,
        y: rect.top
      })
    }
    setIsVisible(true)
  }

  const handleMouseLeave = () => {
    setIsVisible(false)
  }

  // Check if there's any info to display
  const hasInfo = systemInfo && (
    systemInfo.model || 
    systemInfo.serial || 
    systemInfo.ratings || 
    systemInfo.solarSize || 
    systemInfo.batterySize
  )

  if (!hasInfo) return null

  return (
    <>
      <div ref={iconRef} className="relative inline-block">
        <Info 
          className="w-3 h-3 text-gray-500 hover:text-gray-300 cursor-help transition-colors"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        />
      </div>
      
      {isVisible && (
        <div 
          className="fixed z-[100] bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-lg whitespace-nowrap min-w-[200px]"
          style={{ 
            left: `${position.x}px`,
            top: `${position.y}px`
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <table className="text-xs">
            <tbody>
              {systemInfo.model && (
                <tr>
                  <td className="text-gray-500 pr-3">Model:</td>
                  <td className="text-gray-300">{systemInfo.model}</td>
                </tr>
              )}
              {systemInfo.serial && (
                <tr>
                  <td className="text-gray-500 pr-3">Serial:</td>
                  <td className="text-gray-300">{systemInfo.serial}</td>
                </tr>
              )}
              {systemInfo.ratings && (
                <tr>
                  <td className="text-gray-500 pr-3">Ratings:</td>
                  <td className="text-gray-300">{systemInfo.ratings}</td>
                </tr>
              )}
              {systemInfo.solarSize && (
                <tr>
                  <td className="text-gray-500 pr-3">Solar:</td>
                  <td className="text-gray-300">{systemInfo.solarSize}</td>
                </tr>
              )}
              {systemInfo.batterySize && (
                <tr>
                  <td className="text-gray-500 pr-3">Battery:</td>
                  <td className="text-gray-300">{systemInfo.batterySize}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}