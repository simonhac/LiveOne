import { describe, it, expect } from "@jest/globals";
import {
  CHART_COLORS,
  LOAD_COLORS,
  LOAD_TYPE_COLORS,
  getColorForPath,
  getLoadColor,
} from "../chart-colors";

/**
 * Guards the palette's two structural invariants — one colour per role, and the SAME colour for a
 * role in every view.
 *
 * `lib/charts/__tests__/series-colours.test.ts` already checks that the lines chart resolves its four
 * series through `CHART_COLORS`. It could not catch this class of bug because the defect lived in the
 * LOADS, which that chart doesn't draw: `hvac` had no `LOAD_TYPE_COLORS` entry, so the stacked chart
 * fell through to `LOAD_COLORS[idx % 6]` (lime-500, indistinguishable from the Battery Charge green it
 * sits against) while the Sankey fell through to `LOAD_COLORS[hash % 6]` (yellow-500). One load, two
 * colours, neither of them stable — adding a sub-meter ahead of HVAC silently recoloured it.
 */

describe("every named load type resolves identically in the chart and the Sankey", () => {
  // `getLoadColor` is what the stacked chart calls (lib/charts/series-config.ts:58); `getColorForPath`
  // is what the Sankey and the energy-flow matrix call. They share only the LOAD_TYPE_COLORS branch,
  // so this is the assertion that a stem is genuinely named rather than accidentally agreeing.
  it.each(Object.keys(LOAD_TYPE_COLORS))("load.%s", (loadType) => {
    expect(getLoadColor(loadType, undefined, 0)).toBe(
      getColorForPath(`load.${loadType}/power.avg`),
    );
  });

  it("covers every load stem that actually exists", () => {
    // Sourced from `SELECT DISTINCT split_part(logical_path,'/',1) FROM points WHERE logical_path
    // LIKE 'load.%'`. `rest-of-house` is deliberately absent from LOAD_TYPE_COLORS — it is the
    // synthetic remainder and both resolvers special-case it. Add new sub-meters here AND in
    // LOAD_TYPE_COLORS; leaving one to the LOAD_COLORS rotation reintroduces the HVAC defect.
    expect(Object.keys(LOAD_TYPE_COLORS).sort()).toEqual([
      "ev",
      "hvac",
      "hws",
      "pool",
    ]);
  });
});

describe("a named load type's colour does not depend on its position", () => {
  it("HVAC is violet at every index", () => {
    const colours = [0, 1, 2, 3, 4, 5, 6, 11].map((i) =>
      getLoadColor("hvac", "HVAC", i),
    );
    expect(new Set(colours).size).toBe(1);
    expect(colours[0]).toBe(CHART_COLORS.hvac);
  });
});

describe("no two roles share a colour", () => {
  /** Every distinct role the palette can put on screen at once, flattened to [name, colour]. */
  function paletteEntries(): Array<[string, string]> {
    return [
      ["solar.primary", CHART_COLORS.solar.primary],
      ["solar.secondary", CHART_COLORS.solar.secondary],
      ["solar.residual", CHART_COLORS.solar.residual],
      ["battery.main", CHART_COLORS.battery.main],
      ["grid.main", CHART_COLORS.grid.main],
      ["load", CHART_COLORS.load],
      ["focusLine", CHART_COLORS.focusLine],
      ["hotWater", CHART_COLORS.hotWater],
      ["pool", CHART_COLORS.pool],
      ["ev", CHART_COLORS.ev],
      ["hvac", CHART_COLORS.hvac],
      ["restOfHouse", CHART_COLORS.restOfHouse],
      ...LOAD_COLORS.map((c, i): [string, string] => [`LOAD_COLORS[${i}]`, c]),
    ];
  }

  it("holds across the fixed palette and the fallback rotation", () => {
    // `battery.soc` and `battery.socRange` are excluded on purpose: SoC shares battery.main by design
    // and is separated by SOC_DASH (asserted in lib/charts/__tests__/series-colours.test.ts).
    // LOAD_TYPE_COLORS is excluded because its values are aliases OF the entries above.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [name, colour] of paletteEntries()) {
      const prior = seen.get(colour);
      if (prior) clashes.push(`${name} === ${prior} (${colour})`);
      else seen.set(colour, name);
    }
    expect(clashes).toEqual([]);
  });

  it("LOAD_TYPE_COLORS only ever aliases the fixed palette", () => {
    const fixed = new Set(paletteEntries().map(([, c]) => c));
    for (const [type, colour] of Object.entries(LOAD_TYPE_COLORS)) {
      expect({ type, inFixedPalette: fixed.has(colour) }).toEqual({
        type,
        inFixedPalette: true,
      });
    }
  });
});
