/**
 * The `daily-stripe` card's pure core — the strict config schema as
 * the v4 doc validator sees it, plus the window / OpenNEM-parse / colour-domain helpers the plugin
 * is a thin shell over.
 */
import { describe, it, expect } from "@jest/globals";
import { validateDocV4 } from "../v4-validate";
import {
  dailyStripeWindow,
  metricOf,
  parseIntervalMs,
  resolveDailyStripeConfig,
  resolveDomain,
  resolvePalette,
  seriesTermFor,
  seriesToMap,
  STRIPE_SLOT_MS,
  STRIPE_AXIS_H,
  STRIPE_DAY_GAP,
  STRIPE_PADDING_H,
  STRIPE_STATE_H,
  STRIPE_VALUE_H,
  dailyStripeFootprint,
  dailyStripeSvgHeight,
} from "../daily-stripe";
import { DAILY_STRIPE_DEFAULT_PALETTE } from "../card-types";

/** The config the card claims reproduces `/labs/kinkora-hws`. */
const HWS_CONFIG = {
  primary: { logicalPath: "load.hws/temperature" },
  state: { logicalPath: "load.hws/power", onThreshold: 100 },
  days: 7,
  color: { min: 30, max: 40, from: "hsl(210,80%,50%)", to: "hsl(0,80%,50%)" },
  unit: "°C",
  label: "Faucet",
};

function docWith(config: unknown) {
  return {
    version: 4,
    root: {
      kind: "group",
      children: [{ kind: "card", type: "daily-stripe", config }],
    },
  };
}

describe("daily-stripe config schema — through validateDocV4", () => {
  it("accepts the HWS reproduction config", () => {
    const r = validateDocV4(docWith(HWS_CONFIG));
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    // A KNOWN type: it must not fall through to the §8.4 opaque-config branch.
    expect(r.warnings).toEqual([]);
  });

  it("accepts the minimal config (primary alone)", () => {
    const r = validateDocV4(
      docWith({ primary: { logicalPath: "source.solar/power" } }),
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a missing primary", () => {
    const r = validateDocV4(docWith({ days: 3 }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("config.primary"))).toBe(true);
  });

  it("rejects an empty config", () => {
    expect(validateDocV4(docWith({})).valid).toBe(false);
    expect(validateDocV4(docWith(undefined)).valid).toBe(false);
  });

  /**
   * 🛑 §8.3: scope lives in the node ENVELOPE (`area`/`device`), never in `config`. The schema is
   * strict, so this is enforced rather than merely documented.
   */
  it("rejects scope refs smuggled into config", () => {
    for (const smuggled of [
      { area: "ar_01j4q2m000e008000000000001" },
      { device: "dv_01j4q2m000e008000000000001" },
      { systemId: 1 },
      { areaId: "x" },
    ]) {
      const r = validateDocV4(
        docWith({ primary: { logicalPath: "load/power" }, ...smuggled }),
      );
      expect(r.valid).toBe(false);
    }
  });

  it("rejects unknown keys anywhere (strict at every level)", () => {
    expect(
      validateDocV4(
        docWith({ primary: { logicalPath: "load/power", pointId: "pt_x" } }),
      ).valid,
    ).toBe(false);
    expect(
      validateDocV4(
        docWith({
          primary: { logicalPath: "load/power" },
          color: { from: "#000", to: "#fff", gamma: 2 },
        }),
      ).valid,
    ).toBe(false);
  });

  it("caps days at the 5m history window (1..7, integer)", () => {
    for (const days of [1, 7]) {
      expect(
        validateDocV4(docWith({ primary: { logicalPath: "load/power" }, days }))
          .valid,
      ).toBe(true);
    }
    for (const days of [0, 8, 1.5, -1]) {
      expect(
        validateDocV4(docWith({ primary: { logicalPath: "load/power" }, days }))
          .valid,
      ).toBe(false);
    }
  });

  it("requires both ends of the ramp when `color` is given", () => {
    expect(
      validateDocV4(
        docWith({
          primary: { logicalPath: "load/power" },
          color: { min: 30, max: 40 },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateDocV4(
        docWith({
          primary: { logicalPath: "load/power" },
          color: { from: "#000", to: "#fff" },
        }),
      ).valid,
    ).toBe(true);
  });

  it("rejects an unknown aggregation", () => {
    expect(
      validateDocV4(
        docWith({ primary: { logicalPath: "load/power", agg: "median" } }),
      ).valid,
    ).toBe(false);
    expect(
      validateDocV4(
        docWith({ primary: { logicalPath: "load/power", agg: "delta" } }),
      ).valid,
    ).toBe(true);
  });

  it("rejects an empty logicalPath", () => {
    expect(validateDocV4(docWith({ primary: { logicalPath: "" } })).valid).toBe(
      false,
    );
  });
});

describe("resolveDailyStripeConfig", () => {
  it("applies the schema defaults", () => {
    const c = resolveDailyStripeConfig({
      primary: { logicalPath: "load/power" },
      state: { logicalPath: "load.hws/power" },
    });
    expect(c?.days).toBe(7);
    expect(c?.state?.onThreshold).toBe(0);
  });

  it("keeps explicit values", () => {
    const c = resolveDailyStripeConfig(HWS_CONFIG);
    expect(c?.days).toBe(7);
    expect(c?.state?.onThreshold).toBe(100);
    expect(c?.color).toEqual({
      min: 30,
      max: 40,
      from: "hsl(210,80%,50%)",
      to: "hsl(0,80%,50%)",
    });
  });

  it("returns null for a config the schema rejects (the plugin's notice branch)", () => {
    expect(resolveDailyStripeConfig({})).toBeNull();
    expect(resolveDailyStripeConfig(null)).toBeNull();
    expect(
      resolveDailyStripeConfig({ primary: { logicalPath: 1 } }),
    ).toBeNull();
  });
});

describe("seriesTermFor / metricOf", () => {
  it("splits the metric off a logical path", () => {
    expect(metricOf("load.hws/temperature")).toBe("temperature");
    expect(metricOf("bidi.battery/soc")).toBe("soc");
    expect(metricOf("nometric")).toBe("");
  });

  it("uses the metric's preferred aggregation by default", () => {
    expect(seriesTermFor({ logicalPath: "load.hws/temperature" })).toBe(
      "load.hws/temperature.avg",
    );
    expect(seriesTermFor({ logicalPath: "source.solar/power" })).toBe(
      "source.solar/power.avg",
    );
    expect(seriesTermFor({ logicalPath: "bidi.battery/soc" })).toBe(
      "bidi.battery/soc.last",
    );
    expect(seriesTermFor({ logicalPath: "source.solar/energy" })).toBe(
      "source.solar/energy.delta",
    );
  });

  it("lets config pin the aggregation", () => {
    expect(seriesTermFor({ logicalPath: "bidi.battery/soc", agg: "avg" })).toBe(
      "bidi.battery/soc.avg",
    );
  });
});

describe("dailyStripeWindow", () => {
  const TZ = 600; // +10:00, the fixed offset the HWS lab uses
  const NOW = Date.parse("2026-07-31T04:07:30.000Z"); // 14:07:30 local

  it("starts at the oldest local midnight and ends at now, floored to 5m", () => {
    const w = dailyStripeWindow(NOW, TZ, 7);
    expect(new Date(w.firstDayMidnightMs).toISOString()).toBe(
      "2026-07-24T14:00:00.000Z", // 25 Jul 00:00 local, 7 days back inclusive of today
    );
    expect(new Date(w.endMs).toISOString()).toBe("2026-07-31T04:05:00.000Z");
    expect(w.dayCount).toBe(7);
  });

  it("keeps the whole window inside the 5m history limit (7.5 days)", () => {
    const w = dailyStripeWindow(NOW, TZ, 7);
    expect(w.endMs - w.firstDayMidnightMs).toBeLessThanOrEqual(
      7.5 * 24 * 60 * 60 * 1000,
    );
  });

  it("aligns both bounds to a 5m boundary (an unaligned bound is a 400)", () => {
    for (const tz of [600, 570, 480, -300, 0]) {
      const w = dailyStripeWindow(NOW, tz, 5);
      expect(w.firstDayMidnightMs % STRIPE_SLOT_MS).toBe(0);
      expect(w.endMs % STRIPE_SLOT_MS).toBe(0);
    }
  });

  it("never returns an empty window (days=1 exactly at local midnight)", () => {
    const midnight = Date.parse("2026-07-30T14:00:00.000Z");
    const w = dailyStripeWindow(midnight, TZ, 1);
    expect(w.firstDayMidnightMs).toBe(midnight);
    expect(w.endMs).toBe(midnight + STRIPE_SLOT_MS);
  });

  it("honours a shorter day count", () => {
    const w = dailyStripeWindow(NOW, TZ, 2);
    expect(new Date(w.firstDayMidnightMs).toISOString()).toBe(
      "2026-07-29T14:00:00.000Z",
    );
    expect(w.dayCount).toBe(2);
  });
});

describe("parseIntervalMs", () => {
  it("parses the served interval strings", () => {
    expect(parseIntervalMs("5m")).toBe(300_000);
    expect(parseIntervalMs("30m")).toBe(1_800_000);
    expect(parseIntervalMs("1d")).toBe(86_400_000);
    expect(parseIntervalMs("")).toBe(0);
    expect(parseIntervalMs("weekly")).toBe(0);
  });
});

describe("seriesToMap", () => {
  const payload = {
    data: [
      {
        id: "liveone.1.load.hws.temperature.avg",
        path: "load.hws/temperature.avg",
        history: {
          firstInterval: "2026-07-31T00:00:00Z",
          interval: "5m",
          data: [30, null, 32.5, 33],
        },
      },
      {
        id: "liveone.1.load.hws.power.avg",
        history: {
          firstInterval: "2026-07-31T00:00:00Z",
          interval: "5m",
          data: [0, 3600],
        },
      },
    ],
  };
  const t0 = Date.parse("2026-07-31T00:00:00Z");

  it("keys on intervalEndMs = firstIntervalMs + i * intervalMs", () => {
    const m = seriesToMap(payload, "load.hws/temperature.avg");
    expect(m.get(t0)).toBe(30);
    expect(m.get(t0 + 2 * STRIPE_SLOT_MS)).toBe(32.5);
    expect(m.get(t0 + 3 * STRIPE_SLOT_MS)).toBe(33);
  });

  /**
   * The served array is DENSE (a gap is a `null`), but `DailyStripes` reads "the map has this key"
   * as "the device reported something" — so keeping the nulls would paint the no-data grey straight
   * across every outage instead of leaving the background.
   */
  it("skips nulls so a real gap stays ABSENT, not present-with-no-value", () => {
    const m = seriesToMap(payload, "load.hws/temperature.avg");
    expect(m.has(t0 + STRIPE_SLOT_MS)).toBe(false);
    expect(m.size).toBe(3);
  });

  it("falls back to the series id when `path` is absent", () => {
    const m = seriesToMap(payload, "load.hws.power.avg");
    expect(m.get(t0 + STRIPE_SLOT_MS)).toBe(3600);
  });

  it("returns an empty map for a series the payload does not carry", () => {
    expect(seriesToMap(payload, "source.solar/power.avg").size).toBe(0);
    expect(seriesToMap(undefined, "x").size).toBe(0);
    expect(seriesToMap({ data: [] }, "x").size).toBe(0);
  });

  it("returns an empty map on an unusable history block", () => {
    expect(
      seriesToMap(
        {
          data: [
            {
              path: "a",
              history: { firstInterval: "nonsense", interval: "5m", data: [1] },
            },
          ],
        },
        "a",
      ).size,
    ).toBe(0);
    expect(
      seriesToMap(
        {
          data: [
            {
              path: "a",
              history: {
                firstInterval: "2026-07-31T00:00:00Z",
                interval: "?",
                data: [1],
              },
            },
          ],
        },
        "a",
      ).size,
    ).toBe(0);
  });
});

describe("resolveDomain / resolvePalette", () => {
  const values = new Map<number, number | null>([
    [1, 12],
    [2, null],
    [3, 40],
    [4, 25],
  ]);

  it("takes both ends from config when pinned", () => {
    expect(resolveDomain(values, 30, 40)).toEqual([30, 40]);
  });

  it("derives an unpinned end from the non-null values", () => {
    expect(resolveDomain(values)).toEqual([12, 40]);
    expect(resolveDomain(values, 0)).toEqual([0, 40]);
    expect(resolveDomain(values, undefined, 100)).toEqual([12, 100]);
  });

  it("falls back to [0, 1] with no data at all", () => {
    expect(resolveDomain(new Map())).toEqual([0, 1]);
    expect(
      resolveDomain(
        new Map<number, number | null>([
          [1, null],
          [2, null],
        ]),
      ),
    ).toEqual([0, 1]);
    // A pinned end still wins over the fallback.
    expect(resolveDomain(new Map(), 30)).toEqual([30, 1]);
  });

  it("uses the inline default ramp when config carries no colour", () => {
    expect(resolvePalette(undefined)).toEqual([
      DAILY_STRIPE_DEFAULT_PALETTE[0],
      DAILY_STRIPE_DEFAULT_PALETTE[1],
    ]);
    expect(resolvePalette({ from: "#000", to: "#fff" })).toEqual([
      "#000",
      "#fff",
    ]);
  });
});

/**
 * The stripe is the one card whose exact settled height is knowable from its CONFIG — it is
 * `days` rows tall whatever the history contains — so its placeholder can be exact rather than
 * approximate. These pin the geometry the plugin's `footprint` and `<DailyStripes>` both read, so
 * the reservation and the thing it reserves for cannot drift apart.
 */
describe("stripe geometry", () => {
  it("is an axis, N day rows, and the gaps between them", () => {
    expect(dailyStripeSvgHeight(1, false)).toBe(STRIPE_AXIS_H + STRIPE_VALUE_H);
    expect(dailyStripeSvgHeight(7, false)).toBe(
      STRIPE_AXIS_H + 7 * STRIPE_VALUE_H + 6 * STRIPE_DAY_GAP,
    );
  });

  it("adds the on/off strip per day only when a state series is bound", () => {
    expect(dailyStripeSvgHeight(7, true) - dailyStripeSvgHeight(7, false)).toBe(
      7 * STRIPE_STATE_H,
    );
  });

  it("grows with the configured day count", () => {
    const three = dailyStripeFootprint(
      resolveDailyStripeConfig({
        primary: { logicalPath: "load.hws/temperature" },
        days: 3,
      }),
    );
    const seven = dailyStripeFootprint(
      resolveDailyStripeConfig({
        primary: { logicalPath: "load.hws/temperature" },
        days: 7,
      }),
    );
    expect(seven).toBeGreaterThan(three);
    expect(three).toBe(STRIPE_PADDING_H + dailyStripeSvgHeight(3, false));
  });

  it("falls back to the schema's own 7-day default for an unparseable config", () => {
    expect(resolveDailyStripeConfig({ nope: true })).toBeNull();
    expect(dailyStripeFootprint(null)).toBe(
      STRIPE_PADDING_H + dailyStripeSvgHeight(7, false),
    );
  });
});
