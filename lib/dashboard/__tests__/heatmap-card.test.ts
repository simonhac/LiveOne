/**
 * The `heatmap` card's pure core — the strict config schema as the v4
 * doc validator sees it, plus the pin resolution the panel and the card both go through.
 */
import { describe, it, expect } from "@jest/globals";
import { validateDocV4 } from "../v4-validate";
import { resolveHeatmapConfig, resolveHeatmapPin } from "../heatmap-card";
import { HEATMAP_PALETTE_KEYS } from "../card-types";

function docWith(config: unknown) {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [{ kind: "card", type: "heatmap", config }],
    },
  };
}

describe("heatmap config schema — through validateDocV4", () => {
  it("accepts a fully pinned card", () => {
    const r = validateDocV4(
      docWith({ series: "load.hws/temperature", palette: "turbo" }),
    );
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    // A KNOWN type: it must not fall through to the §8.4 opaque-config branch.
    expect(r.warnings).toEqual([]);
  });

  /**
   * The default card is the selector-driven one, so BOTH keys are optional and a bare node is
   * valid. This is the difference from `daily-stripe`, whose `primary` is mandatory.
   */
  it("accepts a bare card (no config at all)", () => {
    expect(validateDocV4(docWith(undefined)).valid).toBe(true);
    expect(validateDocV4(docWith({})).valid).toBe(true);
  });

  it("accepts either pin on its own", () => {
    expect(validateDocV4(docWith({ series: "load/power" })).valid).toBe(true);
    expect(validateDocV4(docWith({ palette: "greens" })).valid).toBe(true);
  });

  it("accepts every palette the render side knows", () => {
    for (const palette of HEATMAP_PALETTE_KEYS) {
      expect(validateDocV4(docWith({ palette })).valid).toBe(true);
    }
  });

  it("rejects a palette that is not one of them", () => {
    for (const palette of ["magma", "viridis2", "", "Viridis", 1, null]) {
      expect(validateDocV4(docWith({ palette })).valid).toBe(false);
    }
  });

  /**
   * 🛑 §8.3: scope lives in the node ENVELOPE (`area`/`device`), never in `config`. The schema is
   * strict, so this is enforced rather than merely documented — and it matters more here than for
   * most cards, since a heatmap is *of a device* and "put the device in the config" is the obvious
   * wrong instinct.
   */
  it("rejects scope refs smuggled into config", () => {
    for (const smuggled of [
      { device: "dv_01j4q2m000e008000000000001" },
      { area: "ar_01j4q2m000e008000000000001" },
      { systemId: 1 },
      { deviceId: "dv_x" },
    ]) {
      const r = validateDocV4(docWith({ series: "load/power", ...smuggled }));
      expect(r.valid).toBe(false);
    }
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      validateDocV4(docWith({ series: "load/power", days: 30 })).valid,
    ).toBe(false);
    expect(
      validateDocV4(docWith({ series: "load/power", showDebug: true })).valid,
    ).toBe(false);
    // A physical/point-id reference is not the vocabulary either — series is a LOGICAL path.
    expect(validateDocV4(docWith({ pointId: "pt_x" })).valid).toBe(false);
  });

  it("rejects an empty or non-string series", () => {
    expect(validateDocV4(docWith({ series: "" })).valid).toBe(false);
    expect(validateDocV4(docWith({ series: 42 })).valid).toBe(false);
    expect(validateDocV4(docWith({ series: null })).valid).toBe(false);
  });
});

describe("resolveHeatmapConfig", () => {
  it("resolves an absent config to the fully interactive card", () => {
    expect(resolveHeatmapConfig(undefined)).toEqual({});
    expect(resolveHeatmapConfig(null)).toEqual({});
    expect(resolveHeatmapConfig({})).toEqual({});
  });

  it("keeps both pins", () => {
    expect(
      resolveHeatmapConfig({ series: "load/power", palette: "plasma" }),
    ).toEqual({ series: "load/power", palette: "plasma" });
  });

  /**
   * `null` ⇒ the plugin's notice branch. Deliberately NOT a silent fall back to `{}`: a card whose
   * author pinned one series must not quietly turn into a device-wide point browser because its
   * config was written by a build this one does not understand.
   */
  it("returns null for a config the schema rejects", () => {
    expect(resolveHeatmapConfig({ palette: "magma" })).toBeNull();
    expect(resolveHeatmapConfig({ series: 1 })).toBeNull();
    expect(resolveHeatmapConfig({ series: "load/power", extra: 1 })).toBeNull();
  });
});

describe("resolveHeatmapPin", () => {
  const PATHS = ["bidi.battery/soc", "load.hws/temperature", "load/power"];

  it("with no pin, shows the selector and draws the local selection", () => {
    expect(resolveHeatmapPin(PATHS, undefined, "load/power")).toEqual({
      series: "load/power",
      showPointSelect: true,
      pinUnavailable: false,
    });
  });

  it("with no pin and nothing selected yet, draws nothing (the placeholder)", () => {
    expect(resolveHeatmapPin(PATHS, undefined, undefined)).toEqual({
      series: undefined,
      showPointSelect: true,
      pinUnavailable: false,
    });
  });

  it("honours a pin the device has, and hides the selector", () => {
    expect(
      resolveHeatmapPin(PATHS, "load.hws/temperature", "load/power"),
    ).toEqual({
      series: "load.hws/temperature",
      showPointSelect: false,
      pinUnavailable: false,
    });
  });

  /**
   * 🛑 THE EDGE CASE the doc calls out. A pin the device does not have must NOT reach the chart:
   * the selector comes back, the note goes up, and the drawn series is the local selection.
   */
  it("falls back to the selector when the pinned series is missing", () => {
    expect(
      resolveHeatmapPin(PATHS, "source.solar/power", "load/power"),
    ).toEqual({
      series: "load/power",
      showPointSelect: true,
      pinUnavailable: true,
    });
  });

  it("never returns the unavailable pin as the series to draw", () => {
    for (const selected of [undefined, "load/power"]) {
      const r = resolveHeatmapPin(PATHS, "ghost/point", selected);
      expect(r.series).not.toBe("ghost/point");
      expect(r.pinUnavailable).toBe(true);
    }
  });

  it("treats an empty point set as making every pin unavailable", () => {
    expect(resolveHeatmapPin([], "load/power", undefined)).toEqual({
      series: undefined,
      showPointSelect: true,
      pinUnavailable: true,
    });
  });

  it("matches exactly — no prefix or case leniency", () => {
    expect(resolveHeatmapPin(PATHS, "load", undefined).pinUnavailable).toBe(
      true,
    );
    expect(
      resolveHeatmapPin(PATHS, "LOAD/POWER", undefined).pinUnavailable,
    ).toBe(true);
    expect(
      resolveHeatmapPin(PATHS, "load/power.avg", undefined).pinUnavailable,
    ).toBe(true);
  });
});
