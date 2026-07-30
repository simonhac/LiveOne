"use client";

import { useState, useRef, useEffect } from "react";
import { Info } from "lucide-react";

interface DeviceInfo {
  model?: string | null;
  serial?: string | null;
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
}

interface DeviceInfoTooltipProps {
  deviceInfo: DeviceInfo;
  systemNumber: string;
}

export default function DeviceInfoTooltip({
  deviceInfo,
  systemNumber,
}: DeviceInfoTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const iconRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = () => {
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      setPosition({
        x: rect.right + 8,
        y: rect.top,
      });
    }
    setIsVisible(true);
  };

  const handleMouseLeave = () => {
    setIsVisible(false);
  };

  // Check if there's any info to display
  const hasInfo =
    deviceInfo &&
    (deviceInfo.model ||
      deviceInfo.serial ||
      deviceInfo.ratings ||
      deviceInfo.solarSize ||
      deviceInfo.batterySize);

  if (!hasInfo) return null;

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
            top: `${position.y}px`,
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <table className="text-xs">
            <tbody>
              {deviceInfo.model && (
                <tr>
                  <td className="text-gray-500 pr-3">Model:</td>
                  <td className="text-gray-300">{deviceInfo.model}</td>
                </tr>
              )}
              {deviceInfo.serial && (
                <tr>
                  <td className="text-gray-500 pr-3">Serial:</td>
                  <td className="text-gray-300">{deviceInfo.serial}</td>
                </tr>
              )}
              {deviceInfo.ratings && (
                <tr>
                  <td className="text-gray-500 pr-3">Ratings:</td>
                  <td className="text-gray-300">{deviceInfo.ratings}</td>
                </tr>
              )}
              {deviceInfo.solarSize && (
                <tr>
                  <td className="text-gray-500 pr-3">Solar:</td>
                  <td className="text-gray-300">{deviceInfo.solarSize}</td>
                </tr>
              )}
              {deviceInfo.batterySize && (
                <tr>
                  <td className="text-gray-500 pr-3">Battery:</td>
                  <td className="text-gray-300">{deviceInfo.batterySize}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
