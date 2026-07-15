"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BOOKKEEPING_ROWS,
  PROVENANCE_CHARTS,
  type ProvenanceDailyResponse,
  type ProvenanceSeriesDef,
} from "@/lib/battery-provenance/field-registry";

const TOOLTIP_WIDTH = 320;

/**
 * A table-row label that pops a rich description tooltip on hover — the createPortal
 * fixed-position idiom from BatteryContentsCard, widened for multi-line text. Deliberately carries
 * NO native `title` of its own — a `title` on an ancestor would fire simultaneously with this
 * portal tooltip on the same hover, and the two visually collide (dueling tooltips).
 */
function LabelWithTooltip({
  label,
  unit,
  description,
  onClick,
}: {
  label: string;
  unit?: string;
  description: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let x = rect.left;
    const y = rect.bottom + 8;
    if (x + TOOLTIP_WIDTH > window.innerWidth) {
      x = window.innerWidth - TOOLTIP_WIDTH - 10;
    }
    setPos({ x, y });
  };

  return (
    <>
      <span
        ref={ref}
        className={`text-gray-300 cursor-help ${onClick ? "cursor-pointer" : ""}`}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        onClick={onClick}
      >
        {label}
      </span>
      {pos !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[9999] max-w-xs whitespace-normal rounded-lg border border-gray-700 bg-black px-3 py-2 text-xs text-white shadow-xl pointer-events-none"
            style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
          >
            <div className="font-medium mb-1">
              {label}
              {unit ? <span className="text-gray-400"> ({unit})</span> : null}
            </div>
            <div className="text-gray-300">{description}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ProvenanceValueTableProps {
  /** The windowed response-shaped view the panel built (days/fields/rowMeta all parallel). */
  view: ProvenanceDailyResponse;
  /** Values by series id, parallel to view.days. */
  seriesValues: Record<string, (number | null)[]>;
  /** Focused day index, or null → show the resting index. */
  hoveredIndex: number | null;
  /** Resting index when not hovering (the last day with any data). */
  defaultIndex: number;
  visibleByChart: Record<string, Set<string>>;
  onSeriesToggle: (
    chartId: string,
    seriesId: string,
    shiftKey: boolean,
  ) => void;
}

function formatValue(s: ProvenanceSeriesDef, v: number | null): string {
  if (v == null) return "—";
  return v.toFixed(s.decimals);
}

/**
 * The panel's single value table: one group per chart (matching order), a swatch+label+value+unit
 * row per series, and the bookkeeping rows underneath. Values track the shared hover crosshair,
 * reverting to the latest day; label hover explains the variable's role in the algorithm.
 */
export default function ProvenanceValueTable({
  view,
  seriesValues,
  hoveredIndex,
  defaultIndex,
  visibleByChart,
  onSeriesToggle,
}: ProvenanceValueTableProps) {
  const idx = hoveredIndex ?? defaultIndex;
  const day = view.days[idx];

  return (
    <div className="text-xs">
      {/* Focused day */}
      <div className="flex items-center border-b border-gray-700 pb-1 mb-2">
        <div className="flex-1 text-gray-400">
          {hoveredIndex !== null ? "Day" : "Latest"}
        </div>
        <div className="text-gray-100 font-mono">{day ?? "—"}</div>
      </div>

      {PROVENANCE_CHARTS.map((chart) => {
        const visible = visibleByChart[chart.id] ?? new Set<string>();
        return (
          <div key={chart.id} className="mb-3">
            <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">
              {chart.title}
            </div>
            <div className="space-y-0.5">
              {chart.series.map((s) => {
                const isVisible = visible.has(s.id);
                return (
                  <div key={s.id} className="flex items-center">
                    <div className="flex items-center gap-2 flex-1 select-none">
                      <div
                        className="w-3 h-3 rounded-sm flex-shrink-0 border-2 cursor-pointer"
                        onClick={(e) =>
                          onSeriesToggle(chart.id, s.id, e.shiftKey)
                        }
                        title="Click to toggle visibility, shift-click to show only this series"
                        style={{
                          backgroundColor: isVisible ? s.color : "transparent",
                          borderColor: s.color,
                        }}
                      />
                      <LabelWithTooltip
                        label={s.label}
                        unit={s.unit || undefined}
                        description={s.description}
                        onClick={(e) =>
                          onSeriesToggle(chart.id, s.id, e.shiftKey)
                        }
                      />
                    </div>
                    <span className="text-gray-100 font-mono w-16 text-right">
                      {formatValue(s, seriesValues[s.id]?.[idx] ?? null)}
                    </span>
                    <span className="text-gray-500 w-12 text-right">
                      {s.unit}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Bookkeeping — table-only rows */}
      <div className="border-t border-gray-700 pt-2">
        <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">
          Row
        </div>
        <div className="space-y-0.5">
          {BOOKKEEPING_ROWS.map((r) => (
            <div key={r.id} className="flex items-center">
              <div className="flex items-center gap-2 flex-1">
                <div className="w-3 flex-shrink-0" />
                <LabelWithTooltip label={r.label} description={r.description} />
              </div>
              <span className="text-gray-100 font-mono text-right">
                {r.value(view, idx) ?? "—"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
