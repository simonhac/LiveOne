import React from "react";
import Value from "@/components/ui/value";
import { CHART_COLORS } from "@/lib/chart-colors";
import { SOC_DASH } from "@/lib/charts/datasets";

/**
 * A legend swatch. Solid series get a filled square; a dashed series gets a dashed rule, so the
 * legend states the same thing the chart does.
 *
 * These colours come from `CHART_COLORS` rather than Tailwind classes on purpose. This component
 * used to name `bg-yellow-400`/`bg-orange-400`/`bg-red-500` by hand while `datasets.ts` hardcoded a
 * matching RGB literal — two copies of one palette, and a third (`CHART_COLORS`) that the stacked
 * chart and Sankey actually used. They did not agree: the lines chart painted Battery orange-400,
 * which IS `CHART_COLORS.hotWater`, and Grid red-500, next to `CHART_COLORS.ev`. One registry now.
 */
function Swatch({ color, dash }: { color: string; dash?: number[] }) {
  if (dash) {
    // An SVG rule using the ACTUAL dash array the dataset draws with, so the legend cannot drift
    // from the chart if that pattern is ever tuned.
    return (
      <svg className="h-3 w-3" viewBox="0 0 12 12" aria-hidden>
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
      className="inline-block h-3 w-3"
      style={{ backgroundColor: color }}
      aria-hidden
    />
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
 * `hasBattery`/`hasGrid` mirror the `!= null` tests `buildLineDatasets` uses to decide which datasets
 * to draw, so the legend and the chart now list exactly the same series by construction. Solar, Load
 * and Battery SoC have no flag because their datasets are unconditional.
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
    <div className="flex items-center gap-3 sm:gap-6 md:gap-10 text-xs">
      {/* Solar */}
      <div className="flex items-center gap-1">
        <Swatch color={CHART_COLORS.solar.primary} />
        <span className="text-gray-400">Solar</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {solar !== null && solar !== undefined ? (
            <Value
              className="text-white"
              value={solar.toFixed(1)}
              unit={unit}
            />
          ) : null}
        </span>
      </div>

      {/* Load */}
      <div className="flex items-center gap-1">
        <Swatch color={CHART_COLORS.load} />
        <span className="text-gray-400">Load</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {load !== null && load !== undefined ? (
            <Value className="text-white" value={load.toFixed(1)} unit={unit} />
          ) : null}
        </span>
      </div>

      {/* Battery power — shown whenever the SERIES exists, blank when this instant has no sample. */}
      {hasBattery && (
        <div className="flex items-center gap-1">
          <Swatch color={CHART_COLORS.battery.main} />
          <span className="text-gray-400">Battery</span>
          <span
            style={{
              minWidth: "48px",
              display: "inline-flex",
              fontFamily: "DM Sans, system-ui, sans-serif",
              justifyContent: "flex-end",
            }}
          >
            {battery !== null && battery !== undefined ? (
              <Value
                className="text-white"
                value={battery.toFixed(1)}
                unit={unit}
              />
            ) : null}
          </span>
        </div>
      )}

      {/* Grid — shown whenever the SERIES exists, blank when this instant has no sample. */}
      {hasGrid && (
        <div className="flex items-center gap-1">
          <Swatch color={CHART_COLORS.grid.main} />
          <span className="text-gray-400">Grid</span>
          <span
            style={{
              minWidth: "48px",
              display: "inline-flex",
              fontFamily: "DM Sans, system-ui, sans-serif",
              justifyContent: "flex-end",
            }}
          >
            {grid !== null && grid !== undefined ? (
              <Value
                className="text-white"
                value={grid.toFixed(1)}
                unit={unit}
              />
            ) : null}
          </span>
        </div>
      )}

      {/* Battery SoC */}
      <div className="flex items-center gap-1">
        <Swatch color={CHART_COLORS.battery.soc} dash={SOC_DASH} />
        <span className="text-gray-400">Battery SoC</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {batterySOC !== null && batterySOC !== undefined ? (
            <Value
              className="text-white"
              value={batterySOC.toFixed(1)}
              unit={"%"}
            />
          ) : null}
        </span>
      </div>
    </div>
  );
}
