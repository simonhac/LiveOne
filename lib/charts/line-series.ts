/**
 * The lines chart's series list: which series exist, in what order, and in what colour.
 *
 * Pure and separate from `DashboardChart` so the palette guard can test **what actually renders**.
 * That is not a stylistic preference: this replaced `buildLineDatasets`, and when the port landed
 * that builder became dead while `series-colours.test.ts` went on testing it — a guard passing
 * against code no consumer reaches is worse than no guard, because it reads as coverage.
 */
import { CHART_COLORS } from "@/lib/chart-colors";
import type { LineChartData } from "./types";

export interface LineSeries {
  key: string;
  colour: string;
  values: (number | null)[];
}

/**
 * Solar and Load are unconditional; Battery and Grid appear only when the device has them.
 *
 * Presence is **structural** (`!= null`), never truthiness: `batteryW` used to be an all-nulls array,
 * which is truthy, so a phantom Battery series was added for battery-less devices and — in energy
 * mode, where Chart.js allocated a grouped-bar slot per dataset — visibly narrowed the real bars.
 * That was defect #3; keep the `!= null`.
 */
export function lineSeries(d: LineChartData): LineSeries[] {
  const out: LineSeries[] = [
    { key: "solar", colour: CHART_COLORS.solar.primary, values: d.solar },
    { key: "load", colour: CHART_COLORS.load, values: d.load },
  ];
  if (d.batteryW != null) {
    out.push({
      key: "battery",
      colour: CHART_COLORS.battery.main,
      values: d.batteryW,
    });
  }
  if (d.grid != null) {
    out.push({ key: "grid", colour: CHART_COLORS.grid.main, values: d.grid });
  }
  return out;
}

/**
 * Dash pattern for the Battery SoC trace, exported so the legend swatch draws the same one.
 *
 * SoC needs it because `CHART_COLORS.battery.soc` and `.main` are deliberately the same green — so
 * that "battery is green" holds everywhere — and the lines chart is the one place that draws battery
 * power and SoC together. They sit on different axes (kW left, % right), so hue would be a poor
 * discriminator anyway; texture is the honest one.
 */
export const SOC_DASH = [4, 3];
