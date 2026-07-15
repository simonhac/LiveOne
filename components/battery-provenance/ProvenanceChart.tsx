"use client";

import { useRef } from "react";
import { Line } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import {
  registerChartScaffold,
  buildTimeScale,
  type ChartTimeRange,
} from "@/lib/charts/scaffold";
import type {
  ProvenanceChartDef,
  ProvenanceSeriesDef,
} from "@/lib/battery-provenance/field-registry";

registerChartScaffold();

const FONT = { size: 10, family: "DM Sans, system-ui, sans-serif" };

interface ProvenanceChartProps {
  def: ProvenanceChartDef;
  /** Local-noon Date per day, shared by every chart in the panel. */
  timestamps: Date[];
  /** Windowed values by series id, parallel to `timestamps`. */
  seriesValues: Record<string, (number | null)[]>;
  visibleSeries: Set<string>;
  /** Shared focus instant → red vertical line (same idiom as DashboardChart). */
  hoveredTimestamp: Date | null;
  onHoverIndexChange: (index: number | null) => void;
  timeRange: ChartTimeRange;
  windowStart: Date;
  windowEnd: Date;
  /** Extra annotation boxes (recal bands) appended after the crosshair. */
  bandAnnotations?: object[];
  className?: string;
}

function axisTicks(unit: string) {
  return {
    color: "rgb(156, 163, 175)", // gray-400
    font: FONT,
    callback: function (value: unknown, index: number, ticks: unknown[]) {
      // Unit only on the last (top) tick, like the dashboard charts.
      if (index === ticks.length - 1 && unit) return `${value} ${unit}`;
      return value;
    },
  };
}

function toDataset(
  s: ProvenanceSeriesDef,
  values: (number | null)[],
  isProbeLike: boolean,
) {
  return {
    label: s.label,
    data: values,
    borderColor: s.color,
    backgroundColor: s.color,
    borderWidth: isProbeLike ? 1 : 1.5,
    borderDash: s.dash ?? [],
    // Applied params hold their value for the whole day → step-after.
    stepped: s.stepped ? ("after" as const) : false,
    // Honest gaps: nulls break the line; small points keep isolated days visible.
    spanGaps: false,
    pointRadius: 1.5,
    pointHoverRadius: 3,
    pointBorderWidth: 0,
    yAxisID: s.axis,
    tension: 0,
  };
}

/**
 * One chart of the battery-provenance history panel: a thin N-series `<Line>` over the shared
 * scaffold (time x-axis + crosshair idiom copied from DashboardChart's lines variant), with the
 * per-series styling (colour/dash/step/axis) driven entirely by the field registry. Deliberately
 * NOT a DashboardChart variant — its two variants are hardwired to fixed-field chart data.
 */
export default function ProvenanceChart({
  def,
  timestamps,
  seriesValues,
  visibleSeries,
  hoveredTimestamp,
  onHoverIndexChange,
  timeRange,
  windowStart,
  windowEnd,
  bandAnnotations = [],
  className,
}: ProvenanceChartProps) {
  const chartRef = useRef<unknown>(null);
  // Chart.js's `interaction: {mode:"index"}` re-evaluates the active elements at the last known
  // mouse position on every redraw (not just on real mousemove) — including the redraw THIS hover
  // triggers by changing `hoveredTimestamp`/rebuilding `options`/`datasets` on the next render. Left
  // unguarded that's an infinite loop: hover → onHover → setState → redraw → onHover fires again for
  // the same still-hovered point → setState → … ("Maximum update depth exceeded"). Deduplicating
  // against the last reported index breaks the cycle regardless of why Chart.js re-fires it.
  const lastIndexRef = useRef<number | null>(null);

  const shown = def.series.filter((s) => visibleSeries.has(s.id));
  const datasets = shown.map((s) =>
    toDataset(s, seriesValues[s.id] ?? [], (s.dash?.length ?? 0) > 0),
  );

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: "index" as const,
      intersect: false,
      axis: "x" as const,
    },
    onHover: (_event: unknown, activeElements: Array<{ index: number }>) => {
      const index = activeElements.length > 0 ? activeElements[0].index : null;
      if (index === lastIndexRef.current) return;
      lastIndexRef.current = index;
      onHoverIndexChange(index);
    },
    plugins: {
      legend: { display: false }, // identity lives in the value table
      tooltip: { enabled: false },
      annotation: {
        animation: false,
        annotations: [
          ...bandAnnotations,
          ...(hoveredTimestamp
            ? [
                {
                  type: "line",
                  scaleID: "x",
                  value: hoveredTimestamp.getTime(),
                  borderColor: "rgb(239, 68, 68)",
                  borderWidth: 1,
                  borderDash: [],
                },
              ]
            : []),
        ],
      },
    },
    scales: {
      x: buildTimeScale(timeRange, windowEnd, windowStart),
      y: {
        type: "linear" as const,
        display: true,
        position: "left" as const,
        title: { display: false },
        min: def.y.min,
        max: def.y.max,
        suggestedMin: def.y.suggestedMin,
        suggestedMax: def.y.suggestedMax,
        grid: {
          color: "rgb(55, 65, 81)", // gray-700
          display: true,
          drawOnChartArea: true,
        },
        ticks: axisTicks(def.y.unit),
      },
      ...(def.y1
        ? {
            y1: {
              type: "linear" as const,
              display: true,
              position: "right" as const,
              title: { display: false },
              min: def.y1.min,
              max: def.y1.max,
              suggestedMin: def.y1.suggestedMin,
              suggestedMax: def.y1.suggestedMax,
              grid: {
                display: true,
                drawOnChartArea: false, // avoid overlapping the left-axis grid
              },
              ticks: axisTicks(def.y1.unit),
            },
          }
        : {}),
    },
  };

  return (
    <div className={className}>
      <div className="text-xs text-gray-400 mb-1">{def.title}</div>
      <div
        className="h-44"
        onMouseLeave={() => {
          // Desktop only — on touch, clearing on leave fights tap-to-focus (SiteChartsCard idiom).
          // Bypasses the onHover dedup guard above, so keep it in sync — otherwise re-hovering the
          // SAME point right after leaving would be silently swallowed by that guard.
          if (!("ontouchstart" in window)) {
            lastIndexRef.current = null;
            onHoverIndexChange(null);
          }
        }}
      >
        <Line
          ref={chartRef as never}
          data={{ labels: timestamps, datasets }}
          options={options as never}
        />
      </div>
    </div>
  );
}
