"use client";

/**
 * Observations ingested per minute, last 24h — the `/admin/observations` ops chart.
 *
 * First slice of the Chart.js → d3 port (docs/plans/chart-library-consolidation.md, Stage 5). It is
 * also the one chart deliberately **simplified rather than reproduced**: it was the only place in the
 * repo using Chart.js's built-in legend and tooltip, and rebuilding those faithfully would have meant
 * generalising legend/tooltip components for a single admin consumer. Two static swatches and a hover
 * readout do the job.
 *
 * ## Areas, not bars
 *
 * The source is 1,441 one-minute buckets. As bars across ~850 px that is 0.6 px each — 2,882
 * sub-pixel `<rect>`s that moiré and read worse than the canvas did. Drawn as stacked areas with a
 * **step-after** curve it is two `<path>`s, looks like touching bars, and is honest: a per-minute
 * count holds for its minute, so a sloped line would assert readings between samples that were never
 * taken.
 */
import { useMemo, useState } from "react";
import { Database } from "lucide-react";
import {
  FocusLine,
  TimeAxis,
  ValueAxis,
  buildGeometry,
  buildTimeTicks,
  nearestIndexForTime,
  niceDomain,
  stackedBands,
  useContainerSize,
} from "@/lib/charts/svg";

const RAW_COLOR = "rgba(56, 189, 248, 0.75)"; // sky-400
const AGG_COLOR = "rgba(167, 139, 250, 0.75)"; // violet-400

export interface IngestionSeries {
  /** Minute-aligned instants, ascending and contiguous. */
  timestamps: Date[];
  raw: number[];
  agg: number[];
}

/** Legend entries, in stacking order (bottom first) — the pair the chart draws. */
const SERIES = [
  { key: "raw", label: "Raw", colour: RAW_COLOR },
  { key: "agg", label: "5-min agg", colour: AGG_COLOR },
] as const;

function Readout({
  series,
  index,
}: {
  series: IngestionSeries;
  index: number;
}) {
  const at = series.timestamps[index];
  return (
    <span className="tabular-nums text-gray-300">
      {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ·{" "}
      {series.raw[index]} raw · {series.agg[index]} agg
    </span>
  );
}

export default function IngestionChart({
  series,
  loading,
  configured,
}: {
  series: IngestionSeries | null;
  loading: boolean;
  configured?: boolean;
}) {
  const [ref, size] = useContainerSize<HTMLDivElement>();
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (!series || series.timestamps.length === 0 || size.width === 0) {
      return null;
    }
    // The stack total sets the ceiling — sizing to either series alone clips the taller column.
    const totals = series.timestamps.map(
      (_, i) => series.raw[i] + series.agg[i],
    );
    return buildGeometry({
      width: size.width,
      height: size.height,
      xDomain: [
        series.timestamps[0],
        series.timestamps[series.timestamps.length - 1],
      ],
      yDomain: niceDomain(totals),
      margin: { left: 52, right: 12 },
    });
  }, [series, size.width, size.height]);

  const focusAt =
    series && focusIndex != null ? series.timestamps[focusIndex] : null;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Database className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-medium text-gray-200">
          Observations ingested per minute · last 24h
        </h2>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: s.colour }}
                aria-hidden
              />
              <span className="text-gray-400">{s.label}</span>
            </span>
          ))}
          {series && focusIndex != null && (
            <Readout series={series} index={focusIndex} />
          )}
        </div>
      </div>

      <div ref={ref} className="h-[360px]">
        {series && geo && !geo.empty ? (
          <svg
            width={size.width}
            height={size.height}
            data-testid="ingestion-chart"
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - rect.left - geo.plot.left;
              setFocusIndex(
                nearestIndexForTime(
                  series.timestamps,
                  geo.x.invert(px).getTime(),
                ),
              );
            }}
            onPointerLeave={() => setFocusIndex(null)}
          >
            <g transform={`translate(${geo.plot.left}, ${geo.plot.top})`}>
              <TimeAxis
                ticks={buildTimeTicks(
                  "D",
                  series.timestamps[0],
                  series.timestamps[series.timestamps.length - 1],
                )}
                x={geo.x}
                plotHeight={geo.plot.height}
              />
              <ValueAxis
                scale={geo.y}
                plotWidth={geo.plot.width}
                side="left"
                unit="/min"
              />
              {stackedBands(
                series.timestamps,
                [
                  { key: "raw", values: series.raw },
                  { key: "agg", values: series.agg },
                ],
                geo.x,
                geo.y,
                "stepAfter",
              ).map(
                (band, i) =>
                  band.d && (
                    <path
                      key={band.key}
                      d={band.d}
                      fill={SERIES[i].colour}
                      stroke="none"
                      data-series={band.key}
                    />
                  ),
              )}
              <FocusLine at={focusAt} x={geo.x} plotHeight={geo.plot.height} />
            </g>
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            {loading
              ? "Loading…"
              : configured === false
                ? "Postgres not connected yet."
                : "No observations ingested in the last 24 hours."}
          </div>
        )}
      </div>
    </div>
  );
}
