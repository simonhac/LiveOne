"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { classifyUnit } from "@/lib/point/unit-typography";
import { useQuery } from "@tanstack/react-query";
import { HttpError } from "@/lib/queries";
import { format } from "date-fns";
import {
  now,
  toCalendarDate,
  type ZonedDateTime,
} from "@internationalized/date";
import { encodeI18nToUrlSafeString } from "@/lib/url-date";
import { HEATMAP_PALETTES, HeatmapPaletteKey } from "@/lib/heatmap-colors";
import { useContainerSize } from "@/lib/charts/svg";
import {
  bucketHeatmap,
  daysOffFrame,
  formatUtcOffset,
  resolveFrameOffsetMin,
} from "@/lib/heatmap-buckets";
import {
  BLACK_SENTINEL,
  POWER_BASELINE_W,
  heatmapDomain,
  isBaselinePower,
  normalizeHeatmapValue,
} from "@/lib/heatmap-scale";
import ServerErrorModal from "./ServerErrorModal";
import { formatTime, formatDate } from "@/lib/fe-date-format";
import { PointInfo } from "@/lib/point/point-info";

/**
 * Layout for the day × time-of-day grid.
 *
 * `left` fits the widest day label ("Jun Wed 10*"); `bottom` fits the rotated time labels. Fixed
 * rather than measured, because a grid that reflowed as the month prefix appeared and disappeared
 * would shift every cell.
 */
const MARGIN = { top: 6, right: 12, bottom: 46, left: 96 };

/**
 * The chart's fixed overall height. Exported because it is the ONE number every heatmap placeholder
 * has to agree with: the panel's status blocks (`HeatmapPanel`), the card plugin's declared footprint
 * (`dashboard/cards/footprints.ts`), and the spinner below. They used to be 384 / 360 / 600
 * respectively, so a heatmap card resized twice on its way in.
 */
export const HEATMAP_CHART_H = 600;

/** The cell grid, derived so the svg totals exactly {@link HEATMAP_CHART_H} — never a second literal. */
const GRID_HEIGHT = HEATMAP_CHART_H - MARGIN.top - MARGIN.bottom;
const TICK_TEXT = "rgb(156, 163, 175)"; // gray-400
const FONT_FAMILY = "DM Sans, system-ui, sans-serif";
/** Missing readings — distinct from the black baseline, which means "on but idle". */
const NO_DATA_FILL = "rgba(55, 65, 81, 0.3)";
/** gray-900, the page background: a load/source power cell at or below standby reads as nothing. */
const BASELINE_FILL = "#111827";

interface HeatmapChartProps {
  systemId: number;
  pointPath: string;
  pointUnit: string;
  metricType: string;
  /** IANA display zone — used ONLY to work out which days were on a different real offset. */
  timezone: string;
  /**
   * `areas.day_offset_min` — the FALLBACK frame, used only when `timezone` is unusable. The grid is
   * normally bucketed in the newest day's real offset; see `resolveFrameOffsetMin` and the rationale
   * in lib/heatmap-buckets.ts for why the frame rolls rather than sitting on standard time.
   */
  dayOffsetMin: number;
  palette: HeatmapPaletteKey;
  className?: string;
  onFetchInfo?: (info: {
    interval: string;
    duration: string;
    startTime: ZonedDateTime | null;
    endTime: ZonedDateTime | null;
  }) => void;
}

interface HeatmapDataPoint {
  x: string; // Time of day (HH:mm)
  y: string; // Date (yyyy-MM-dd)
  v: number | null; // Value
}

interface HeatmapData {
  data: HeatmapDataPoint[];
  min: number;
  max: number;
  xLabels: string[]; // Time labels
  yLabels: string[]; // Date labels
  /** The offset the whole grid is bucketed and labelled in. */
  frameOffsetMin: number;
  /** Date keys whose real UTC offset differed from the frame (DST). Asterisked in the axis. */
  offFrameDays: Set<string>;
}

/** Raw fetch result carried in the React Query cache; transformed into `HeatmapData`
 *  in a `useMemo` so the derived arrays stay referentially stable across refetches. */
interface HeatmapFetchResult {
  result: any;
  fetchStartTime: ZonedDateTime;
  fetchEndTime: ZonedDateTime;
}

/** Thrown when the API replies with an HTML page (e.g. an expired session), so the
 *  caller can surface the "connection" modal instead of a generic server error. */
class HeatmapHtmlError extends Error {
  constructor() {
    super("Session may have expired. Please refresh the page.");
    this.name = "HeatmapHtmlError";
  }
}

export default function HeatmapChart({
  systemId,
  pointPath,
  pointUnit,
  metricType,
  timezone,
  dayOffsetMin,
  palette,
  className = "",
  onFetchInfo,
}: HeatmapChartProps) {
  const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
  const [errorType, setErrorType] = useState<"connection" | "server" | null>(
    null,
  );
  const [errorDetails, setErrorDetails] = useState<string | undefined>(
    undefined,
  );
  const [containerRef, size] = useContainerSize<HTMLDivElement>();
  const width = size.width;
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const isBaselinePowerSeries = isBaselinePower(pointPath);

  // Fetch 30 days of half-hourly data for the selected point. The query carries the raw
  // payload + the computed range; the heatmap grid is derived in a useMemo below so the
  // arrays stay referentially stable across refetches.
  const {
    data: fetchResult,
    isPending,
    isError,
    error: queryError,
  } = useQuery<HeatmapFetchResult>({
    queryKey: ["system", systemId, "heatmap", pointPath, timezone],
    queryFn: async () => {
      // Calculate date range using @internationalized/date
      // End: midnight tomorrow (00:00 tomorrow in AEST)
      const nowAEST = now(timezone);
      const tomorrowDate = toCalendarDate(nowAEST).add({ days: 1 });
      const fetchEndTime = nowAEST.set({
        year: tomorrowDate.year,
        month: tomorrowDate.month,
        day: tomorrowDate.day,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      });

      // Start: 30 days before end, plus 30 minutes
      const fetchStartTime = fetchEndTime
        .subtract({ days: 30 })
        .add({ minutes: 30 });

      // Encode times as URL-safe strings (with embedded timezone)
      const startTimeEncoded = encodeI18nToUrlSafeString(fetchStartTime, true);
      const endTimeEncoded = encodeI18nToUrlSafeString(fetchEndTime, true);

      // Fetch 30 days of data at 30-minute intervals
      // Use preferred aggregation based on metric type (energy: delta, soc: last, others: avg)
      const seriesSuffix =
        PointInfo.getPreferredAggregationForMetricType(metricType);
      const url = `/api/history?interval=30m&startTime=${startTimeEncoded}&endTime=${endTimeEncoded}&systemId=${systemId}&series=${pointPath}.${seriesSuffix}`;
      const response = await fetch(url, {
        credentials: "same-origin",
      });

      if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("text/html")) {
          throw new HeatmapHtmlError();
        }
        throw new HttpError(response.status, response.statusText);
      }

      const result = await response.json();
      return { result, fetchStartTime, fetchEndTime };
    },
    staleTime: 60_000,
    enabled: !!systemId,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Send fetch info to parent whenever a new range is fetched.
  useEffect(() => {
    if (fetchResult && onFetchInfo) {
      onFetchInfo({
        interval: "30m",
        duration: "30d",
        startTime: fetchResult.fetchStartTime,
        endTime: fetchResult.fetchEndTime,
      });
    }
    // onFetchInfo is a stable setter from the parent; depend on the fetched range only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchResult]);

  // Transform the raw payload into the heatmap grid. Returns null if the series/history
  // is missing (surfaced as a "No data found for this point" error below).
  const heatmapData = useMemo<HeatmapData | null>(() => {
    if (!fetchResult) return null;
    const { result } = fetchResult;

    // Find the series for the requested point.
    // Use .delta for energy metrics, .avg for others (same as request).
    const seriesSuffix =
      PointInfo.getPreferredAggregationForMetricType(metricType);
    const expectedSeriesPath = `${pointPath}.${seriesSuffix}`;
    const series = result.data?.find((s: any) => {
      const seriesPath = s.path || s.id?.split(".").slice(2).join(".");
      return seriesPath === expectedSeriesPath;
    });

    if (!series || !series.history) {
      console.error("[HeatmapChart] No series/history for", expectedSeriesPath);
      return null;
    }

    const { firstInterval, interval, data } = series.history;
    const intervalMs = parseInterval(interval);
    if (intervalMs === null || intervalMs <= 0) {
      console.error(
        "[HeatmapChart] Unrecognised interval from /api/history:",
        interval,
      );
      return null; // surfaces as the "No data found for this point" error path
    }

    // ONE offset for the whole grid, so every day is exactly 48 slots and the DST hour-loss /
    // phantom-gap defects cannot occur. The frame follows the NEWEST day's real offset rather than
    // standard time — with standard time every row of a midsummer window is off-frame, which makes
    // the asterisk meaningless. Measured and unit-tested in lib/heatmap-buckets.ts.
    const firstIntervalEndMs = new Date(firstInterval).getTime();
    const values = data as (number | null)[];
    const lastReadingMs =
      firstIntervalEndMs + Math.max(0, values.length - 1) * intervalMs;
    const frameOffsetMin = resolveFrameOffsetMin(
      lastReadingMs,
      timezone,
      dayOffsetMin, // fallback if display_timezone is unusable
    );

    const bucketed = bucketHeatmap(values, {
      firstIntervalEndMs,
      intervalMs,
      frameOffsetMin,
    });

    return {
      data: bucketed.cells,
      min: bucketed.min,
      max: bucketed.max,
      xLabels: bucketed.timeLabels,
      yLabels: bucketed.dayKeys,
      frameOffsetMin,
      // Rows the frame does not describe: the site was on a different real offset that day, so its
      // columns read an hour out. Marked with an asterisk + footnote rather than silently shown.
      offFrameDays: daysOffFrame(bucketed.dayKeys, timezone, frameOffsetMin),
    };
  }, [fetchResult, pointPath, metricType, timezone, dayOffsetMin]);

  // Initial-load spinner vs. refetch overlay (preserves the original `loading` gate).
  // A successful fetch whose series is missing is an error state, not still-loading.
  const loading = isPending;

  // Derived error string for the inline error UI.
  const error =
    isError && !(queryError instanceof HeatmapHtmlError)
      ? queryError instanceof Error
        ? queryError.message
        : "Unknown error"
      : fetchResult && !heatmapData
        ? "No data found for this point"
        : null;

  // Map query/transform failures onto the error modal (connection vs. server),
  // matching the original try/catch behaviour.
  useEffect(() => {
    if (isError) {
      if (queryError instanceof HeatmapHtmlError) {
        setIsErrorModalOpen(true);
        setErrorType("connection");
        setErrorDetails(queryError.message);
      } else {
        console.error("Error fetching heatmap data:", queryError);
        const msg =
          queryError instanceof Error ? queryError.message : "Unknown error";
        setIsErrorModalOpen(true);
        setErrorType("server");
        setErrorDetails(msg);
      }
    } else if (fetchResult && !heatmapData) {
      // Fetched OK but the requested series/history was absent.
      const msg = "No data found for this point";
      console.error("Error fetching heatmap data:", msg);
      setIsErrorModalOpen(true);
      setErrorType("server");
      setErrorDetails(msg);
    }
  }, [isError, queryError, fetchResult, heatmapData]);
  /**
   * Parse an interval string ("30m") to milliseconds, or `null` if it is not one.
   *
   * Returning `null` rather than `0` matters: with `intervalMs = 0` every reading mapped to the same
   * instant, so the entire heatmap silently collapsed into a single column and looked like a data
   * problem rather than a parsing one. The caller turns `null` into the ordinary "no data" error
   * path, which is visible.
   */
  function parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)([smhd])$/);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------------

  /**
   * The colour domain — fixed for metrics that have one by definition (SoC is 0–100 %), observed
   * otherwise. Computed ONCE and used by both the cells and the legend, so the legend cannot claim a
   * range the grid does not use. That divergence was defect #11.
   */
  const domain = heatmapData
    ? heatmapDomain(metricType, heatmapData.min, heatmapData.max)
    : null;

  const cellColour = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return NO_DATA_FILL;
    const n = normalizeHeatmapValue(v, domain!.min, domain!.max, {
      baselinePower: isBaselinePowerSeries,
    });
    if (n === BLACK_SENTINEL) return BASELINE_FILL;
    return HEATMAP_PALETTES[palette].fn(n);
  };

  /**
   * The legend ramp.
   *
   * Truthful since Stage 3e: normalisation spans the real `min..max`, so `getColor(0)`→`getColor(1)`
   * genuinely is what the cells use. For a load/source power series the ramp additionally carries the
   * black standby floor at its left, in proportion to where 50 W falls in the range — otherwise the
   * legend would claim colour for values the grid paints black.
   */
  const legendGradient = useMemo(() => {
    if (!heatmapData) return "none";
    const ramp = (from: number) =>
      [0, 0.25, 0.5, 0.75, 1]
        .map(
          (t) =>
            `${HEATMAP_PALETTES[palette].fn(t)} ${from + (100 - from) * t}%`,
        )
        .join(", ");

    if (!isBaselinePowerSeries) {
      return `linear-gradient(to right, ${ramp(0)})`;
    }
    const d = heatmapDomain(metricType, heatmapData.min, heatmapData.max);
    const span = d.max - d.min;
    const pct =
      span > 0
        ? Math.min(100, Math.max(0, ((POWER_BASELINE_W - d.min) / span) * 100))
        : 100;
    if (pct >= 100) return BASELINE_FILL; // the whole series sits at or below standby
    if (pct <= 0) return `linear-gradient(to right, ${ramp(0)})`;
    return `linear-gradient(to right, ${BASELINE_FILL} 0%, ${BASELINE_FILL} ${pct}%, ${ramp(pct)})`;
  }, [heatmapData, palette, isBaselinePowerSeries, metricType]);

  /** Value + unit for the tooltip, applying the same conversions the legend uses. */
  const formatValue = (v: number | null): { value: string; unit: string } => {
    if (v == null) return { value: "No data", unit: "" };
    if (metricType === "energy") {
      return { value: (v / 1000).toFixed(1), unit: pointUnit.replace("Wh", "kWh") };
    }
    if (metricType === "power") return { value: (v / 1000).toFixed(1), unit: "kW" };
    return { value: v.toFixed(2), unit: pointUnit };
  };

  const axisUnit =
    metricType === "energy"
      ? pointUnit.replace("Wh", "kWh")
      : metricType === "power"
        ? "kW"
        : pointUnit;
  const axisScale = metricType === "energy" || metricType === "power" ? 1000 : 1;
  // A FIXED domain's bounds are exact by definition — "0%"/"100%", not "0.00%"/"100.00%". Only an
  // observed range needs decimals, because there the number is a measurement.
  const axisDecimals = domain?.fixed
    ? 0
    : metricType === "energy" || metricType === "power"
      ? 1
      : 2;

  if (loading && !heatmapData) {
    return (
      <div className={className}>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <div
            className="flex items-center justify-center"
            style={{ height: HEATMAP_CHART_H }}
          >
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-red-400">Error: {error}</div>
        <ServerErrorModal
          isOpen={isErrorModalOpen}
          onClose={() => setIsErrorModalOpen(false)}
          errorType={errorType}
          errorDetails={errorDetails}
        />
      </div>
    );
  }

  if (!heatmapData) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-gray-400">No data available</div>
      </div>
    );
  }

  const rows = heatmapData.yLabels.length;
  const cols = heatmapData.xLabels.length;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = GRID_HEIGHT;
  const cellW = plotW / cols;
  const cellH = plotH / rows;
  /**
   * `yLabels` is newest-first, but the grid reads OLDEST at the top — Chart.js's category y-axis put
   * index 0 at the bottom, and reading a month downward is what the chart is for. Flip the row index
   * rather than the data, so tooltip and `offFrameDays` lookups stay index-aligned.
   */
  const rowY = (r: number) => (rows - 1 - r) * cellH;
  const ready = width > 0 && plotW > 0;

  const hovered =
    hover && heatmapData
      ? heatmapData.data[hover.row * cols + hover.col]
      : null;

  return (
    <div className={className}>
      <div className="relative rounded-lg border border-gray-700 bg-gray-900 p-4">
        <div ref={containerRef}>
          {ready && (
            <svg
              width={width}
              height={plotH + MARGIN.top + MARGIN.bottom}
              data-testid="heatmap-chart"
              onPointerLeave={() => setHover(null)}
            >
              <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
                {/* Cells. One <rect> per half hour — 30 x 48 = 1,440, which SVG handles fine. */}
                {heatmapData.yLabels.map((day, r) =>
                  heatmapData.xLabels.map((slot, c) => {
                    const cell = heatmapData.data[r * cols + c];
                    return (
                      <rect
                        key={`${r}-${c}`}
                        x={c * cellW}
                        y={rowY(r)}
                        width={cellW}
                        height={cellH}
                        fill={cellColour(cell?.v)}
                        shapeRendering="crispEdges"
                        onPointerEnter={() => setHover({ row: r, col: c })}
                      />
                    );
                  }),
                )}

                {/* Day labels. The month prefix is bold white so the eye can find where a month
                    starts; the rest is the usual muted grey. An asterisk marks a row whose real
                    UTC offset differed from the frame — see the footnote. */}
                {heatmapData.yLabels.map((day, r) => {
                  const local = new Date(`${day}T00:00:00`);
                  const isFirstChronologically = r === rows - 1;
                  const showMonth = isFirstChronologically || local.getDate() === 1;
                  const mark = heatmapData.offFrameDays.has(day) ? "*" : "";
                  return (
                    <text
                      key={day}
                      x={-8}
                      y={rowY(r) + cellH / 2}
                      dy="0.32em"
                      textAnchor="end"
                      fontSize={10}
                      fontFamily={FONT_FAMILY}
                      data-tick-label
                    >
                      {showMonth && (
                        <tspan fill="#ffffff" fontWeight="bold">
                          {format(local, "MMM")}{" "}
                        </tspan>
                      )}
                      <tspan fill={TICK_TEXT}>
                        {format(local, "EEE d")}
                        {mark}
                      </tspan>
                    </text>
                  );
                })}

                {/* Time-of-day labels, every 2 hours, rotated to read bottom-to-top as before. */}
                {heatmapData.xLabels.map((slot, c) =>
                  c % 4 === 0 ? (
                    <text
                      key={slot}
                      transform={`rotate(-90, ${c * cellW + cellW / 2}, ${plotH + 6})`}
                      x={c * cellW + cellW / 2}
                      y={plotH + 6}
                      textAnchor="end"
                      dy="0.32em"
                      fontSize={10}
                      fontFamily={FONT_FAMILY}
                      fill={TICK_TEXT}
                      data-tick-label
                    >
                      {slot}
                    </text>
                  ) : null,
                )}

                {hover && (
                  <rect
                    x={hover.col * cellW}
                    y={rowY(hover.row)}
                    width={cellW}
                    height={cellH}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={1}
                    pointerEvents="none"
                  />
                )}
              </g>
            </svg>
          )}

          {/* Tooltip. A positioned sibling rather than a body-appended div: the old external
              Chart.js tooltip had to create, measure, place and clean up a raw #chartjs-tooltip
              node by hand, and hide it again on refetch and unmount. */}
          {hovered && hover && (
            <div
              className="pointer-events-none absolute z-20 rounded-md border border-gray-600 bg-gray-900 p-3 text-xs shadow-lg"
              style={{
                left: Math.min(
                  MARGIN.left + hover.col * cellW + cellW + 10,
                  Math.max(0, width - 190),
                ),
                top: MARGIN.top + rowY(hover.row) + cellH + 10,
              }}
            >
              <div className="mb-1 font-bold text-white">
                {formatTime(new Date(`${hovered.y}T${hovered.x}:00`), false)},{" "}
                {formatDate(new Date(`${hovered.y}T${hovered.x}:00`))}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 flex-shrink-0 rounded-sm border border-white/20"
                  style={{ backgroundColor: cellColour(hovered.v) }}
                />
                <span className="text-white">
                  {(() => {
                    const { value, unit } = formatValue(hovered.v);
                    if (!unit) return value;
                    const gap = classifyUnit(unit).headGap === "hair" ? "\u200a" : "";
                    return `${value}${gap}${unit}`;
                  })()}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Colour legend. Truthful since Stage 3e: the ramp spans the real min..max. */}
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="text-xs text-gray-400">
            {(domain!.min / axisScale).toFixed(axisDecimals)}
            {axisUnit}
          </span>
          <div
            className="h-4 rounded"
            style={{ width: 200, background: legendGradient }}
          />
          <span className="text-xs text-gray-400">
            {(domain!.max / axisScale).toFixed(axisDecimals)}
            {axisUnit}
          </span>
        </div>

        {heatmapData.offFrameDays.size > 0 && (
          <p className="mt-2 text-center text-[11px] text-gray-500">
            Times are {formatUtcOffset(heatmapData.frameOffsetMin)} for every day,
            so a routine lines up across the whole chart.{" "}
            <span className="text-gray-400">*</span> marks days the site was on a
            different offset (daylight saving) — the local clock read an hour later
            than the column says.
          </p>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center rounded bg-gray-900/80">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          </div>
        )}
      </div>

      <ServerErrorModal
        isOpen={isErrorModalOpen}
        onClose={() => setIsErrorModalOpen(false)}
        errorType={errorType}
        errorDetails={errorDetails}
      />
    </div>
  );
}
