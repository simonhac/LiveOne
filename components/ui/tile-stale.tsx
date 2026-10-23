"use client";

/**
 * Staleness for tiles — one implementation for the four shells that used to each carry their own
 * copy (Tile, StatCardShell, GridSignalsCard, and the formatter all three duplicated).
 *
 * "Stale is quiet" (docs/architecture/tile-style.md, rule 10): no diagonal hatch, no dimmed box. A
 * stale tile's VALUES fall to `TILE_STALE`, and a slowly pulsing clock sits in the header, with the
 * reading's age and exact time on hover.
 */
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { TILE_CAPTION } from "@/lib/tile-style";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * "just now" / "4 min ago" / "3 h ago" / "2 d ago" — compact, because it shares a row with a title.
 * The spaces are NO-BREAK (U+00A0): an age must never wrap mid-phrase ("20 min" / "ago").
 */
export function formatAge(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds)) return "no\u00A0data";
  const min = Math.floor(ageSeconds / 60);
  if (min < 1) return "just\u00A0now";
  if (min < 60) return `${min}\u00A0min\u00A0ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}\u00A0h\u00A0ago`;
  return `${Math.floor(h / 24)}\u00A0d\u00A0ago`;
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
 * The stale marker for a tile's header: a slowly pulsing clock, with the age and the exact
 * last-update time in a tooltip. The age itself is not printed — beside the title it crowded the
 * tile's name into truncation, and the pulse alone says "stale".
 */
export function StaleBadge({
  ageLabel,
  measurementTime,
}: {
  ageLabel: string;
  measurementTime?: Date | number | null;
}) {
  const when =
    measurementTime == null
      ? null
      : typeof measurementTime === "number"
        ? new Date(measurementTime)
        : measurementTime;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Stale: last update ${ageLabel}`}
          className={`${TILE_CAPTION} inline-flex shrink-0 cursor-help items-center`}
        >
          <Clock className="stale-clock-pulse h-3 w-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {when ? (
          <>
            Last update: {formatLastUpdate(when)}{" "}
            <span className="text-ink-muted">({ageLabel})</span>
          </>
        ) : (
          "No data"
        )}
      </TooltipContent>
    </Tooltip>
  );
}
