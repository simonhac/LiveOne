"use client";

import React, { useId } from "react";

/**
 * A donut that reads as a proportion: an arc from top-centre, clockwise, over a track of the same
 * hue at low alpha — the Activity ring (docs/architecture/tile-style.md, rule 7): a FAT stroke,
 * round caps, an optional gradient along the arc, an optional glyph riding the arc's tip, and an
 * optional notch marking a target (Tesla's charge limit).
 *
 * Deliberately size-agnostic — the SVG scales to whatever box the caller gives it via `className`,
 * and the stroke is a fraction of that box, so one instance serves every container-query
 * breakpoint. The stroke's OUTER edge is the box edge, so a 140px box is a 140px outer diameter.
 */

export interface ProgressRingProps {
  /** Filled proportion, 0..1. Clamped. */
  fraction: number;
  /** The arc colour (an `rgb()`/hex literal). The track is this colour at `trackOpacity`. */
  color: string;
  /** Optional second stop: the arc runs `color` → `gradientTo`. */
  gradientTo?: string;
  /** Stroke width ÷ outer diameter. ~0.14 is the Activity ring's weight. */
  strokeRatio?: number;
  trackOpacity?: number;
  /**
   * A glyph centred on the arc's leading tip — Activity's → / ». Drawn pointing RIGHT; it is turned
   * to the arc's tangent. Size it yourself.
   */
  tip?: React.ReactNode;
  /** A 0..1 position to mark across the ring (a target, e.g. the charge limit). */
  notch?: number | null;
  /** Sizes the ring — e.g. `w-[140px] h-[140px]`. */
  className?: string;
  /** Centred over the ring. */
  children?: React.ReactNode;
}

const BOX = 100;
const C = BOX / 2;

/** Point on a circle of radius `r` at `fraction` of a turn clockwise from 12 o'clock, in BOX units. */
function polar(r: number, fraction: number): { x: number; y: number } {
  const a = 2 * Math.PI * fraction - Math.PI / 2;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

/** One arc + its track, in BOX units. Shared by the single ring and the concentric set. */
function Arc({
  r,
  stroke,
  fraction,
  color,
  gradientId,
  trackOpacity,
}: {
  r: number;
  stroke: number;
  fraction: number;
  color: string;
  gradientId?: string;
  trackOpacity: number;
}) {
  const circumference = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, fraction));
  return (
    <>
      <circle
        cx={C}
        cy={C}
        r={r}
        fill="none"
        stroke={color}
        strokeOpacity={trackOpacity}
        strokeWidth={stroke}
      />
      {filled > 0 && (
        <circle
          cx={C}
          cy={C}
          r={r}
          fill="none"
          stroke={gradientId ? `url(#${gradientId})` : color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)}
          className="tile-ease"
          // Rotate the start point from 3 o'clock to 12; the sweep is already clockwise.
          transform={`rotate(-90 ${C} ${C})`}
        />
      )}
    </>
  );
}

export default function ProgressRing({
  fraction,
  color,
  gradientTo,
  strokeRatio = 0.14,
  trackOpacity = 0.25,
  tip,
  notch,
  className,
  children,
}: ProgressRingProps) {
  const gradientId = useId().replace(/:/g, "");
  const stroke = BOX * strokeRatio;
  const r = (BOX - stroke) / 2;
  const filled = Math.min(1, Math.max(0, fraction));
  const tipAt = polar(r, filled);
  const notchIn = notch != null ? polar(r - stroke / 2, notch) : null;
  const notchOut = notch != null ? polar(r + stroke / 2, notch) : null;

  return (
    <div className={`relative ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${BOX} ${BOX}`}
        width="100%"
        height="100%"
        className="block overflow-visible"
        aria-hidden="true"
      >
        {gradientTo && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={gradientTo} />
            </linearGradient>
          </defs>
        )}
        <Arc
          r={r}
          stroke={stroke}
          fraction={filled}
          color={color}
          gradientId={gradientTo ? gradientId : undefined}
          trackOpacity={trackOpacity}
        />
        {notchIn && notchOut && (
          <line
            x1={notchIn.x}
            y1={notchIn.y}
            x2={notchOut.x}
            y2={notchOut.y}
            stroke="white"
            strokeOpacity={0.85}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        )}
      </svg>
      {tip && filled > 0 && (
        <span
          className="pointer-events-none absolute leading-none"
          style={{
            left: `${tipAt.x}%`,
            top: `${tipAt.y}%`,
            // Turned to the arc's tangent, so a right-pointing glyph points the way the arc runs.
            transform: `translate(-50%, -50%) rotate(${filled * 360}deg)`,
          }}
        >
          {tip}
        </span>
      )}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

/**
 * Concentric rings — the Activity Rings card. Outermost first. Each ring is the same weight and the
 * gap between them is a fixed fraction of the box, so the set scales as one object.
 */
export function ConcentricRings({
  rings,
  strokeRatio = 0.12,
  gapRatio = 0.015,
  className,
}: {
  rings: { fraction: number; color: string; label?: string }[];
  strokeRatio?: number;
  gapRatio?: number;
  className?: string;
}) {
  const stroke = BOX * strokeRatio;
  const gap = BOX * gapRatio;
  return (
    <div className={`relative ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${BOX} ${BOX}`}
        width="100%"
        height="100%"
        className="block"
        role="img"
        aria-label={rings
          .filter((ring) => ring.label)
          .map((ring) => `${ring.label} ${Math.round(ring.fraction * 100)}%`)
          .join(", ")}
      >
        {rings.map((ring, i) => (
          <Arc
            key={i}
            r={(BOX - stroke) / 2 - i * (stroke + gap)}
            stroke={stroke}
            fraction={ring.fraction}
            color={ring.color}
            trackOpacity={0.25}
          />
        ))}
      </svg>
    </div>
  );
}
