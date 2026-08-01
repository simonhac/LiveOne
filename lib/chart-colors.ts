/**
 * Centralized color management for all charts
 * Ensures consistent colors across the dashboard charts, Sankey, and other visualizations
 */

import { stemSplit } from "@/lib/identifiers/logical-path";

// Fixed colors for specific series types
export const CHART_COLORS = {
  // Energy sources
  solar: {
    primary: "rgb(254, 240, 138)", // yellow-200 - Solar Local
    secondary: "rgb(245, 158, 11)", // amber-500 - Solar Remote
    residual: "rgb(202, 138, 4)", // yellow-600 - Solar Residual (unmetered remainder)
  },

  // Battery (green)
  battery: {
    main: "rgb(74, 222, 128)", // green-400 - Battery power
    soc: "rgb(74, 222, 128)", // green-400 - Battery SoC (matches power)
    socRange: "rgba(74, 222, 128, 0.3)", // green-400 at 30% opacity
  },

  // Grid (magenta)
  grid: {
    main: "rgb(236, 72, 153)", // pink-500 - Grid import/export
  },

  // Total site load — the lines chart's aggregate load trace. Distinct from `restOfHouse` below,
  // which is the *remainder* after sub-metered loads in the stacked chart. Added when the lines
  // chart stopped hardcoding its palette; blue is otherwise unused here, so nothing collides.
  load: "rgb(96, 165, 250)", // blue-400

  // The shared focus/crosshair line drawn at ChartFocusContext's focusedTime. Not a series colour —
  // it must stay legible against every one of them, which is why it is not in the series palette.
  // (It was safe to leave as red-500 only once the lines chart's Grid moved off red onto grid.main.)
  focusLine: "rgb(239, 68, 68)", // red-500

  // Special load types
  hotWater: "rgb(251, 146, 60)", // orange-400 - Hot Water/HWS/Heat Pump
  pool: "rgb(34, 211, 238)", // cyan-400 - Pool (aqua)
  ev: "rgb(220, 38, 38)", // red-600 - EV charging (mirrors the mySigen EVAC node)
  // violet-400 - HVAC/climate. Violet is the one wide gap left on the wheel once Solar yellow,
  // EV red, Hot Water orange, Pool cyan, Battery green, Grid magenta and Other grey are locked.
  // HVAC used to fall through to LOAD_COLORS, which put it on lime-500 — indistinguishable from
  // Battery Charge green-400, the band it sits directly against in the stacked load chart.
  hvac: "rgb(167, 139, 250)",

  // Other
  restOfHouse: "rgb(156, 163, 175)", // gray-400 - Rest of House
} as const;

// Fallback palette for load stems that have no entry in LOAD_TYPE_COLORS below.
//
// 🛑 With the named roles taken the wheel is nearly full, so this rotation exists to keep an
// unnamed load **visible**, not **identified** — and which colour a load lands on is unstable
// (`getLoadColor` rotates by list index, `getColorForPath` by a char-code hash, so the same load
// can be two colours in two views). Any load that persists belongs in LOAD_TYPE_COLORS, not here.
//
// The previous rotation actively collided with the fixed palette: red-500 was byte-identical to
// `focusLine` and sat beside `ev` red-600, lime-500 was indistinguishable from `battery.main`,
// yellow-600 clashed with solar, and purple-600/violet-500 were near-duplicates of each other.
export const LOAD_COLORS = [
  "rgb(45, 212, 191)", // teal-400
  "rgb(232, 121, 249)", // fuchsia-400
  "rgb(129, 140, 248)", // indigo-400
  "rgb(190, 242, 100)", // lime-300
  "rgb(253, 164, 175)", // rose-300
  "rgb(125, 211, 252)", // sky-300
] as const;

// Special colors for specific load types (by load type identifier)
// Naming a stem here is what makes its colour STABLE and CONSISTENT: it is the only branch both
// `getLoadColor` (stacked chart, rotates by index) and `getColorForPath` (Sankey, hashes the stem)
// consult before falling back, so an unnamed stem can render as two different colours in two views.
// These are the `load.<stem>` values that actually exist — keep them in sync as sub-meters are added.
export const LOAD_TYPE_COLORS: Record<string, string> = {
  hws: CHART_COLORS.hotWater,
  pool: CHART_COLORS.pool,
  hvac: CHART_COLORS.hvac,
  // An EV charger inside the load hierarchy (`load.ev`) keeps the EV colour it had as a top-level
  // `ev.charge` node, so re-parenting it doesn't recolour the chart.
  ev: CHART_COLORS.ev,
} as const;

/**
 * Get color for a load series based on its type/label
 * @param loadType - The load type identifier (e.g., "hws", "pool")
 * @param label - The display label for the load
 * @param index - The index for rotating through LOAD_COLORS
 * @returns The color to use for this load
 */
export function getLoadColor(
  loadType: string | undefined,
  label: string | undefined,
  index: number,
): string {
  // Check for special colors based on load type
  if (loadType && LOAD_TYPE_COLORS[loadType]) {
    return LOAD_TYPE_COLORS[loadType];
  }

  // Check for special colors based on label
  if (label === "Hot Water" || label === "HWS" || label === "Heat Pump") {
    return CHART_COLORS.hotWater;
  }
  if (label === "Pool") {
    return CHART_COLORS.pool;
  }

  // Default to rotating through LOAD_COLORS
  return LOAD_COLORS[index % LOAD_COLORS.length];
}

/**
 * Get color for a series based on its path
 * Used by Sankey and other components that work with series paths
 * @param path - The series path (e.g., "source.solar/power.avg" or "bidi.battery/soc.avg")
 * @param label - Optional label for special cases
 * @returns The color to use for this series
 */
export function getColorForPath(path: string, label?: string): string {
  // Check if this is a SoC series
  if (path.includes("/soc.")) {
    return CHART_COLORS.battery.soc;
  }

  // Check for special identifiers — synthetic "rest of house" load.
  // Matches both the in-memory series id ("rest-of-house") and the persisted
  // canonical path ("load.rest-of-house") used by the energy-flow matrix.
  if (path === "rest-of-house" || path === "load.rest-of-house") {
    return CHART_COLORS.restOfHouse;
  }

  // Parse the path using stemSplit utility
  const segments = stemSplit(path);
  if (segments.length === 0) {
    // If parsing fails, return default color
    return "rgb(156, 163, 175)"; // gray-400
  }

  const type = segments[0];
  const subtype = segments[1] || "";
  const extension = segments.length > 2 ? segments.slice(2).join(".") : null;

  // Solar
  if (type === "source" && subtype === "solar") {
    if (extension === "remote") return CHART_COLORS.solar.secondary;
    if (extension === "residual") return CHART_COLORS.solar.residual;
    return CHART_COLORS.solar.primary;
  }

  // Battery
  if (type === "bidi" && subtype === "battery") {
    return CHART_COLORS.battery.main;
  }

  // Grid
  if (type === "bidi" && subtype === "grid") {
    return CHART_COLORS.grid.main;
  }

  // EV charging — a top-level load stem, so it never reaches the `load` branch below.
  if (type === "ev") {
    return CHART_COLORS.ev;
  }

  // Loads - match by logical path segments
  if (type === "load") {
    // Check for special load types by path segment (e.g., "load.hws", "load.pool")
    if (subtype && LOAD_TYPE_COLORS[subtype]) {
      return LOAD_TYPE_COLORS[subtype];
    }

    // For other loads, use a consistent hash-based color selection
    // This ensures the same load type always gets the same color
    const hash = subtype
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return LOAD_COLORS[hash % LOAD_COLORS.length];
  }

  // Default fallback
  return "rgb(156, 163, 175)"; // gray-400
}

// Heatmap palettes live in `lib/heatmap-colors.ts` to keep this module free of the heavy
// d3-scale-chromatic dependency.
