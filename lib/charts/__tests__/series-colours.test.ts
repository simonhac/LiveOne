import { describe, it, expect } from "@jest/globals";
import { SOC_DASH, lineSeries } from "../line-series";
import { CHART_COLORS } from "@/lib/chart-colors";
import type { LineChartData } from "../types";

/**
 * Guards the palette against the blind spot in the screenshot gate.
 *
 * A palette regression is far smaller than the canvas→SVG noise the gate had to tolerate: changing
 * Solar from yellow-400 to yellow-200 across the whole line measured **1,345 pixels — 0.39 %**, while
 * the renderer floor measured 5–6 %. Defect #6 was exactly that class of bug and it shipped for
 * years. So colour is asserted against `CHART_COLORS` by value, never by pixel.
 *
 * 🛑 **This has to target what actually renders.** It originally tested `buildLineDatasets`, which
 * the Stage 5 port made dead — the guard stayed green while pointing at code no consumer reached,
 * which is worse than no guard because it reads as coverage. It now targets `lineSeries`, the
 * function `DashboardChart` really calls. If that is ever replaced, move this with it.
 */

function data(over: Partial<LineChartData> = {}): LineChartData {
  return {
    timestamps: [
      new Date("2026-06-15T00:00:00+10:00"),
      new Date("2026-06-15T00:05:00+10:00"),
    ],
    solar: [1, 2],
    load: [3, 4],
    batteryW: [-1, 1],
    batterySOC: [50, 51],
    grid: [0.5, 0.5],
    mode: "power",
    ...over,
  };
}

const colourOf = (d: LineChartData, key: string) =>
  lineSeries(d).find((s) => s.key === key)?.colour;

describe("lines chart series resolve their colour from CHART_COLORS", () => {
  it.each([
    ["solar", CHART_COLORS.solar.primary],
    ["load", CHART_COLORS.load],
    ["battery", CHART_COLORS.battery.main],
    ["grid", CHART_COLORS.grid.main],
  ])("%s", (key, colour) => {
    expect(colourOf(data(), key)).toBe(colour);
  });

  it("emits only colours the registry contains", () => {
    // 🛑 Note the limit: this compares VALUES, so it catches a colour that is off-registry — the way
    // the lines chart drifted onto orange-400 and red-500 — but it cannot tell a registry reference
    // from a hand-copied literal of the same value. That is a maintainability smell rather than a
    // rendering bug. Do not read this as "no literals exist".
    const registry = new Set<string>([
      ...Object.values(CHART_COLORS.solar),
      ...Object.values(CHART_COLORS.battery),
      ...Object.values(CHART_COLORS.grid),
      CHART_COLORS.load,
      CHART_COLORS.focusLine,
      CHART_COLORS.hotWater,
      CHART_COLORS.pool,
      CHART_COLORS.ev,
      CHART_COLORS.restOfHouse,
    ]);
    for (const mode of ["power", "energy"] as const) {
      for (const s of lineSeries(data({ mode }))) {
        expect(registry.has(s.colour)).toBe(true);
      }
    }
  });
});

describe("series presence is structural, not truthiness", () => {
  it("lists all four when the device has them", () => {
    expect(lineSeries(data()).map((s) => s.key)).toEqual([
      "solar",
      "load",
      "battery",
      "grid",
    ]);
  });

  it("omits Battery for a battery-less device", () => {
    // Defect #3: `batteryW` used to be an all-nulls ARRAY, which is truthy, so a phantom Battery
    // series was added anyway — and in energy mode it stole a grouped-bar slot and narrowed the real
    // bars. Absent must mean absent.
    const keys = lineSeries(data({ batteryW: undefined })).map((s) => s.key);
    expect(keys).not.toContain("battery");
    expect(keys).toContain("grid");
  });

  it("omits Grid for an off-grid device", () => {
    expect(
      lineSeries(data({ grid: undefined })).map((s) => s.key),
    ).not.toContain("grid");
  });

  it("does NOT treat an all-nulls array as absent", () => {
    // The inverse guard. A series that exists but has no readings in this window is still a series —
    // its legend entry must stay, blank, rather than disappearing (defects #1 and #2).
    const keys = lineSeries(
      data({ batteryW: [null, null], grid: [null, null] }),
    ).map((s) => s.key);
    expect(keys).toContain("battery");
    expect(keys).toContain("grid");
  });
});

describe("Battery and Battery SoC stay distinguishable", () => {
  it("share a colour by design, so texture has to separate them", () => {
    expect(CHART_COLORS.battery.soc).toBe(CHART_COLORS.battery.main);
    expect(SOC_DASH.length).toBeGreaterThan(0);
    expect(SOC_DASH.every((n) => n > 0)).toBe(true);
  });
});
