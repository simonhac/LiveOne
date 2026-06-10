/**
 * Heatmap color palettes using d3-scale-chromatic.
 *
 * Kept separate from `lib/chart-colors.ts` so that the lightweight path/series color helpers
 * there stay free of the heavy (ESM-only) d3-scale-chromatic dependency and remain importable
 * from pure/test contexts.
 */

import {
  interpolateViridis,
  interpolatePlasma,
  interpolateTurbo,
  interpolateRdYlBu,
  interpolateGreens,
} from "d3-scale-chromatic";

/**
 * Heatmap color palettes — all perceptually designed for data visualization.
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
