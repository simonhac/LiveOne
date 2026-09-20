/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenewablesSummary } from "@/lib/renewables/summary";

// `next/font/local` is evaluated by Next's compiler, not at runtime — same stub as
// v4-render-props.test.ts. Must precede the component import, hence `require` below.
jest.mock("next/font/local", () => ({
  __esModule: true,
  default: () => ({
    className: "f",
    style: { fontFamily: "f" },
    variable: "--f",
  }),
}));

const HomeEnergyCard = require("@/components/HomeEnergyCard")
  .default as typeof import("@/components/HomeEnergyCard").default;

/**
 * The Home Energy footer caption, pinned as TEXT and as MARKUP.
 *
 * The order is a reading decision, not an implementation detail: energy first, then each total
 * beside the rate it came from ($ with ¢/kWh, kg CO₂ with g/kWh). It had drifted into
 * energy · rate · intensity · $ · kg, which separates both pairs.
 *
 * The MARKUP half matters just as much, and is the reason this is a render test rather than a
 * string test. Every part has to go through `<Value>` so its unit lands in a `data-unit` span —
 * that is what `TILE_CAPTION_UNITS_DIM` selects on to set the units a step quieter than the
 * numbers. `$0.21` and `4.9 kg CO₂` used to be plain interpolated strings, and would have sat at
 * full brightness while everything around them dimmed, with no test able to tell.
 *
 * Lives under lib/ because jest's `roots` are lib/app/scripts/packages — there is no components/
 * root (see jest.config). React is built with `createElement` for the same reason: the suite
 * matches `*.test.ts`, not `.tsx`.
 */

const SUMMARY = {
  consumptionKwh: 63.4,
  costC: 21,
  emissionsG: 4900,
  avgCentsPerKwh: 0.33,
  avgGramsPerKwh: 77,
  metrics: {
    renewableShare: 0.96,
    ownRenewableSelfConsumption: 0.96,
    renewableAutarky: 0.85,
  },
} as RenewablesSummary;

function render(summary: RenewablesSummary | null, loading = false): string {
  return renderToStaticMarkup(
    React.createElement(HomeEnergyCard, {
      summary,
      periodLabel: "24 hours",
      loading,
    }),
  );
}

/** Markup → the text a reader sees. */
function caption(html: string): string {
  const p = html.match(/<p class="mt-3[^"]*">([\s\S]*?)<\/p>/);
  if (!p) throw new Error("no caption paragraph in the rendered card");
  return p[1]
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unitSpans(html: string): string[] {
  const p = html.match(/<p class="mt-3[^"]*">([\s\S]*?)<\/p>/)![1];
  return [...p.matchAll(/<span data-unit=""[^>]*>(.*?)<\/span>/g)].map(
    (m) => m[1],
  );
}

describe("Home Energy caption", () => {
  it("reads energy · cost · rate · carbon · intensity", () => {
    expect(caption(render(SUMMARY))).toBe(
      "63.4kWh · $0.21 · 0.3¢/kWh · 4.9kg CO₂ · 77g/kWh",
    );
  });

  it("says no more than the numbers — the old line ended in a stray 'used'", () => {
    expect(caption(render(SUMMARY))).not.toContain("used");
  });

  it("marks every unit as a unit, so they dim together", () => {
    // `¢/kWh` and `g/kWh` each split head/tail per `classifyUnit`, hence six spans for four units.
    expect(unitSpans(render(SUMMARY))).toEqual([
      "kWh",
      "¢",
      "/kWh",
      "kg CO₂",
      "g",
      "/kWh",
    ]);
  });

  it("carries the dim-units token on the caption, not on one item", () => {
    expect(render(SUMMARY)).toContain(
      "[&amp;_[data-unit]]:!text-tile-ink-idle",
    );
  });

  it("switches carbon to grams under 1 kg, unit and all", () => {
    expect(caption(render({ ...SUMMARY, emissionsG: 497 }))).toContain(
      "497g CO₂",
    );
  });

  it("spells a negative cost with a real minus, fused to the $", () => {
    expect(caption(render({ ...SUMMARY, costC: -21 }))).toContain("−$0.21");
  });

  it("renders the skeleton's placeholder in the SAME order, so the line cannot resize", () => {
    expect(caption(render(null, true))).toBe(
      "000 kWh · $00.00 · 00¢/kWh · 00 kg CO₂ · 000 g/kWh",
    );
  });
});
