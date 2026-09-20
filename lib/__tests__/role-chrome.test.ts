import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHART_COLORS } from "../chart-colors";
import { IDLE_CHROME, ROLE_CHROME } from "../role-chrome";

/**
 * Enforces the tile↔series rule that `lib/role-chrome.ts` states: a tile's VALUE colour is the exact
 * series colour, and its `rgb` (what rings and bars are drawn in) is that same colour.
 *
 * A comment used to assert this and it did not hold. Load and Hot Water matched their series exactly;
 * Solar's sun quietly sat on yellow-400 while the solar series was yellow-200, and nothing failed.
 *
 * 🛑 THE SECOND COPY IS NOW THE SHIPPED CSS, AND THAT MATTERS. This file used to carry a hand-written
 * `class -> rgb` table, on the reasoning that a mapping derived from the source would prove nothing.
 * True, but the table was a Tailwind **v3** table, and v4's palette is `oklch` — so while the roles
 * sat on `text-green-400` the test compared a stale table against itself and passed, and the tile's
 * number rendered a visibly different green from its own ring on every P3 display. Reading
 * `app/globals.css` keeps the property the table was for (two independently-authored files must
 * agree) while making the thing it compares the thing that actually renders.
 */
const TOKENS = new Map<string, string>(
  [
    ...readFileSync(
      path.join(__dirname, "..", "..", "app", "globals.css"),
      "utf8",
    ).matchAll(/^\s*--color-([a-z0-9-]+):\s*([^;]+);/gm),
  ].map((m) => [
    `text-${m[1]}`,
    // Prettier may reflow a long declaration across lines — compare the value, not its formatting.
    m[2]
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .trim(),
  ]),
);

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
    expect(TOKENS.get(ROLE_CHROME[role].value)).toBe(seriesColour);
    expect(ROLE_CHROME[role].rgb).toBe(seriesColour);
  });

  it("neutral has no series and no colour", () => {
    expect(ROLE_CHROME.neutral.value).toBe("text-ink");
    expect(TOKENS.get("text-ink")).toBe("#fff");
  });

  it("idle is a dimmed white — an absence signal, not a direction", () => {
    expect(IDLE_CHROME.value).toBe("text-tile-ink-idle");
    // The class and the `rgb` are the same 40% white, spelled for CSS and for SVG.
    expect(TOKENS.get("text-tile-ink-idle")).toBe("rgb(255 255 255 / 0.4)");
    expect(IDLE_CHROME.rgb).toBe("rgba(255, 255, 255, 0.4)");
  });

  it("every role class is a token this stylesheet actually defines", () => {
    for (const chrome of [...Object.values(ROLE_CHROME), IDLE_CHROME]) {
      expect(TOKENS.has(chrome.value)).toBe(true);
    }
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
      expect(chrome.value).toMatch(/^text-[a-z][a-z0-9-]*$/);
    }
  });
});
