import { describe, it, expect } from "@jest/globals";
import { buildLineDatasets, SOC_DASH } from "../datasets";
import { CHART_COLORS } from "@/lib/chart-colors";
import type { LineChartData } from "../types";

/**
 * Guards the palette against the blind spot in the screenshot gate.
 *
 * From Stage 5 the pixel tolerance is loosened to absorb canvas→SVG rasterisation noise, and that
 * band is far wider than a palette regression: changing Solar from yellow-400 to yellow-200 across
 * the whole line was **measured at 1,345 pixels — 0.39%**, so a 2–3% gate sails straight past it.
 * Defect #6 was exactly that class of bug and it shipped for years.
 *
 * So the colours are asserted against `CHART_COLORS` by value rather than by pixel. An off-registry
 * colour, or a series repointed at the wrong registry entry, fails here loudly whatever the renderer
 * is doing. Verified with a negative control: a hardcoded literal, a repointed entry and a removed
 * SoC dash each turn this suite red.
 */

const ts = [
  new Date("2026-06-15T00:00:00+10:00"),
  new Date("2026-06-15T00:05:00+10:00"),
];

function data(over: Partial<LineChartData> = {}): LineChartData {
  return {
    timestamps: ts,
    solar: [1, 2],
    load: [3, 4],
    batteryW: [-1, 1],
    batterySOC: [50, 51],
    grid: [0.5, 0.5],
    mode: "power",
    ...over,
  };
}

/** borderColor for a dataset by label, from the built set. */
const colourOf = (sets: any[], label: string) =>
  sets.find((d) => d.label === label)?.borderColor ??
  sets.find((d) => d.label === label)?.backgroundColor;

describe("lines chart series colours resolve from CHART_COLORS", () => {
  const expected: Array<[string, string]> = [
    ["Solar", CHART_COLORS.solar.primary],
    ["Load", CHART_COLORS.load],
    ["Battery", CHART_COLORS.battery.main],
    ["Grid", CHART_COLORS.grid.main],
    ["Battery SoC", CHART_COLORS.battery.soc],
  ];

  it.each(expected)("power mode: %s", (label, colour) => {
    expect(colourOf(buildLineDatasets(data(), null), label)).toBe(colour);
  });

  it.each(expected.filter(([l]) => l !== "Battery"))(
    "energy mode: %s",
    (label, colour) => {
      // Energy mode has no battery POWER series — `lines-data` nulls it deliberately.
      const sets = buildLineDatasets(
        data({ mode: "energy", batteryW: undefined }),
        null,
      );
      expect(colourOf(sets, label)).toBe(colour);
    },
  );

  it("emits only colours the registry contains", () => {
    // 🛑 Note the limit: this compares VALUES, so it catches a colour that is off-registry — the way
    // the lines chart drifted onto orange-400 and red-500 — but it cannot tell a registry reference
    // from a hand-copied literal of the same value. That is a maintainability smell rather than a
    // rendering bug, and it is caught by review, not here. Do not read this as "no literals exist".
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
      "transparent",
    ]);
    for (const mode of ["power", "energy"] as const) {
      for (const d of buildLineDatasets(data({ mode }), null)) {
        for (const key of ["borderColor", "backgroundColor"] as const) {
          const v = d[key];
          if (typeof v !== "string") continue;
          expect(registry.has(v)).toBe(true);
        }
      }
    }
  });
});

describe("Battery and Battery SoC stay distinguishable", () => {
  /**
   * They share `battery.soc === battery.main` by design, so that "battery is green" holds
   * everywhere — which means texture, not hue, is the only thing separating them on the one chart
   * that draws both at once.
   */
  it("share a colour, and are separated by the dash instead", () => {
    expect(CHART_COLORS.battery.soc).toBe(CHART_COLORS.battery.main);

    const sets = buildLineDatasets(data(), null);
    const power = sets.find((d) => d.label === "Battery");
    const soc = sets.find((d) => d.label === "Battery SoC");

    expect(power).toBeDefined();
    expect(soc).toBeDefined();
    expect(soc.borderDash).toEqual(SOC_DASH);
    // Battery power must NOT be dashed, or the distinction collapses.
    expect(power.borderDash ?? []).toEqual([]);
  });

  it("SoC is dashed in energy mode too", () => {
    const sets = buildLineDatasets(
      data({ mode: "energy", batteryW: undefined }),
      null,
    );
    expect(sets.find((d) => d.label === "Battery SoC").borderDash).toEqual(
      SOC_DASH,
    );
  });

  it("SOC_DASH is a real dash pattern, so the legend swatch renders one", () => {
    expect(SOC_DASH.length).toBeGreaterThan(0);
    expect(SOC_DASH.every((n) => n > 0)).toBe(true);
  });
});
