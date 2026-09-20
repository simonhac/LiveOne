"use client";

/**
 * Staleness for tiles — one implementation for the four shells that used to each carry their own
 * copy (Tile, StatCardShell, GridSignalsCard, and the formatter all three duplicated).
 *
 * "Stale is quiet" (docs/architecture/tile-style.md, rule 10): no diagonal hatch, no dimmed box. A
 * stale tile's VALUES fall to `TILE_STALE`, and a clock + the reading's age sits in the caption slot
 * ("12 min ago"), with the exact time on hover.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock } from "lucide-react";
import { TILE_CAPTION } from "@/lib/tile-style";

/** "just now" / "4 min ago" / "3 h ago" / "2 d ago" — compact, because it shares a row with a title. */
export function formatAge(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds)) return "no data";
  const min = Math.floor(ageSeconds / 60);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Time first, date appended only when the reading isn't from today. */
export function formatLastUpdate(date: Date): string {
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  const timeStr = date.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (isToday) return timeStr;
  const dateStr = date.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${timeStr}, ${dateStr}`;
}

export interface Staleness {
  isStale: boolean;
  /** The age caption while stale ("12 min ago"); null when fresh. */
  ageLabel: string | null;
}

/**
 * Is the newest reading older than `thresholdSeconds`? Absent ⇒ permanently stale.
 *
 * Checked every second, but the component only re-renders when the ANSWER changes (the stale flag or
 * the minute-grained age label), not on every tick — a dashboard carries a dozen of these.
 */
export function useStaleness(
  measurementTime: Date | number | null | undefined,
  thresholdSeconds: number,
): Staleness {
  const ms =
    measurementTime == null
      ? null
      : typeof measurementTime === "number"
        ? measurementTime
        : measurementTime.getTime();

  const compute = (): Staleness => {
    const age = ms == null ? Infinity : (Date.now() - ms) / 1000;
    const isStale = age > thresholdSeconds;
    return { isStale, ageLabel: isStale ? formatAge(age) : null };
  };

  const [state, setState] = useState<Staleness>(compute);

  useEffect(() => {
    const tick = () =>
      setState((prev) => {
        const next = compute();
        return prev.isStale === next.isStale && prev.ageLabel === next.ageLabel
          ? prev
          : next;
      });
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // `compute` closes over exactly these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, thresholdSeconds]);

  return state;
}

/**
 * The stale marker for a tile's header: clock + age, with the exact last-update time in a portal
 * tooltip (portal, because the tile clips its overflow at the rounded corner).
 */
export function StaleBadge({
  ageLabel,
  measurementTime,
}: {
  ageLabel: string;
  measurementTime?: Date | number | null;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const when =
    measurementTime == null
      ? null
      : typeof measurementTime === "number"
        ? new Date(measurementTime)
        : measurementTime;

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Rough width of the tooltip; keep it on-screen at the right edge.
    const x = Math.min(rect.left, window.innerWidth - 210);
    setTip({ x, y: rect.bottom + 8 });
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={when ? show : undefined}
        onMouseLeave={() => setTip(null)}
        className={`${TILE_CAPTION} inline-flex shrink-0 items-center gap-1 whitespace-nowrap ${
          when ? "cursor-help" : ""
        }`}
      >
        <Clock className="h-3 w-3" aria-hidden />
        {/* The age waits for room: in a narrow tile it would push the title into truncation, and
            the clock alone still says "stale" (the exact time is on hover). */}
        <span className="hidden @[200px]:inline">{ageLabel}</span>
      </span>
      {tip &&
        when &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] whitespace-nowrap rounded-xl bg-surface-raised px-3 py-2 text-xs text-ink shadow-xl"
            style={{ left: tip.x, top: tip.y }}
          >
            Last update: {formatLastUpdate(when)}
          </div>,
          document.body,
        )}
    </>
  );
}
