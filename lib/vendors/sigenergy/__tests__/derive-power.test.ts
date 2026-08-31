/**
 * Sigenergy power/SoC gap recovery — the arithmetic, and (more importantly) the refusals.
 *
 * The signs and the EV-inside-`powerUse` mapping are both pinned against measurements taken on prod
 * for Kutis on 2026-08-20; see the module header for the numbers. Getting either backwards is
 * invisible on a chart that is mostly near zero, so they are asserted explicitly rather than
 * implied by a round-trip.
 */
import { describe, expect, it } from "@jest/globals";
import {
  computeDerivedPowerReadings as computeRaw,
  SIGEN_DERIVED_TAILS,
  interpolateAt,
  trustedCounters,
  COUNTER_ULP_WH,
  MAX_INTERP_INTERVALS,
  type IntervalEnergyWh,
  type MeasuredSample,
  type VendorPowerSample,
} from "../derive-power";

const FIVE_MIN = 5 * 60 * 1000;
const T0 = Date.parse("2026-08-20T00:00:00Z");
const t = (n: number) => T0 + n * FIVE_MIN;

const energy = (over: Partial<IntervalEnergyWh> = {}): IntervalEnergyWh => ({
  solar: 0,
  load: 0,
  gridImport: 0,
  gridExport: 0,
  batteryCharge: 0,
  batteryDischarge: 0,
  ...over,
});

/** Nothing present anywhere — every interval is a hole. */
const noneP = () => new Map<string, Map<number, string | null>>();

/**
 * Rows the store already has, as `interval_end` → `data_quality`. `null` is a MEASURED row (the
 * raw→5m recompute writes no marker); a marker string is one this module wrote on an earlier run.
 */
const present = (
  entries: [string, number[]][],
  quality: string | null = null,
) =>
  new Map<string, Map<number, string | null>>(
    entries.map(([tail, times]) => [
      tail,
      new Map(times.map((ms) => [ms, quality])),
    ]),
  );

/** Every point exists on the device, unless a case says otherwise. */
const ALL_TAILS: ReadonlySet<string> = new Set(SIGEN_DERIVED_TAILS);

const computeDerivedPowerReadings = (
  p: Omit<Parameters<typeof computeRaw>[0], "availableTails"> & {
    availableTails?: ReadonlySet<string>;
  },
) => computeRaw({ availableTails: ALL_TAILS, ...p });

const byTail = (rs: ReturnType<typeof computeDerivedPowerReadings>) => {
  const m = new Map<string, { ms: number; v: number; q: string }[]>();
  for (const r of rs) {
    const k = r.pointMetadata.physicalPathTail;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push({ ms: r.intervalEndMs, v: r.rawValue, q: r.dataQuality });
  }
  return m;
};

describe("interpolateAt", () => {
  const samples: MeasuredSample[] = [
    { intervalEndMs: t(0), value: 10 },
    { intervalEndMs: t(4), value: 50 },
  ];

  it("interpolates linearly between the bracketing samples", () => {
    expect(interpolateAt(samples, t(1), 10 * FIVE_MIN)).toBe(20);
    expect(interpolateAt(samples, t(2), 10 * FIVE_MIN)).toBe(30);
    expect(interpolateAt(samples, t(3), 10 * FIVE_MIN)).toBe(40);
  });

  it("refuses to extrapolate off either end", () => {
    expect(interpolateAt(samples, t(-1), 10 * FIVE_MIN)).toBeNull();
    expect(interpolateAt(samples, t(9), 10 * FIVE_MIN)).toBeNull();
  });

  it("refuses when the anchors are further apart than the cap", () => {
    // A straight line across a long outage is fiction, not recovery.
    expect(interpolateAt(samples, t(2), 2 * FIVE_MIN)).toBeNull();
  });

  it("needs two anchors", () => {
    expect(interpolateAt([samples[0]], t(1), 10 * FIVE_MIN)).toBeNull();
    expect(interpolateAt([], t(1), 10 * FIVE_MIN)).toBeNull();
  });
});

describe("computeDerivedPowerReadings — calculated", () => {
  it("converts interval Wh to mean W (x12) for solar", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ solar: 500 })]]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
      }),
    );
    expect(out.get("solar_w")).toEqual([
      { ms: t(1), v: 6000, q: "calculated" },
    ]);
  });

  /** Canonical signs are INFLOW positive — the opposite of the vendor's own convention. */
  it("signs grid as + import and battery as + discharge", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(1), energy({ gridImport: 100, batteryDischarge: 250 })],
          [t(2), energy({ gridExport: 100, batteryCharge: 250 })],
        ]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
      }),
    );
    expect(out.get("grid_w")).toEqual([
      { ms: t(1), v: 1200, q: "calculated" }, // importing
      { ms: t(2), v: -1200, q: "calculated" }, // exporting
    ]);
    expect(out.get("battery_w")).toEqual([
      { ms: t(1), v: 3000, q: "calculated" }, // discharging
      { ms: t(2), v: -3000, q: "calculated" }, // charging
    ]);
  });

  it("emits nothing for a counter the vendor did not report", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(1), energy({ solar: null, gridImport: null })],
        ]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
      }),
    );
    expect(out.has("solar_w")).toBe(false);
    expect(out.has("grid_w")).toBe(false);
  });
});

describe("computeDerivedPowerReadings — the EV / rest-of-house split", () => {
  /**
   * `powerUse` is TOTAL household load, EV included (prod 2026-08-20: on >2 kW EV intervals the
   * median error against rest-of-house alone is 7060 W, against rest-of-house + ev it is 290 W).
   * So the exact quantity is the SUM, and only the split is inferred.
   */
  it("splits total load using an interpolated EV, and the two sum back to the total", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ load: 1000 })]]), // 12 000 W total
        presentByTail: noneP(),
        measuredEv: [
          { intervalEndMs: t(0), value: 7000 },
          { intervalEndMs: t(2), value: 7000 },
        ],
        measuredSoc: [],
      }),
    );
    const ev = out.get("ev_w")![0];
    const roh = out.get("load_w")![0];
    expect(ev).toEqual({ ms: t(1), v: 7000, q: "interpolated" });
    expect(roh).toEqual({ ms: t(1), v: 5000, q: "interpolated" });
    expect(ev.v + roh.v).toBe(12000);
  });

  it("leaves the split alone when the EV has no bracketing samples", () => {
    // Better a broken line than a fabricated split: total load is known, its division is not.
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ load: 1000 })]]),
        presentByTail: noneP(),
        measuredEv: [{ intervalEndMs: t(0), value: 7000 }],
        measuredSoc: [],
      }),
    );
    expect(out.has("ev_w")).toBe(false);
    expect(out.has("load_w")).toBe(false);
  });

  it("clamps the EV share to [0, total] so rest-of-house can never go negative", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ load: 100 })]]), // 1200 W total
        presentByTail: noneP(),
        measuredEv: [
          { intervalEndMs: t(0), value: 7000 },
          { intervalEndMs: t(2), value: 7000 },
        ],
        measuredSoc: [],
      }),
    );
    expect(out.get("ev_w")![0].v).toBe(1200);
    expect(out.get("load_w")![0].v).toBe(0);
  });
});

describe("computeDerivedPowerReadings — SoC", () => {
  it("interpolates a short hole", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy()]]),
        presentByTail: present([["battery_soc", [t(0), t(2)]]]),
        measuredEv: [],
        measuredSoc: [
          { intervalEndMs: t(0), value: 50 },
          { intervalEndMs: t(2), value: 60 },
        ],
      }),
    );
    expect(out.get("battery_soc")).toEqual([
      { ms: t(1), v: 55, q: "interpolated" },
    ]);
  });

  it("refuses a hole longer than the cap", () => {
    const wide = MAX_INTERP_INTERVALS + 1;
    const energyByIntervalEnd = new Map<number, IntervalEnergyWh>();
    for (let i = 1; i <= wide; i++) energyByIntervalEnd.set(t(i), energy());
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd,
        presentByTail: present([["battery_soc", [t(0), t(wide + 1)]]]),
        measuredEv: [],
        measuredSoc: [
          { intervalEndMs: t(0), value: 50 },
          { intervalEndMs: t(wide + 1), value: 90 },
        ],
      }),
    );
    expect(out.has("battery_soc")).toBe(false);
  });
});

describe("computeDerivedPowerReadings — never overwrites a measurement", () => {
  /**
   * The write path upserts at the receiver, so this filter — not the DAO's conflict clause — is
   * what protects measured data. It is the single most important property in the module.
   */
  it("emits nothing for an interval that already has a row", () => {
    const stored = present(SIGEN_DERIVED_TAILS.map((tail) => [tail, [t(1)]]));
    const out = computeDerivedPowerReadings({
      energyByIntervalEnd: new Map([
        [t(1), energy({ solar: 500, load: 1000, gridImport: 100 })],
      ]),
      presentByTail: stored,
      measuredEv: [
        { intervalEndMs: t(0), value: 7000 },
        { intervalEndMs: t(2), value: 7000 },
      ],
      measuredSoc: [
        { intervalEndMs: t(0), value: 50 },
        { intervalEndMs: t(2), value: 60 },
      ],
    });
    expect(out).toEqual([]);
  });

  it("fills only the points that are actually missing in that interval", () => {
    // Not hypothetical-only: the poll is lost as a whole, but a partially-null vendor snapshot
    // drops individual series (`buildSigenergyReadings` skips null fields).
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(1), energy({ solar: 500, gridImport: 100 })],
        ]),
        presentByTail: present([["solar_w", [t(1)]]]),
        measuredEv: [],
        measuredSoc: [],
      }),
    );
    expect(out.has("solar_w")).toBe(false);
    expect(out.get("grid_w")).toEqual([{ ms: t(1), v: 1200, q: "calculated" }]);
  });
});

/**
 * The counter guard. Sigenergy's cumulative counters drop out for a sample and repay the difference
 * later, so a raw x12 puts a several-hundred-kW spike on the chart. Over 2026-08-01..30 this took
 * the worst |derived - measured| from 323.6 kW to 5.6 kW (solar) while keeping 98% of intervals.
 */
describe("trustedCounters", () => {
  const iv = (solar: number | null): IntervalEnergyWh => ({
    solar,
    load: null,
    gridImport: null,
    gridExport: null,
    batteryCharge: null,
    batteryDischarge: null,
  });
  const run = (solars: (number | null)[]) => {
    const ordered = solars.map((v, i) => [T0 + i * FIVE_MIN, iv(v)] as const);
    const t = trustedCounters(ordered);
    return solars.map((_, i) => t.get(T0 + i * FIVE_MIN)!.has("solar"));
  };

  it("trusts a well-behaved counter", () => {
    expect(run([100, 200, 300])).toEqual([true, true, true]);
  });

  it("distrusts a dropout and the interval that repays it", () => {
    // The prod shape (2026-08-20 19:20): -26970 Wh immediately cancelled by +26970 Wh.
    expect(run([100, -26970, 26970, 100])).toEqual([true, false, false, true]);
  });

  /** The rebound is not always adjacent — the counter can stay frozen for several intervals. */
  it("stays distrustful across a multi-interval freeze until the debt is repaid", () => {
    // Prod, 2026-08-19: -10590 at 17:30, zeros through 17:55, +10590 at 18:00.
    expect(run([100, -10590, 0, 0, 0, 10590, 100])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("resumes as soon as the debt is cleared, even if repaid in pieces", () => {
    expect(run([100, -300, 100, 100, 100, 100])).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("reads a negative within one ULP as rounding, not a dropout", () => {
    // Low-volume counters flicker 0 -> 0.01 -> 0 kWh. Treating that as a dropout distrusted 49% of
    // grid intervals for what is only the 0.01 kWh reporting resolution.
    expect(run([100, -COUNTER_ULP_WH, 100])).toEqual([true, true, true]);
    expect(run([100, -COUNTER_ULP_WH - 1, 100])).toEqual([true, false, false]);
  });

  it("distrusts a counter the vendor did not report at all", () => {
    expect(run([100, null, 100])).toEqual([true, false, true]);
  });
});

describe("computeDerivedPowerReadings — points the device does not have", () => {
  /**
   * `insertPointReadingsAgg5m` MINTS a point it has not seen (`ensurePointInfo`), so emitting a
   * reading for a tail the device lacks would conjure an `ev_w` point onto a site with no charger.
   */
  it("never emits a reading for a tail the device lacks", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ solar: 500 })]]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [
          { intervalEndMs: t(0), value: 50 },
          { intervalEndMs: t(2), value: 60 },
        ],
        availableTails: new Set(["solar_w"]),
      }),
    );
    expect([...out.keys()]).toEqual(["solar_w"]);
  });

  it("gives all of total load to rest-of-house on a site with no EV, as calculated", () => {
    // Nothing to split off, so the value is exact — not an inference.
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy({ load: 1000 })]]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
        availableTails: new Set(["load_w"]),
      }),
    );
    expect(out.get("load_w")).toEqual([
      { ms: t(1), v: 12000, q: "calculated" },
    ]);
    expect(out.has("ev_w")).toBe(false);
  });
});

describe("computeDerivedPowerReadings — counter dropouts", () => {
  it("emits no power for a dropped-out interval or its repayment", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(0), energy({ solar: 300 })],
          [t(1), energy({ solar: -26970 })],
          [t(2), energy({ solar: 26970 })],
          [t(3), energy({ solar: 300 })],
        ]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
      }),
    );
    // Without the guard, t(2) would be published as 323 640 W.
    expect(out.get("solar_w")).toEqual([
      { ms: t(0), v: 3600, q: "calculated" },
      { ms: t(3), v: 3600, q: "calculated" },
    ]);
  });
});

/**
 * The vendor's own instantaneous sample, which the `statistics/energy` itemList carries alongside
 * the counters. A measurement of the interval, so it wins over every reconstruction — exact rather
 * than quantised, capped by nothing, and independent of the counters (at the 2026-08-20 19:20
 * dropout every energy counter collapsed while `loadPower` and `batSoc` stayed sane).
 */
describe("computeDerivedPowerReadings — the vendor's own sample wins", () => {
  const vp = (over: Partial<VendorPowerSample> = {}): VendorPowerSample => ({
    solarW: null,
    loadW: null,
    gridW: null,
    batteryW: null,
    socPct: null,
    ...over,
  });

  it("uses the vendor value verbatim, marked good — not calculated", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        // The counters would give 6000 W; the vendor says 5900. The vendor wins.
        energyByIntervalEnd: new Map([[t(1), energy({ solar: 500 })]]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
        vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]),
      }),
    );
    expect(out.get("solar_w")).toEqual([{ ms: t(1), v: 5900, q: "good" }]);
  });

  it("falls back to the counters for a field the payload lacks", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(1), energy({ solar: 500, gridImport: 100 })],
        ]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
        vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]), // gridW absent
      }),
    );
    expect(out.get("solar_w")![0].q).toBe("good");
    expect(out.get("grid_w")).toEqual([{ ms: t(1), v: 1200, q: "calculated" }]);
  });

  /** The whole point: the power fields are a separate failure domain from the counters. */
  it("recovers an interval the counter guard refused", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([
          [t(0), energy({ solar: 300 })],
          [t(1), energy({ solar: -26970 })], // dropout — counters unusable here
          [t(2), energy({ solar: 26970 })], // and here
        ]),
        presentByTail: noneP(),
        measuredEv: [],
        measuredSoc: [],
        vendorPower: new Map([
          [t(1), vp({ solarW: 0 })],
          [t(2), vp({ solarW: 0 })],
        ]),
      }),
    );
    // Without the vendor sample these two intervals stay empty; with it they are filled correctly
    // (the sun was down — the prod case reads 0 W while the counter claims 324 kW).
    expect(out.get("solar_w")).toEqual([
      { ms: t(0), v: 3600, q: "calculated" },
      { ms: t(1), v: 0, q: "good" },
      { ms: t(2), v: 0, q: "good" },
    ]);
  });

  it("takes SoC from the vendor rather than interpolating it", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy()]]),
        presentByTail: present([["battery_soc", [t(0), t(2)]]]),
        measuredEv: [],
        measuredSoc: [
          { intervalEndMs: t(0), value: 50 },
          { intervalEndMs: t(2), value: 60 },
        ],
        vendorPower: new Map([[t(1), vp({ socPct: 58 })]]),
      }),
    );
    // Interpolation would have said 55; the vendor recorded 58.
    expect(out.get("battery_soc")).toEqual([{ ms: t(1), v: 58, q: "good" }]);
  });

  it("still interpolates the EV split when the vendor gives only the total", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        energyByIntervalEnd: new Map([[t(1), energy()]]), // no load counter at all
        presentByTail: noneP(),
        measuredEv: [
          { intervalEndMs: t(0), value: 7000 },
          { intervalEndMs: t(2), value: 7000 },
        ],
        measuredSoc: [],
        vendorPower: new Map([[t(1), vp({ loadW: 12000 })]]),
      }),
    );
    // The total is the vendor's; only the division of it is ours.
    expect(out.get("ev_w")).toEqual([{ ms: t(1), v: 7000, q: "interpolated" }]);
    expect(out.get("load_w")).toEqual([
      { ms: t(1), v: 5000, q: "interpolated" },
    ]);
  });

  it("never overwrites a measured row, whatever the vendor says", () => {
    const out = computeDerivedPowerReadings({
      energyByIntervalEnd: new Map([[t(1), energy({ solar: 500 })]]),
      presentByTail: present(SIGEN_DERIVED_TAILS.map((tail) => [tail, [t(1)]])),
      measuredEv: [],
      measuredSoc: [],
      vendorPower: new Map([
        [
          t(1),
          vp({ solarW: 5900, loadW: 12000, gridW: 1, batteryW: 1, socPct: 9 }),
        ],
      ]),
    });
    expect(out).toEqual([]);
  });
});

/**
 * Upgrading rows this module wrote earlier.
 *
 * Keyed on presence alone, a `calculated` row would block itself from ever becoming the vendor's
 * own `good` sample — and there are already such rows on prod, written before the itemList's power
 * fields were discovered. They must be replaceable; a measurement must not be.
 */
describe("computeDerivedPowerReadings — replacing our own earlier estimates", () => {
  const vp = (over: Partial<VendorPowerSample> = {}): VendorPowerSample => ({
    solarW: null,
    loadW: null,
    gridW: null,
    batteryW: null,
    socPct: null,
    ...over,
  });
  const base = {
    energyByIntervalEnd: new Map([[t(1), energy({ solar: 500 })]]),
    measuredEv: [],
    measuredSoc: [],
  };

  it("replaces a calculated row with the vendor's measurement", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        ...base,
        presentByTail: present([["solar_w", [t(1)]]], "calculated"),
        vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]),
      }),
    );
    expect(out.get("solar_w")).toEqual([{ ms: t(1), v: 5900, q: "good" }]);
  });

  it("replaces an interpolated SoC with the vendor's measurement", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        ...base,
        presentByTail: present([["battery_soc", [t(1)]]], "interpolated"),
        vendorPower: new Map([[t(1), vp({ socPct: 58 })]]),
      }),
    );
    expect(out.get("battery_soc")).toEqual([{ ms: t(1), v: 58, q: "good" }]);
  });

  it("does NOT touch a measured row (no marker)", () => {
    const out = computeDerivedPowerReadings({
      ...base,
      presentByTail: present([["solar_w", [t(1)]]], null),
      vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]),
      availableTails: new Set(["solar_w"]),
    });
    expect(out).toEqual([]);
  });

  it("does NOT touch a marker owned by another writer", () => {
    // `estimated` is the battery-provenance/HWS marker. Unrecognised here ⇒ untouchable, which is
    // the property that keeps "upgrade my estimates" from becoming "overwrite someone's output".
    const out = computeDerivedPowerReadings({
      ...base,
      presentByTail: present([["solar_w", [t(1)]]], "estimated"),
      vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]),
      availableTails: new Set(["solar_w"]),
    });
    expect(out).toEqual([]);
  });

  it("is idempotent — an equal-quality row is not rewritten", () => {
    const out = computeDerivedPowerReadings({
      ...base,
      presentByTail: present([["solar_w", [t(1)]]], "good"),
      vendorPower: new Map([[t(1), vp({ solarW: 5900 })]]),
      availableTails: new Set(["solar_w"]),
    });
    expect(out).toEqual([]);
  });

  it("does not downgrade a good row back to calculated", () => {
    const out = computeDerivedPowerReadings({
      ...base,
      presentByTail: present([["solar_w", [t(1)]]], "good"),
      vendorPower: new Map(), // vendor fields absent this run
      availableTails: new Set(["solar_w"]),
    });
    expect(out).toEqual([]);
  });

  it("upgrades interpolated to calculated when only the counters are available", () => {
    const out = byTail(
      computeDerivedPowerReadings({
        ...base,
        presentByTail: present([["solar_w", [t(1)]]], "interpolated"),
        vendorPower: new Map(),
      }),
    );
    expect(out.get("solar_w")).toEqual([
      { ms: t(1), v: 6000, q: "calculated" },
    ]);
  });
});
