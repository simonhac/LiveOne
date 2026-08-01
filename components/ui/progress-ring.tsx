import React from "react";

/**
 * A donut that reads as a proportion: an arc from top-centre, clockwise, over a
 * track of the same colour at 20% opacity.
 *
 * Deliberately size-agnostic — the SVG scales to whatever box the caller gives
 * it via `className`, and the stroke is a fraction of that box, so one instance
 * serves every container-query breakpoint. The stroke's OUTER edge is the box
 * edge, so a 140px box is a 140px outer diameter (which is how it lines up with
 * Amber's 140px disc).
 */

export interface ProgressRingProps {
  /** Filled proportion, 0..1. Clamped. */
  fraction: number;
  /** The arc colour. The unfilled remainder is this colour at 20% opacity. */
  color: string;
  /** Stroke width ÷ outer diameter. */
  strokeRatio?: number;
  /** Sizes the ring — e.g. `w-[140px] h-[140px]`. */
  className?: string;
  /** Centred over the ring. */
  children?: React.ReactNode;
}

const BOX = 100;

export default function ProgressRing({
  fraction,
  color,
  strokeRatio = 0.06,
  className,
  children,
}: ProgressRingProps) {
  const stroke = BOX * strokeRatio;
  const r = (BOX - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, fraction));

  return (
    <div className={`relative ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${BOX} ${BOX}`}
        width="100%"
        height="100%"
        className="block"
        aria-hidden="true"
      >
        <circle
          cx={BOX / 2}
          cy={BOX / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeOpacity={0.2}
          strokeWidth={stroke}
        />
        {filled > 0 && (
          <circle
            cx={BOX / 2}
            cy={BOX / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - filled)}
            // Rotate the start point from 3 o'clock to 12; the sweep is already clockwise.
            transform={`rotate(-90 ${BOX / 2} ${BOX / 2})`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}
