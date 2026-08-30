"use client";

import { useMemo, useRef } from "react";
import { CHART_COLORS } from "@/lib/chart-colors";
import { SeriesData } from "@/lib/charts/types";
import { calculateSeriesEnergy } from "@/lib/energy-calculator";
import {
  reduceLoadProvenance,
  reduceSourceProvenance,
  type DailyFlowMatrices,
} from "@/lib/energy-flow-matrix";
import {
  formatCentsPerKwh,
  formatDollars,
  formatGramsPerKwh,
  formatKgCo2,
} from "@/lib/provenance-format";
import { ShimmerBar } from "@/components/ui/skeleton";
import { formatPercent } from "@/lib/point/format-value";

/**
 * What the table's last column shows. `pct` is each row's share of the total (the original, and the
 * only one derivable from the chart alone); the rest are reductions of the ATTRIBUTED flow matrix —
 * the same numbers the Sankey node tooltips show, via the same reducers and formatters.
 *
 * The user cycles them by clicking anywhere in that column. `ENERGY_TABLE_METRICS` is the cycle order.
 */
export type EnergyTableMetric = "pct" | "cost" | "rate" | "emissions" | "ei";

export const ENERGY_TABLE_METRICS: readonly EnergyTableMetric[] = [
  "pct",
  "cost",
  "rate",
  "emissions",
  "ei",
];

/** Column heading per metric — also the width driver, so keep them short. */
const METRIC_HEADER: Record<EnergyTableMetric, string> = {
  pct: "%",
  cost: "$",
  rate: "¢/kWh",
  emissions: "kg",
  ei: "g/kWh",
};

/** The subset both `LoadProvenanceSummary` and `SourceProvenanceSummary` carry, which is all this
 *  table reads — so one code path serves the load and generation halves. */
type ProvenanceRow = {
  energyKwh: number;
  costC: number; // signed cents
  avgCentsPerKwh: number | null;
  kgCo2: number;
  avgGramsPerKwh: number | null;
  costKnownKwh: number;
  emissionsKnownKwh: number;
  /** Feed-in credit, POSITIVE = money in; null = nothing sold or nothing priced (never an earned $0). */
  revenueC: number | null;
  revenueKnownKwh: number;
};

/**
 * How much of a row's energy must carry a price before its window total is quotable. The reducers sum
 * whatever is priced, so a partially-materialised window otherwise returns a confident, far-too-small
 * figure — the workspace that built the revenue leg saw "$0.08" against 54.8 kWh exported. Below this,
 * the money line renders "—".
 *
 * Deliberately NOT applied to the last column: those per-row cost/rate cells are specified as averages
 * over KNOWN energy (see the Total-row comment below, which re-divides by the filtered denominators for
 * exactly that reason). This guard is for the headline line, where an unqualified dollar figure that
 * silently covers only part of the window is a lie rather than an average.
 */
const MONEY_COVERAGE_MIN = 0.995;

/** `cents` if the row is priced end-to-end, else null (→ "—"). See {@link MONEY_COVERAGE_MIN}. */
export function quotableCents(
  cents: number | null,
  knownKwh: number,
  energyKwh: number,
): number | null {
  if (cents === null || energyKwh <= 0) return null;
  return knownKwh >= energyKwh * MONEY_COVERAGE_MIN ? cents : null;
}

export function nextEnergyTableMetric(m: EnergyTableMetric): EnergyTableMetric {
  const i = ENERGY_TABLE_METRICS.indexOf(m);
  return ENERGY_TABLE_METRICS[(i + 1) % ENERGY_TABLE_METRICS.length];
}

interface EnergyTableProps {
  chartData: {
    timestamps: Date[];
    series: SeriesData[];
    mode: "power" | "energy";
  } | null;
  /**
   * The parent's history query is in flight (and its mirror of that fetch hasn't landed yet), so an
   * absent `chartData` means "not here YET" rather than "not here". Drives the shimmering
   * placeholder; without it the table can't tell the two apart and flashes "No data" on every cold
   * load.
   */
  isLoading?: boolean;
  mode: "load" | "generation";
  hoveredIndex?: number | null; // Index of the hovered data point
  className?: string;
  visibleSeries?: Set<string>; // Which series are visible
  onSeriesToggle?: (seriesId: string, shiftKey: boolean) => void; // Handle series visibility toggle
  /** The attributed flow matrix for the SAME window the chart covers — the source for the cost /
   *  rate / emissions / intensity metrics. Absent (legacy payload, no provenance inputs) → those
   *  metrics render "—"; the column still cycles. */
  attributedFlow?: DailyFlowMatrices | null;
  /** Which metric the last column currently shows. Owned by the parent so the load and generation
   *  tables cycle together. */
  metric?: EnergyTableMetric;
  /** Advance to the next metric — bound to a click anywhere in the last column. */
  onCycleMetric?: () => void;
  /**
   * This half's grid price series (c/kWh, aligned to `chartData.timestamps`) — the BUY price for the
   * generation table, the SELL price for the load table. Shown on the money line while hovering, in
   * place of the window total. Absent/all-null ⇒ the line shows "—" on hover.
   *
   * ⚠️ Carries the VENDOR's sign: Amber's feed-in `perKwh` is negative when you are paid, so the load
   * table flips it for display (see `moneyValue` below). Nothing upstream normalises this series.
   */
  gridRate?: (number | null)[] | null;
}

/** The label-column bar widths, cycled down the rows so the block reads as a list of differing
 *  names rather than a solid slab. Kept inside the `w-64` table's ~92px label slot. */
const SKELETON_LABEL_WIDTHS = ["w-16", "w-20", "w-12", "w-20"];

/** One placeholder row: swatch + label, the `w-20` value column, the `w-16` metric column. The
 *  `h-4` slots stand in for the 16px line box `text-xs` gives the settled rows — an empty div
 *  establishes no line box, so without them the rows would measure 12px and the block would
 *  grow on arrival. */
function SkeletonRow({
  labelWidth,
  swatch = true,
}: {
  labelWidth: string;
  swatch?: boolean;
}) {
  return (
    <div className="flex items-center text-xs">
      <div className="flex flex-1 h-4 items-center gap-2">
        {swatch && <ShimmerBar className="h-3 w-3 flex-shrink-0" />}
        <ShimmerBar className={`h-3 ${labelWidth}`} />
      </div>
      <div className="flex h-4 w-20 items-center justify-end">
        <ShimmerBar className="h-3 w-12" />
      </div>
      <div className="flex h-4 w-16 items-center justify-end">
        <ShimmerBar className="h-3 w-8" />
      </div>
    </div>
  );
}

/**
 * The table's stand-in while the site history is in flight.
 *
 * Structural, not a fixed height: it wears the SAME wrapper, spacers, borders and column widths as
 * the settled table below, so it measures the same at every breakpoint — which matters on mobile,
 * where the table stacks under the chart and its height is nobody else's problem to reserve.
 *
 * The row count is fixed at 4 because the real count isn't knowable on a cold load (no query
 * cache, so no previous window to count). The footer block follows the settled table's: the
 * generation half carries the Battery SoC line as well as the money line.
 */
function EnergyTableSkeleton({
  mode,
  className = "",
}: {
  mode: "load" | "generation";
  className?: string;
}) {
  return (
    <div className={className} data-skeleton="" aria-hidden>
      <div className="space-y-4" style={{ paddingTop: "44px" }}>
        {/* Column headers */}
        <div className="flex items-center text-xs border-b border-gray-700 pb-1">
          <div className="flex h-4 flex-1 items-center">
            <ShimmerBar className="h-3 w-12" />
          </div>
          <div className="flex h-4 w-20 items-center justify-end">
            <ShimmerBar className="h-3 w-14" />
          </div>
          <div className="flex h-4 w-16 items-center justify-end">
            <ShimmerBar className="h-3 w-8" />
          </div>
        </div>

        {/* Items */}
        <div className="space-y-1">
          {SKELETON_LABEL_WIDTHS.map((w, i) => (
            <SkeletonRow key={i} labelWidth={w} />
          ))}
        </div>

        {/* Total */}
        <div className="border-t border-gray-700 pt-1">
          <SkeletonRow labelWidth="w-10" swatch={false} />
        </div>

        {/* Footer: Battery SoC (generation only) + the grid money line */}
        <div
          className="space-y-1"
          style={{ paddingTop: "20px", paddingBottom: "20px" }}
        >
          {mode === "generation" && <SkeletonRow labelWidth="w-20" />}
          <SkeletonRow labelWidth="w-16" />
        </div>
      </div>
    </div>
  );
}

export default function EnergyTable({
  chartData,
  isLoading,
  mode,
  hoveredIndex,
  className = "",
  visibleSeries,
  onSeriesToggle,
  attributedFlow,
  metric = "pct",
  onCycleMetric,
  gridRate,
}: EnergyTableProps) {
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isPressedRef = useRef(false);
  const longPressHandledRef = useRef(false);

  // Calculate energy values for power series only (not SoC)
  const energyValues = useMemo(() => {
    if (!chartData) return new Map<string, number | null>();
    // Only calculate energy for power/energy series, not SoC
    const powerSeries = chartData.series.filter(
      (s) => !s.seriesType || s.seriesType === "power",
    );
    return calculateSeriesEnergy(powerSeries, chartData.timestamps);
  }, [chartData]);

  /**
   * Per-row provenance reduction over the attributed matrix, keyed by series id. Reducers return null
   * on a legacy/absent payload or an unmapped node, which is exactly the "—" case downstream. The
   * generation table deliberately does NOT combine solar: the chart already has one row per solar
   * source, so each row must reduce its own node.
   */
  const provenance = useMemo(() => {
    const out = new Map<string, ProvenanceRow | null>();
    if (!chartData || !attributedFlow) return out;
    for (const s of chartData.series) {
      if (s.seriesType === "soc" || !s.flowPath) continue;
      out.set(
        s.id,
        mode === "load"
          ? reduceLoadProvenance(attributedFlow, s.flowPath)
          : reduceSourceProvenance(attributedFlow, s.flowPath),
      );
    }
    return out;
  }, [chartData, attributedFlow, mode]);

  if (!chartData || chartData.series.length === 0) {
    // Still coming: a placeholder shaped like the table. "No data" is reserved for the SETTLED
    // empty case below — it is a statement about the data, and saying it while the fetch is in
    // flight is a lie the reader sees on every refresh.
    if (isLoading)
      return <EnergyTableSkeleton mode={mode} className={className} />;
    return (
      <div className={`${className}`}>
        <div className="text-gray-500 text-center">No data</div>
      </div>
    );
  }

  const isHovering = hoveredIndex !== null && hoveredIndex !== undefined;

  // Use hovered index if available, otherwise use the latest
  const dataIndex = isHovering ? hoveredIndex : chartData.timestamps.length - 1;

  // Separate power/energy series from SoC series
  const powerSeries = chartData.series.filter((s) => s.seriesType !== "soc");
  const socSeries = chartData.series.filter((s) => s.seriesType === "soc");

  // Build table data from power series only - maintain consistent order from chart
  const tableData = powerSeries.map((series) => {
    const isVisible = !visibleSeries || visibleSeries.has(series.id);
    return {
      id: series.id,
      label: series.description,
      flowPath: series.flowPath,
      powerValue: series.data[dataIndex], // Power value at specific point (kW)
      energyValue: energyValues.get(series.id) ?? null, // Total energy (kWh)
      color: series.color,
      isVisible,
      provenance: provenance.get(series.id) ?? null, // Window cost/emissions, or null when unknown
    };
  });
  // Keep the original order from the chart configuration - no sorting

  // Extract SoC values for display
  const socLast = socSeries.find((s) => !s.description.includes("("));
  const socAvg = socSeries.find((s) => s.description.includes("(Avg)"));

  // Show SoC value only when hovering
  const socValue = isHovering
    ? (socAvg?.data[dataIndex] ?? socLast?.data[dataIndex]) // Prefer avg (1d), fallback to last (5m/30m)
    : null; // Show — when not hovering

  // Calculate totals (only include visible series)
  // Note: When a master load exists (path="load"), the total should equal the master load
  // because child loads + rest of house = master load
  let powerTotal: number | null = null;
  let energyTotal: number | null = null;
  let hasAnyValue = false;

  tableData.forEach((item) => {
    // Only include in totals if the series is visible
    if (item.isVisible) {
      // Power total
      if (item.powerValue !== null && item.powerValue !== undefined) {
        hasAnyValue = true;
        powerTotal = (powerTotal ?? 0) + item.powerValue;
      }
      // Energy total
      if (item.energyValue !== null && item.energyValue !== undefined) {
        energyTotal = (energyTotal ?? 0) + item.energyValue;
      }
    }
  });

  // If all values are null, total should be null
  if (!hasAnyValue) {
    powerTotal = null;
  }

  const formatValue = (
    value: number | null | undefined,
    decimals: number = 1,
  ) => {
    if (value === null || value === undefined) return "—"; // Show dash for no data
    return value.toFixed(decimals);
  };

  const formatPercentage = (
    value: number | null | undefined,
    total: number | null,
  ) => {
    if (value === null || value === undefined || total === null || total === 0)
      return "—";
    const percentage = (value / total) * 100;
    return percentage.toFixed(0) + "%";
  };

  // Decide which values to show based on hover state
  const displayValue = isHovering ? "power" : "energy";
  const columnHeader = isHovering ? "Power (kW)" : "Energy (kWh)";
  const total = isHovering ? powerTotal : energyTotal;

  // Cost/emissions are WINDOW aggregates — there is no per-instant equivalent — so while the middle
  // column is showing an instantaneous power the last column falls back to "% of that instant".
  // The user's chosen metric is remembered, not reset.
  const effectiveMetric: EnergyTableMetric = isHovering ? "pct" : metric;

  // Totals for the metric column, over VISIBLE rows only (matching the energy/power totals above).
  // The averages re-divide by the filtered known-intensity kWh rather than by total energy, so the
  // Total agrees with the rows even when some rows are only partially attributed.
  let costCTotal = 0;
  let kgCo2Total = 0;
  let costKnownKwhTotal = 0;
  let emissionsKnownKwhTotal = 0;
  let energyKwhTotal = 0;
  let revenueCTotal: number | null = null;
  let revenueKnownKwhTotal = 0;
  let hasProvenance = false;
  tableData.forEach((item) => {
    if (!item.isVisible || !item.provenance) return;
    hasProvenance = true;
    costCTotal += item.provenance.costC;
    kgCo2Total += item.provenance.kgCo2;
    costKnownKwhTotal += item.provenance.costKnownKwh;
    emissionsKnownKwhTotal += item.provenance.emissionsKnownKwh;
    energyKwhTotal += item.provenance.energyKwh;
    if (item.provenance.revenueC !== null) {
      revenueCTotal = (revenueCTotal ?? 0) + item.provenance.revenueC;
      revenueKnownKwhTotal += item.provenance.revenueKnownKwh;
    }
  });

  /** The last column's cell text for one row (or for the Total row, via `totalsRow`). */
  const formatMetric = (
    m: EnergyTableMetric,
    p: ProvenanceRow | null,
  ): string => {
    if (m === "pct") return ""; // percentage has its own signature (value + total)
    if (!p) return "—";
    switch (m) {
      case "cost":
        return formatDollars(p.costC);
      case "rate":
        return formatCentsPerKwh(p.avgCentsPerKwh);
      case "emissions":
        return formatKgCo2(p.kgCo2);
      case "ei":
        return formatGramsPerKwh(p.avgGramsPerKwh);
    }
  };

  const totalsRow: ProvenanceRow | null = hasProvenance
    ? {
        costC: costCTotal,
        kgCo2: kgCo2Total,
        costKnownKwh: costKnownKwhTotal,
        emissionsKnownKwh: emissionsKnownKwhTotal,
        energyKwh: energyKwhTotal,
        revenueC: revenueCTotal,
        revenueKnownKwh: revenueKnownKwhTotal,
        avgCentsPerKwh:
          costKnownKwhTotal > 0 ? costCTotal / costKnownKwhTotal : null,
        avgGramsPerKwh:
          emissionsKnownKwhTotal > 0
            ? (kgCo2Total * 1000) / emissionsKnownKwhTotal
            : null,
      }
    : null;

  // ── The grid money line ──────────────────────────────────────────────────────────────────────
  // What the grid cost you (sources) / paid you (loads) over the window, under the SoC line. The two
  // halves are mirror images: the generation table reads the grid-as-SOURCE row and its `costC` (what
  // the imported energy cost); the load table reads the grid-as-LOAD row and its `revenueC` (what the
  // exported energy earned). They are NOT the same quantity read twice — `costC` on a `load.grid` row
  // is the cost of PRODUCING the energy you exported, which is why this line reads `revenueC` instead.
  //
  // Hovering has no window total to show, so the line switches to the price at that instant. The label
  // switches with it ("Import Cost" → "Import Price") rather than leaving a c/kWh under a $ caption.
  const gridFlowPath = mode === "load" ? "load.grid" : "source.grid";
  const gridProvenance =
    tableData.find((r) => r.flowPath === gridFlowPath)?.provenance ?? null;
  const windowCents = gridProvenance
    ? mode === "load"
      ? quotableCents(
          gridProvenance.revenueC,
          gridProvenance.revenueKnownKwh,
          gridProvenance.energyKwh,
        )
      : quotableCents(
          gridProvenance.costC,
          gridProvenance.costKnownKwh,
          gridProvenance.energyKwh,
        )
    : null;
  const rateNow = gridRate?.[dataIndex] ?? null;
  // Hidden entirely when this Area has neither a priced window nor any price to hover — an off-grid
  // site, or a grid with no tariff bound, shouldn't carry a permanent "—".
  const showMoneyRow =
    !!gridProvenance &&
    (windowCents !== null || (gridRate?.some((v) => v !== null) ?? false));
  const moneyLabel = isHovering
    ? mode === "load"
      ? "Export Price"
      : "Import Price"
    : mode === "load"
      ? "Export Credit"
      : "Import Cost";
  const moneyValue = isHovering
    ? rateNow === null
      ? "—"
      : // The load half flips the sign: `bidi.grid.export/rate` is Amber's feedIn `perKwh`, negative
        // when you are PAID, and this line is captioned as a credit. (`revenueC` above arrives already
        // normalised — the engine does that at its own seam — so only the raw hover series needs it.)
        formatCentsPerKwh(mode === "load" ? -rateNow : rateNow)
    : windowCents === null
      ? "—"
      : formatDollars(windowCents);
  /**
   * The unit rides in the NEXT column so `moneyValue` stays a bare number, right-aligned with the
   * Power/Energy figures directly above it (see the render below). Only the hovered rate has one:
   * the window total is a `formatDollars` string that carries its own "$", and "—" has nothing to
   * attach a unit to.
   */
  const moneyUnit = isHovering && rateNow !== null ? "¢/kWh" : "";

  // Click anywhere in the last column — header, any row, the Total, the SoC row — to cycle.
  const metricCellProps = {
    onClick: onCycleMetric,
    title: "Click to cycle: % · cost · rate · emissions · intensity",
  };
  const metricCellInteractive = onCycleMetric
    ? "cursor-pointer select-none"
    : "";
  const metricCellClass = `font-mono w-16 text-right ${metricCellInteractive}`;

  // Handle touch and click events for series toggle
  const handlePointerDown = (seriesId: string) => {
    isPressedRef.current = true;
    longPressHandledRef.current = false;

    // Start timer for long press (500ms)
    longPressTimerRef.current = setTimeout(() => {
      if (isPressedRef.current) {
        // Long press detected - act as shift-click (select only)
        onSeriesToggle?.(seriesId, true);
        isPressedRef.current = false;
        longPressHandledRef.current = true; // Mark that we handled the long press
      }
    }, 500);
  };

  const handlePointerUp = (
    seriesId: string,
    e: React.MouseEvent | React.TouchEvent,
  ) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // Only handle normal click if we didn't just handle a long press
    if (isPressedRef.current && !longPressHandledRef.current) {
      // Normal click/tap
      const isShiftClick = "shiftKey" in e ? e.shiftKey : false;
      onSeriesToggle?.(seriesId, isShiftClick);
    }

    isPressedRef.current = false;
    longPressHandledRef.current = false;
  };

  const handlePointerCancel = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    isPressedRef.current = false;
    longPressHandledRef.current = false;
  };

  return (
    <div className={`${className}`}>
      {/* Match exact chart title height (text-sm = ~20px) + margin (mb-3 = 12px) + chart padding (~12px) */}
      <div className="space-y-4" style={{ paddingTop: "44px" }}>
        {/* Column Headers - aligned to top */}
        <div className="flex items-center text-xs border-b border-gray-700 pb-1">
          <div className="flex-1 text-gray-400">
            {mode === "load" ? "Load" : "Source"}
          </div>
          <div className="w-20 text-right text-gray-400">{columnHeader}</div>
          <div
            className={`text-gray-400 ${metricCellClass}`}
            {...metricCellProps}
            role={onCycleMetric ? "button" : undefined}
            tabIndex={onCycleMetric ? 0 : undefined}
            onKeyDown={(e) => {
              if (!onCycleMetric) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCycleMetric();
              }
            }}
          >
            {METRIC_HEADER[effectiveMetric]}
          </div>
        </div>

        {/* Items */}
        <div className="space-y-1">
          {tableData.map((item) => {
            return (
              <div key={item.id} className="flex items-center text-xs">
                <div
                  className="flex items-center gap-2 flex-1 cursor-pointer select-none touch-none"
                  onPointerDown={() => handlePointerDown(item.id)}
                  onPointerUp={(e) => handlePointerUp(item.id, e)}
                  onPointerLeave={handlePointerCancel}
                  onPointerCancel={handlePointerCancel}
                  title="Click to toggle visibility, Shift-click or long press to show only this series"
                >
                  <div
                    className="w-3 h-3 rounded-sm flex-shrink-0 border-2"
                    style={{
                      backgroundColor: item.isVisible
                        ? item.color
                        : "transparent",
                      borderColor: item.color,
                    }}
                  />
                  <span className="text-gray-300">{item.label}</span>
                </div>
                <span className="text-gray-100 font-mono w-20 text-right">
                  {item.isVisible
                    ? displayValue === "power"
                      ? formatValue(item.powerValue)
                      : formatValue(item.energyValue, 1)
                    : ""}
                </span>
                <span
                  className={`text-gray-400 ${metricCellClass}`}
                  {...metricCellProps}
                >
                  {!item.isVisible
                    ? ""
                    : effectiveMetric === "pct"
                      ? formatPercentage(
                          displayValue === "power"
                            ? item.powerValue
                            : item.energyValue,
                          total,
                        )
                      : formatMetric(effectiveMetric, item.provenance)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Total */}
        <div className="border-t border-gray-700 pt-1">
          <div className="flex items-center text-xs">
            <span className="text-gray-300 font-medium flex-1">Total</span>
            <span className="text-gray-100 font-mono font-medium w-20 text-right">
              {displayValue === "power"
                ? formatValue(total)
                : formatValue(total, 1)}
            </span>
            <span
              className={`text-gray-400 font-medium ${metricCellClass}`}
              {...metricCellProps}
            >
              {effectiveMetric === "pct"
                ? total !== null
                  ? "100%"
                  : "—"
                : formatMetric(effectiveMetric, totalsRow)}
            </span>
          </div>
        </div>

        {/* Footer lines below the Total: Battery SoC (generation half only — addSocSeries is
            generation-only), then the grid money line. Either may be absent, so the block itself is
            conditional; the load half typically shows only the money line. */}
        {(socSeries.length > 0 || showMoneyRow) && (
          <div
            className="space-y-1"
            style={{ paddingTop: "20px", paddingBottom: "20px" }}
          >
            {socSeries.length > 0 && (
              <div className="flex items-center text-xs">
                <div className="flex items-center gap-2 flex-1">
                  <div
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: CHART_COLORS.battery.soc }}
                  />
                  <span className="text-gray-300">Battery SoC</span>
                </div>
                <span className="text-gray-100 font-mono w-20 text-right">
                  {socValue !== null && socValue !== undefined
                    ? `${formatPercent(socValue)}%`
                    : "—"}
                </span>
                <span
                  className={`text-gray-400 ${metricCellClass}`}
                  {...metricCellProps}
                >
                  {/* Always empty - SoC has no share/cost/emissions of its own. Still part of the
                      column, so clicking it cycles like anywhere else. */}
                </span>
              </div>
            )}

            {showMoneyRow && (
              <div className="flex items-center text-xs">
                <div className="flex items-center gap-2 flex-1">
                  {/* The grid colour, matching the Grid Import / Grid Export series this line
                      prices — one hue serves both directions everywhere in the app. */}
                  <div
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: CHART_COLORS.grid.main }}
                  />
                  <span className="text-gray-300">{moneyLabel}</span>
                </div>
                <span className="text-gray-100 font-mono w-20 text-right">
                  {moneyValue}
                </span>
                {/* The unit, broken off into the metric column and LEFT-aligned, so it reads
                    immediately after the number while the number itself right-aligns with the
                    Power/Energy column above. The two columns abut, so "¢" fuses to the number
                    with no gap — the tight binding docs/architecture/number-typography.md
                    prescribes for "¢", reached by geometry rather than a space character. That doc
                    would leave the "¢" head unmuted; here the whole unit mutes, because in this
                    dense mono table it is secondary chrome next to the value, not a hero glyph.
                    Still part of the column, so clicking it cycles the metric like anywhere else. */}
                <span
                  className={`text-gray-400 font-mono w-16 text-left whitespace-nowrap ${metricCellInteractive}`}
                  {...metricCellProps}
                >
                  {moneyUnit}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
