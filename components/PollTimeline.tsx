"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PollStage } from "@/lib/vendors/types";

interface PollTimelineProps {
  stages: PollStage[];
  sessionStartMs: number;
  sessionEndMs: number;
  isLive?: boolean; // Whether bars are still growing
}

// Animation duration in ms for each stage type
const ANIMATION_DURATION = {
  login: 200,
  download: 200,
  insert: 500,
};

/**
 * Gantt chart-style timeline showing poll stages (login, download, insert)
 * Similar to Chrome DevTools Network panel timeline
 * Uses GPU-accelerated transforms for smooth 60fps animation
 */
export function PollTimeline({
  stages,
  sessionStartMs,
  sessionEndMs,
}: PollTimelineProps) {
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Refs to DOM elements for direct manipulation
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Animation state stored in ref to avoid re-renders
  // We animate scaleX from 0 to 1, where 1 = target width
  const animationState = useRef<
    Map<
      string,
      {
        currentScale: number; // 0 to 1
        targetScale: number; // 0 to 1
        startScale: number;
        startTime: number;
        duration: number;
        targetWidthPercent: number; // The actual width we're scaling to
      }
    >
  >(new Map());

  const rafRef = useRef<number | null>(null);

  // Minimum timeline width of 20 seconds (20000ms)
  const minTimelineWidth = 20000;
  const actualDuration = sessionEndMs - sessionStartMs;
  const sessionDuration = Math.max(actualDuration, minTimelineWidth);

  // Easing function (ease-out cubic for smooth deceleration)
  const easeOutCubic = (t: number): number => {
    return 1 - Math.pow(1 - t, 3);
  };

  // Animation loop - updates transforms directly (GPU accelerated)
  const animate = useCallback(() => {
    const now = performance.now();
    let stillAnimating = false;

    animationState.current.forEach((state, key) => {
      const elapsed = now - state.startTime;
      const progress = Math.min(elapsed / state.duration, 1);
      const easedProgress = easeOutCubic(progress);

      const newScale =
        state.startScale +
        (state.targetScale - state.startScale) * easedProgress;
      state.currentScale = newScale;

      // Update transform directly (GPU accelerated)
      const el = barRefs.current.get(key);
      if (el) {
        el.style.transform = `scaleX(${newScale})`;
      }

      if (progress < 1) {
        stillAnimating = true;
      }
    });

    if (stillAnimating) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      rafRef.current = null;
    }
  }, []);

  // Update targets when stages change
  useEffect(() => {
    const now = performance.now();

    stages.forEach((stage) => {
      const key = `${stage.name}-${stage.startMs}`;
      const targetWidthPercent =
        ((stage.endMs - stage.startMs) / sessionDuration) * 100;
      // Insert has minimum width
      const minWidth = stage.name === "insert" ? 0.25 : 0;
      const finalWidthPercent = Math.max(targetWidthPercent, minWidth);

      const existing = animationState.current.get(key);

      if (!existing) {
        // New stage - start from scale 0
        animationState.current.set(key, {
          currentScale: 0,
          targetScale: 1,
          startScale: 0,
          startTime: now,
          duration: ANIMATION_DURATION[stage.name],
          targetWidthPercent: finalWidthPercent,
        });

        // Set initial width on element (will be scaled by transform)
        const el = barRefs.current.get(key);
        if (el) {
          el.style.width = `${finalWidthPercent}%`;
          el.style.transform = "scaleX(0)";
        }
      } else if (
        Math.abs(existing.targetWidthPercent - finalWidthPercent) > 0.01
      ) {
        // Width target changed - update width and continue scaling
        const el = barRefs.current.get(key);
        if (el) {
          // Calculate what the current visual width is
          const currentVisualWidth =
            existing.targetWidthPercent * existing.currentScale;
          // Set new width and adjust scale to maintain visual continuity
          el.style.width = `${finalWidthPercent}%`;
          const newCurrentScale = currentVisualWidth / finalWidthPercent;

          existing.targetWidthPercent = finalWidthPercent;
          existing.startScale = newCurrentScale;
          existing.currentScale = newCurrentScale;
          existing.targetScale = 1;
          existing.startTime = now;
          existing.duration = ANIMATION_DURATION[stage.name];

          el.style.transform = `scaleX(${newCurrentScale})`;
        }
      }
    });

    // Start animation if not running
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [stages, sessionDuration, animate]);

  // Format duration as #,##0 ms
  const formatMs = (ms: number): string => {
    return `${Math.round(ms).toLocaleString()} ms`;
  };

  // Stage colors - emerald, purple, orange palette
  const stageColors: Record<PollStage["name"], string> = {
    login: "bg-emerald-600",
    download: "bg-purple-600",
    insert: "bg-orange-600",
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
            const startOffset =
              ((stage.startMs - sessionStartMs) / sessionDuration) * 100;
            const stageKey = `${stage.name}-${stage.startMs}`;
            const targetWidth =
              ((stage.endMs - stage.startMs) / sessionDuration) * 100;
            const minWidth = stage.name === "insert" ? 0.25 : 0;
            const finalWidth = Math.max(targetWidth, minWidth);

            return (
              <div
                key={`${stage.name}-${index}`}
                ref={(el) => {
                  if (el) {
                    barRefs.current.set(stageKey, el);
                    // Initialize width if not set
                    if (!el.style.width) {
                      el.style.width = `${finalWidth}%`;
                      el.style.transform = "scaleX(0)";
                    }
                  } else {
                    barRefs.current.delete(stageKey);
                  }
                }}
                className={`absolute ${stageColors[stage.name]}`}
                style={{
                  left: `${startOffset}%`,
                  height: "16px",
                  transformOrigin: "left",
                  willChange: "transform",
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
