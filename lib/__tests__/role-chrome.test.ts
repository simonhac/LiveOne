import { describe, it, expect } from "@jest/globals";
import { CHART_COLORS } from "../chart-colors";
import { IDLE_CHROME, ROLE_CHROME } from "../role-chrome";

/**
 * Enforces the tile↔series rule that `lib/role-chrome.ts` states: a tile's VALUE colour is the exact
 * series colour, and its `rgb` (what rings and bars are drawn in) is that same colour.
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
  "text-red-600": "rgb(220, 38, 38)",
};

const ROLES = [
  ["solar", CHART_COLORS.solar.primary],
  ["load", CHART_COLORS.load],
  ["hotWater", CHART_COLORS.hotWater],
  ["battery", CHART_COLORS.battery.main],
  ["grid", CHART_COLORS.grid.main],
  ["pool", CHART_COLORS.pool],
  ["hvac", CHART_COLORS.hvac],
  ["ev", CHART_COLORS.ev],
] as const;

describe("tile value colour is the exact series colour", () => {
  it.each(ROLES)("%s", (role, seriesColour) => {
    expect(TAILWIND[ROLE_CHROME[role].value]).toBe(seriesColour);
    expect(ROLE_CHROME[role].rgb).toBe(seriesColour);
  });

  it("neutral has no series and no colour", () => {
    expect(ROLE_CHROME.neutral.value).toBe("text-white");
  });

  it("idle is a dimmed white — an absence signal, not a direction", () => {
    expect(IDLE_CHROME.value).toBe("text-white/40");
  });
});

describe("colour is data, never chrome", () => {
  it("no role carries a border or a background", () => {
    for (const chrome of [...Object.values(ROLE_CHROME), IDLE_CHROME]) {
      expect(Object.keys(chrome).sort()).toEqual(["rgb", "value"]);
    }
  });
});

describe("class strings stay literal", () => {
  it("so Tailwind's scanner can see them", () => {
    // Interpolation would silently drop the class from the built CSS and the tile would render
    // unstyled. Guard the shape rather than trusting review.
    for (const chrome of [...Object.values(ROLE_CHROME), IDLE_CHROME]) {
      expect(chrome.value).toMatch(/^text-[a-z]+(-\d+)?(\/\d+)?$/);
    }
  });
});
