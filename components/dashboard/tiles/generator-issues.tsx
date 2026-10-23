"use client";

/**
 * The generator tile's issues chip — "⚠ 3" in the header, opening the list of what is wrong.
 *
 * It replaced a bare red "!" that said only "something, somewhere" (and, the day it mattered, was a
 * month-old error unrelated to the outage in progress). A count plus a word per issue, never colour
 * alone; the list itself says what, since when, and the evidence.
 *
 * Portal-rendered for the same reason as `StaleBadge`: the tile clips its overflow at the rounded
 * corner, with a beak matching the shared Tooltip's. Hover opens it on a pointer device, a tap toggles it everywhere, Escape or a tap outside
 * closes it.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CircleAlert } from "lucide-react";
import type { GeneratorIssue } from "@/lib/control/generator-health";

const PANEL_WIDTH = 300;

export default function GeneratorIssuesChip({
  issues,
}: {
  issues: GeneratorIssue[];
}) {
  // `beakX`: the chip's centre, relative to the panel's left edge.
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    beakX: number;
  } | null>(null);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(
      8,
      Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8),
    );
    setPos({ x, y: rect.bottom + 8, beakX: rect.left + rect.width / 2 - x });
  };

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setPos(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setPinned(false);
      setPos(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [pinned]);

  if (issues.length === 0) return null;
  const critical = issues.some((i) => i.severity === "critical");
  const label = `${issues.length} generator issue${issues.length === 1 ? "" : "s"}: ${issues
    .map((i) => i.title)
    .join("; ")}`;

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={pos != null}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setPos(null);
          } else {
            setPinned(true);
            place();
          }
        }}
        onMouseEnter={() => !pinned && place()}
        onMouseLeave={() => !pinned && setPos(null)}
        // TILE_CHIP's height, rounding and wash, but a pill rather than a circle: it carries a count.
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-wash px-2 text-[13px] font-bold ${
          critical ? "text-danger" : "text-tile-ink-soft"
        }`}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        {issues.length}
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Generator issues"
            className="fixed z-[9999] space-y-3 rounded-xl p-3 text-xs text-ink bg-surface-glass shadow-xl ring-1 ring-wash ring-inset backdrop-blur-lg backdrop-saturate-150"
            style={{ left: pos.x, top: pos.y, width: PANEL_WIDTH }}
          >
            {/* The beak — same shape and size as the shared Tooltip's (components/ui/tooltip.tsx). */}
            <svg
              aria-hidden
              width={12}
              height={6}
              viewBox="0 0 30 10"
              preserveAspectRatio="none"
              className="absolute -top-1.5 rotate-180 fill-surface-glass"
              style={{ left: pos.beakX - 6 }}
            >
              <polygon points="0,0 30,0 15,10" />
            </svg>
            {issues.map((issue) => (
              <div key={issue.code + issue.title} className="flex gap-2">
                {issue.severity === "critical" ? (
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
                    aria-label="Critical"
                  />
                ) : (
                  <CircleAlert
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-tile-ink-soft"
                    aria-label="Warning"
                  />
                )}
                <div className="min-w-0">
                  <p className="font-semibold">{issue.title}</p>
                  {issue.detail && (
                    <p className="mt-0.5 text-tile-ink-soft">{issue.detail}</p>
                  )}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
