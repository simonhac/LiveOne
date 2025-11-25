/**
 * Centralized color management for all charts
 * Ensures consistent colors across SitePowerChart, EnergyChart, Sankey, and other visualizations
 */

import { parsePointPath } from "@/lib/identifiers/point-path-utils";
import {
  interpolateViridis,
  interpolatePlasma,
  interpolateTurbo,
  interpolateRdYlBu,
  interpolateGreens,
} from "d3-scale-chromatic";

// Fixed colors for specific series types
export const CHART_COLORS = {
  // Energy sources
  solar: {
    primary: "rgb(254, 240, 138)", // yellow-200 - Solar Local
    secondary: "rgb(245, 158, 11)", // amber-500 - Solar Remote
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

  // Special load types
  hotWater: "rgb(251, 146, 60)", // orange-400 - Hot Water/HWS/Heat Pump
  pool: "rgb(34, 211, 238)", // cyan-400 - Pool (aqua)

  // Other
  restOfHouse: "rgb(156, 163, 175)", // gray-400 - Rest of House
} as const;

// Color palette for dynamic load discovery
// Avoid conflicts with fixed colors above
export const LOAD_COLORS = [
  "rgb(147, 51, 234)", // purple-600
  "rgb(239, 68, 68)", // red-500
  "rgb(168, 85, 247)", // violet-500
  "rgb(132, 204, 22)", // lime-500
  "rgb(234, 179, 8)", // yellow-600
  "rgb(20, 184, 166)", // teal-500
] as const;

// Friendly labels for known load types
export const LOAD_LABELS: Record<string, string> = {
  hvac: "A/C",
  ev: "EV Charger",
  hws: "Hot Water",
  pool: "Pool",
  spa: "Spa",
  oven: "Oven",
} as const;

// Special colors for specific load types (by load type identifier)
export const LOAD_TYPE_COLORS: Record<string, string> = {
  hws: CHART_COLORS.hotWater,
  pool: CHART_COLORS.pool,
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

  // Check for special identifiers
  if (path === "rest_of_house") {
    return CHART_COLORS.restOfHouse;
  }

  // Parse the path using parsePointPath utility
  const pointPath = parsePointPath(path);
  if (!pointPath) {
    // If parsing fails, return default color
    return "rgb(156, 163, 175)"; // gray-400
  }

  const type = pointPath.type;
  const subtype = pointPath.subtype || "";
  const extension = pointPath.extension;

  // Solar
  if (type === "source" && subtype === "solar") {
    return extension === "remote"
      ? CHART_COLORS.solar.secondary
      : CHART_COLORS.solar.primary;
  }

  // Battery
  if (type === "bidi" && subtype === "battery") {
    return CHART_COLORS.battery.main;
  }

  // Grid
  if (type === "bidi" && subtype === "grid") {
    return CHART_COLORS.grid.main;
  }

  // Loads
  if (type === "load") {
    // Check for special load types
    if (subtype && LOAD_TYPE_COLORS[subtype]) {
      return LOAD_TYPE_COLORS[subtype];
    }

    // Check label-based colors
    if (label === "Hot Water" || label === "HWS" || label === "Heat Pump") {
      return CHART_COLORS.hotWater;
    }
    if (label === "Pool") {
      return CHART_COLORS.pool;
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

/**
 * Heatmap color palettes using d3-scale-chromatic
 * All palettes are scientifically designed for data visualization
 */
export const HEATMAP_PALETTES = {
  viridis: {
    name: "Viridis",
    description:
      "Purple → Green → Yellow (perceptually uniform, colorblind-safe)",
    fn: interpolateViridis,
  },
  plasma: {
    name: "Plasma",
    description:
      "Purple → Pink → Orange → Yellow (vibrant, perceptually uniform)",
    fn: interpolatePlasma,
  },
  turbo: {
    name: "Turbo",
    description: "Blue → Cyan → Green → Yellow → Red (high contrast)",
    fn: interpolateTurbo,
  },
  rdylbu: {
    name: "Cool-Warm",
    description: "Blue → Yellow → Red (diverging)",
    fn: interpolateRdYlBu,
  },
  greens: {
    name: "Greens",
    description: "Light → Dark Green (sequential)",
    fn: interpolateGreens,
  },
} as const;

export type HeatmapPaletteKey = keyof typeof HEATMAP_PALETTES;
