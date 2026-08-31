import React from "react";
import Value from "@/components/ui/value";
import { CHART_COLORS } from "@/lib/chart-colors";
import {
  LEGEND_LABEL,
  LEGEND_SWATCH,
  LEGEND_SWATCH_BOX,
  LEGEND_VALUE,
  legendSwatchStyle,
} from "@/lib/charts/style";
import { SOC_DASH } from "@/lib/charts/line-series";
import { formatPercent } from "@/lib/point/format-value";

/**
 * A legend swatch. Solid series get a filled square; a dashed series gets a dashed rule, so the
 * legend states the same thing the chart does.
 *
 * These colours come from `CHART_COLORS` rather than Tailwind classes on purpose. This component
 * used to name `bg-yellow-400`/`bg-orange-400`/`bg-red-500` by hand while `datasets.ts` hardcoded a
 * matching RGB literal — two copies of one palette, and a third (`CHART_COLORS`) that the stacked
 * chart and Sankey actually used. They did not agree: the lines chart painted Battery orange-400,
 * which IS `CHART_COLORS.hotWater`, and Grid red-500, next to `CHART_COLORS.ev`. One registry now.
 *
 * The BOX is `LEGEND_SWATCH` — the same 12px `rounded-sm` square, bordered in the series colour,
 * that `EnergyTable` draws. It was a hard-edged `h-3 w-3` span here, so the two legends on one
 * dashboard drew visibly different swatches for the same series.
 */
function Swatch({ color, dash }: { color: string; dash?: number[] }) {
  if (dash) {
    // An SVG rule using the ACTUAL dash array the dataset draws with, so the legend cannot drift
    // from the chart if that pattern is ever tuned. Same box as the solid swatch, minus the border
    // — a 2px frame around a 2px rule would read as a filled square.
    return (
      <svg className={LEGEND_SWATCH_BOX} viewBox="0 0 12 12" aria-hidden>
        <line
          x1="0"
          y1="6"
          x2="12"
          y2="6"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dash.join(" ")}
        />
      </svg>
    );
  }
  return (
    <span
      className={LEGEND_SWATCH}
      style={legendSwatchStyle(color)}
      aria-hidden
    />
  );
}

/**
 * One legend entry: swatch, name, and the focused reading (blank when nothing is focused, or when
 * the focused sample is a gap).
 *
 * The value is right-aligned against a 48px floor so the row does not reflow as the pointer scrubs.
 * That geometry is unchanged; what it replaces is four copy-pasted inline `style` blocks that each
 * re-declared the min-width, the flex and DM Sans by hand. The ink is now `EnergyTable`'s.
 */
function Entry({
  color,
  dash,
  label,
  children,
}: {
  color: string;
  dash?: number[];
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Swatch color={color} dash={dash} />
      <span className={LEGEND_LABEL}>{label}</span>
      <span className={`${LEGEND_VALUE} inline-flex min-w-12 justify-end`}>
        {children}
      </span>
    </div>
  );
}

/**
 * The lines chart's legend + focused-value readout.
 *
 * 🛑 **Presence and value are separate props, and must stay separate.** Which entries exist is a
 * property of the DATA (does this device have a battery / a grid meter?); what they read is a
 * property of the HOVER. Conflating them was the original defect: the Battery and Grid rows were
 * gated on `battery !== null` / `grid !== null` — the hovered *value* — so with nothing hovered they
 * vanished from the legend entirely, and while hovering they flickered out whenever the focused
 * index landed on a null sample (a data gap).
 *
 * `hasBattery`/`hasGrid` mirror the `!= null` tests `lineSeries` uses to decide which series exist,
 * so the legend and the chart list exactly the same series by construction. Solar, Load and Battery
 * SoC have no flag because they are unconditional.
 *
 * The row **wraps**. It used to be a single non-wrapping flex line, so on a phone-width chart the
 * last entries were pushed clean off the edge — Solar and Battery SoC simply vanished, which reads
 * as "this device has no solar" rather than "the legend does not fit". Found once an explicitly
 * narrow gallery case existed; the mobile Playwright project renders the same 900 px chart, so
 * viewport alone never surfaced it.
 *
 * The unit rides INLINE on each value (via `<Value>`) rather than sitting in a column header, as it
 * does in `EnergyTable`. That is the one place the two legends legitimately differ: a row has no
 * header to hang `kW` on. See docs/architecture/chart-style.md.
 */
interface ChartTooltipProps {
  /** Whether the series EXISTS (mirrors the dataset gate) — not whether it has a value right now. */
  hasBattery: boolean;
  hasGrid: boolean;
  solar: number | null;
  load: number | null;
  battery?: number | null;
  grid?: number | null;
  batterySOC: number | null;
  unit: "kW" | "kWh";
}

export default function ChartTooltip({
  hasBattery,
  hasGrid,
  solar,
  load,
  battery,
  grid,
  batterySOC,
  unit,
}: ChartTooltipProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs sm:gap-x-6 md:gap-x-10">
      <Entry color={CHART_COLORS.solar.primary} label="Solar">
        {solar != null ? <Value value={solar.toFixed(1)} unit={unit} /> : null}
      </Entry>

      <Entry color={CHART_COLORS.load} label="Load">
        {load != null ? <Value value={load.toFixed(1)} unit={unit} /> : null}
      </Entry>

      {/* Battery power — shown whenever the SERIES exists, blank when this instant has no sample. */}
      {hasBattery && (
        <Entry color={CHART_COLORS.battery.main} label="Battery">
          {battery != null ? (
            <Value value={battery.toFixed(1)} unit={unit} />
          ) : null}
        </Entry>
      )}

      {/* Grid — shown whenever the SERIES exists, blank when this instant has no sample. */}
      {hasGrid && (
        <Entry color={CHART_COLORS.grid.main} label="Grid">
          {grid != null ? <Value value={grid.toFixed(1)} unit={unit} /> : null}
        </Entry>
      )}

      <Entry
        color={CHART_COLORS.battery.soc}
        dash={SOC_DASH}
        label="Battery SoC"
      >
        {batterySOC != null ? (
          <Value value={formatPercent(batterySOC)} unit="%" />
        ) : null}
      </Entry>
    </div>
  );
}
