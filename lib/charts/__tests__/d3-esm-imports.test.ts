/**
 * Guards the Jest ESM-d3 transform.
 *
 * Every d3 package we use is `"type": "module"` and ships untranspiled ESM (`d3-scale`'s `main` is
 * `src/index.js`). Jest does not transform `node_modules` by default, so merely *importing* one of
 * these from a test used to throw `SyntaxError: Unexpected token 'export'` — which is why
 * `DailyStripes` was `jest.mock`'d out wholesale in `lib/dashboard/__tests__/v4-render-props.test.ts`
 * rather than exercised.
 *
 * The fix (in all three jest configs, via `jest.shared.js`) is two-part and both halves are needed:
 *   1. `transformIgnorePatterns` un-ignores `d3-*` and `internmap`, and
 *   2. a `^.+\.js$` transform exists at all — the previous config only transformed `.tsx?`.
 *
 * This test fails loudly if either half regresses. `d3-sankey` is included deliberately: npm gives it
 * its own nested `node_modules/d3-sankey/node_modules/{d3-array,d3-shape}` at pinned v1/v2, so it
 * proves the pattern matches at a *second* `/node_modules/` segment too.
 */
import { scaleLinear, scaleTime } from "d3-scale";
import { timeHour } from "d3-time";
import { interpolateHsl } from "d3-interpolate";
import { interpolateViridis } from "d3-scale-chromatic";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";

describe("ESM-only d3 packages are importable under Jest", () => {
  it("d3-scale", () => {
    expect(scaleLinear().domain([0, 1]).range([0, 10])(0.5)).toBe(5);
    expect(typeof scaleTime).toBe("function");
  });

  it("d3-time", () => {
    expect(
      timeHour.floor(new Date("2026-08-01T12:34:56Z")).getUTCMinutes(),
    ).toBe(0);
  });

  it("d3-interpolate", () => {
    expect(interpolateHsl("red", "blue")(0)).toMatch(/^rgb/);
  });

  it("d3-scale-chromatic", () => {
    expect(interpolateViridis(0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("d3-sankey (and its nested d3-array/d3-shape copies)", () => {
    expect(typeof sankey).toBe("function");
    expect(typeof sankeyLinkHorizontal()).toBe("function");
  });
});
