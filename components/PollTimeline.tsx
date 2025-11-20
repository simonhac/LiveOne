"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { PollStage } from "@/lib/vendors/types";

interface PollTimelineProps {
  stages: PollStage[];
  sessionStartMs: number;
  sessionEndMs: number;
  isLive?: boolean; // Whether bars are still growing
}

/**
 * Gantt chart-style timeline showing poll stages (login, download, insert)
 * Similar to Chrome DevTools Network panel timeline
 * Server sends updates every 200ms, client animates smoothly between updates
 */
export function PollTimeline({
  stages,
  sessionStartMs,
  sessionEndMs,
}: PollTimelineProps) {
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Minimum timeline width of 20 seconds (20000ms)
  const minTimelineWidth = 20000;
  const actualDuration = sessionEndMs - sessionStartMs;
  const sessionDuration = Math.max(actualDuration, minTimelineWidth);

  // Minimum bar width in pixels for visibility
  const getMinBarWidth = (stageName: PollStage["name"]) => {
    return stageName === "insert" ? 5 : 10;
  };

  // Format duration as #,##0 ms
  const formatMs = (ms: number): string => {
    return `${Math.round(ms).toLocaleString()} ms`;
  };

  // Stage colors - emerald, purple, orange palette
  const stageColors: Record<PollStage["name"], { bg: string }> = {
    login: { bg: "bg-emerald-600" }, // Emerald green
    download: { bg: "bg-purple-600" }, // Purple
    insert: { bg: "bg-orange-600" }, // Orange
  };

  return (
    <>
      <div
        className="relative h-6 w-full"
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setTooltipPos({
            x: rect.left + rect.width / 2,
            y: rect.top - 10,
          });
        }}
        onMouseLeave={() => setTooltipPos(null)}
      >
        {/* Timeline container */}
        <div className="absolute inset-0 flex items-center">
          {stages.map((stage, index) => {
            // Calculate position and width as percentages of session duration
            const startOffset =
              ((stage.startMs - sessionStartMs) / sessionDuration) * 100;
            const width =
              ((stage.endMs - stage.startMs) / sessionDuration) * 100;
            const duration = stage.endMs - stage.startMs;

            return (
              <div
                key={`${stage.name}-${index}`}
                className={`absolute ${stageColors[stage.name].bg} transition-all duration-200 ease-linear`}
                style={{
                  left: `${startOffset}%`,
                  width: `max(${Math.max(width, 0)}%, ${getMinBarWidth(stage.name)}px)`,
                  height: "16px", // Fixed height to ensure consistency
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Portal tooltip - rendered at document body level to avoid clipping */}
      {tooltipPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap pointer-events-none z-[9999]"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y}px`,
              transform: "translate(-50%, -100%)",
            }}
          >
            <table>
              <tbody>
                {stages.map((stage, index) => (
                  <tr key={index}>
                    <td className="pr-3 text-left text-gray-400">
                      {stage.name}
                    </td>
                    <td className="text-right">
                      {formatMs(stage.endMs - stage.startMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
          document.body,
        )}
    </>
  );
}
