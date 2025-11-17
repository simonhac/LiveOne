"use client";

import { useState, useEffect } from "react";
import { Clock } from "lucide-react";

interface LastUpdateTimeProps {
  lastUpdate: Date | null;
  showIcon?: boolean;
  className?: string;
}

export default function LastUpdateTime({
  lastUpdate,
  showIcon = true,
  className = "",
}: LastUpdateTimeProps) {
  const [secondsSinceUpdate, setSecondsSinceUpdate] = useState<number>(0);

  useEffect(() => {
    if (!lastUpdate) {
      setSecondsSinceUpdate(0);
      return;
    }

    // Calculate initial value
    const calculateSeconds = () => {
      return Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
    };

    setSecondsSinceUpdate(calculateSeconds());

    // Update every second
    const interval = setInterval(() => {
      setSecondsSinceUpdate(calculateSeconds());
    }, 1000);

    return () => clearInterval(interval);
  }, [lastUpdate]);

  const formatTime = () => {
    if (secondsSinceUpdate === 0) return "Just\u00A0now";
    if (secondsSinceUpdate === 1) return "1\u00A0second\u00A0ago";
    if (secondsSinceUpdate < 60) return `${secondsSinceUpdate}s\u00A0ago`;
    if (secondsSinceUpdate < 3600)
      return `${Math.floor(secondsSinceUpdate / 60)}m\u00A0ago`;
    if (secondsSinceUpdate < 86400)
      return `${Math.floor(secondsSinceUpdate / 3600)}h\u00A0ago`;
    return `${Math.floor(secondsSinceUpdate / 86400)}d\u00A0ago`;
  };

  const formatShortTime = () => {
    if (secondsSinceUpdate < 60) return `${secondsSinceUpdate}s`;
    if (secondsSinceUpdate < 3600)
      return `${Math.floor(secondsSinceUpdate / 60)}m`;
    if (secondsSinceUpdate < 86400)
      return `${Math.floor(secondsSinceUpdate / 3600)}h`;
    return `${Math.floor(secondsSinceUpdate / 86400)}d`;
  };

  return (
    <div
      className={`text-sm text-gray-400 flex items-center gap-2 ${className}`}
    >
      {showIcon && <Clock className="w-4 h-4" />}
      <span className="text-white hidden sm:inline">{formatTime()}</span>
      <span className="text-white sm:hidden">{formatShortTime()}</span>
    </div>
  );
}
