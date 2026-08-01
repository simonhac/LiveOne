import { describe, it, expect } from "@jest/globals";
import { CHART_COLORS } from "../chart-colors";
import { IDLE_CHROME, ROLE_CHROME } from "../role-chrome";

/**
 * Enforces the tile↔series rule that `lib/role-chrome.ts` states: a tile's ICON is the exact series
 * colour, its border is that hue at -700, its tint that hue at -900/20.
 *
 * A comment used to assert this and it did not hold. Load and Hot Water matched their series exactly;
 * Solar's sun quietly sat on yellow-400 while the solar series was yellow-200, and nothing failed.
 * The mapping below is a deliberate second copy of the Tailwind values — if it agreed with the source
 * by construction it would prove nothing.
 */
const TAILWIND: Record<string, string> = {
  "text-yellow-200": "rgb(254, 240, 138)",
  "text-blue-400": "rgb(96, 165, 250)",
  "text-orange-400": "rgb(251, 146, 60)",
  "text-green-400": "rgb(74, 222, 128)",
  "text-pink-500": "rgb(236, 72, 153)",
  "text-cyan-400": "rgb(34, 211, 238)",
  "text-violet-400": "rgb(167, 139, 250)",
  "text-slate-400": "rgb(148, 163, 184)",
  "text-gray-400": "rgb(156, 163, 175)",
};

describe("tile icon colour is the exact series colour", () => {
  it.each([
    ["solar", CHART_COLORS.solar.primary],
    ["load", CHART_COLORS.load],
    ["hotWater", CHART_COLORS.hotWater],
    ["battery", CHART_COLORS.battery.main],
    ["grid", CHART_COLORS.grid.main],
    ["pool", CHART_COLORS.pool],
    ["hvac", CHART_COLORS.hvac],
  ] as const)("%s", (role, seriesColour) => {
    expect(TAILWIND[ROLE_CHROME[role].icon]).toBe(seriesColour);
  });

  it("neutral has no series and is grey", () => {
    expect(ROLE_CHROME.neutral.icon).toBe("text-slate-400");
  });

  it("idle is grey — an absence signal, not a direction", () => {
    expect(TAILWIND[IDLE_CHROME.icon]).toBe(CHART_COLORS.restOfHouse);
  });
});

describe("border and tint follow the hue of the icon", () => {
  // Derivation, not decoration: border = <hue>-700, tint = <hue>-900/20. `neutral` and `idle` are the
  // exceptions — they are chrome for tiles with no role, so they use the generic gray scale.
  it.each(
    (
      ["solar", "load", "hotWater", "battery", "grid", "pool", "hvac"] as const
    ).map((r) => [r] as const),
  )("%s", (role) => {
    const { icon, border, tint } = ROLE_CHROME[role];
    const hue = icon.replace(/^text-/, "").replace(/-\d+$/, "");
    expect(border).toBe(`border-${hue}-700`);
    expect(tint).toBe(`bg-${hue}-900/20`);
  });
});

describe("class strings stay literal", () => {
  it("so Tailwind's scanner can see them", () => {
    // Interpolation would silently drop the class from the built CSS and the tile would render
    // unstyled. Guard the shape rather than trusting review.
    for (const chrome of [...Object.values(ROLE_CHROME), IDLE_CHROME]) {
      expect(chrome.icon).toMatch(/^text-[a-z]+-\d+$/);
      expect(chrome.border).toMatch(/^border-[a-z]+-\d+$/);
      expect(chrome.tint).toMatch(/^bg-[a-z]+-\d+\/\d+$/);
    }
  });
});
