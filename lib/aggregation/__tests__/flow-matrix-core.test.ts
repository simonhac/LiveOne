import { describe, it, expect } from "@jest/globals";
import {
  computeFlowMatrix,
  computeFlowAccounting,
  computeInstantFlowMatrix,
  FlowSeries,
  FlowMatrixResult,
} from "../flow-matrix-core";

const HOUR = 60 * 60 * 1000;

/** Build ascending epoch-ms timestamps `count` hours apart from an arbitrary base. */
function hours(count: number): number[] {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: count }, (_, i) => base + i * HOUR);
}

function idx(
  result: FlowMatrixResult,
  path: string,
  axis: "sources" | "loads",
) {
  return result[axis].indexOf(path);
}

function cell(result: FlowMatrixResult, sourcePath: string, loadPath: string) {
  return result.matrix[idx(result, sourcePath, "sources")][
    idx(result, loadPath, "loads")
  ];
}

describe("computeFlowMatrix", () => {
  it("integrates a single source feeding a single load (1 kW, 1 h → 1 kWh)", () => {
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [{ path: "source.solar", power: [1, 1] }],
      loads: [{ path: "load", power: [1, 1] }],
    });
    expect(cell(result, "source.solar", "load")).toBeCloseTo(1, 6);
    expect(result.totalEnergy).toBeCloseTo(1, 6);
    expect(result.intervalsUsed).toBe(1);
  });

  it("represents a bidirectional battery as BOTH a charge-load and a discharge-source", () => {
    // Charge phase: solar 10 kW serves 6 kW house AND charges the battery at 4 kW for 1 h.
    const charge = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [10, 10] },
        { path: "source.battery", power: [0, 0] }, // discharge (>=0)
      ],
      loads: [
        { path: "load", power: [6, 6] },
        { path: "load.battery", power: [4, 4] }, // charge (>=0)
      ],
    });
    // Charging lands as solar -> load.battery (battery acting as a LOAD).
    expect(cell(charge, "source.solar", "load.battery")).toBeCloseTo(4, 6);
    expect(cell(charge, "source.solar", "load")).toBeCloseTo(6, 6);
    expect(cell(charge, "source.battery", "load.battery")).toBeCloseTo(0, 6);

    // Discharge phase: no solar; battery discharges 3 kW to serve a 3 kW house for 1 h.
    const discharge = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [0, 0] },
        { path: "source.battery", power: [3, 3] },
      ],
      loads: [
        { path: "load", power: [3, 3] },
        { path: "load.battery", power: [0, 0] },
      ],
    });
    // Discharging lands as source.battery -> load (battery acting as a SOURCE).
    expect(cell(discharge, "source.battery", "load")).toBeCloseTo(3, 6);
    expect(cell(discharge, "source.solar", "load")).toBeCloseTo(0, 6);

    // The naive 30D bug averages the day's signed battery power to ~net-zero, so the
    // split would yield 0 charge AND 0 discharge. Integrating per-interval keeps both:
    // charge 4 kWh (as a load) and discharge 3 kWh (as a source) are each preserved.
    expect(
      cell(charge, "source.solar", "load.battery") +
        cell(discharge, "source.battery", "load"),
    ).toBeGreaterThan(0);
  });

  it("is additive: Σ(sub-window matrices) == full-window matrix (monthly = Σ daily)", () => {
    // A varying day; split the interval set at an interior timestamp and assert the
    // element-wise sum of the two sub-window matrices equals the whole-window matrix.
    const ts = hours(5);
    const sources: FlowSeries[] = [
      { path: "source.solar", power: [2, 4, 6, 3, 1] },
      { path: "source.battery", power: [1, 0, 2, 4, 5] },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: [2, 3, 5, 6, 4] },
      { path: "load.battery", power: [1, 1, 0, 0, 2] },
    ];

    const full = computeFlowMatrix({ timestamps: ts, sources, loads });

    const split = 2; // boundary index shared by both windows
    const sliceTo = (s: FlowSeries) => ({
      path: s.path,
      power: s.power.slice(0, split + 1),
    });
    const sliceFrom = (s: FlowSeries) => ({
      path: s.path,
      power: s.power.slice(split),
    });
    const a = computeFlowMatrix({
      timestamps: ts.slice(0, split + 1),
      sources: sources.map(sliceTo),
      loads: loads.map(sliceTo),
    });
    const b = computeFlowMatrix({
      timestamps: ts.slice(split),
      sources: sources.map(sliceFrom),
      loads: loads.map(sliceFrom),
    });

    for (let s = 0; s < sources.length; s++) {
      for (let l = 0; l < loads.length; l++) {
        expect(a.matrix[s][l] + b.matrix[s][l]).toBeCloseTo(
          full.matrix[s][l],
          9,
        );
      }
    }
    expect(a.totalEnergy + b.totalEnergy).toBeCloseTo(full.totalEnergy, 9);
  });

  it("drops intervals with no generation (totalGen<=0) — documents the night/grid-only edge", () => {
    // No source power in the only interval → load energy is not allocated anywhere.
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [{ path: "source.solar", power: [0, 0] }],
      loads: [{ path: "load", power: [1, 1] }],
    });
    expect(result.totalEnergy).toBeCloseTo(0, 6);
    expect(result.intervalsUsed).toBe(0);
  });

  it("allocates on the LEFT endpoint when a source's right endpoint is null, and drops only the interval where it has no datum", () => {
    const result = computeFlowMatrix({
      timestamps: hours(3),
      sources: [{ path: "source.solar", power: [1, null, 1] }],
      loads: [{ path: "load", power: [1, 1, 1] }],
    });
    // Interval 0: solar's right endpoint is missing but its LEFT one is not — the same datum that
    // puts it in the pool the load's energy is divided by — so the load's 1 kWh is attributed to it
    // in full. Requiring both endpoints here (and only here) would have deleted that kWh outright.
    expect(cell(result, "source.solar", "load")).toBeCloseTo(1, 6);
    // Interval 1: solar has NO datum at the left endpoint, so the pool is empty and there is nothing
    // to attribute to — dropped by the totalGen<=0 guard, unchanged.
    expect(result.totalEnergy).toBeCloseTo(1, 6);
    expect(result.intervalsUsed).toBe(1);
  });

  it("conserves a load's energy when only SOME sources have a right endpoint (regression: Kinkora 2026-01-27)", () => {
    // The real interval, 2026-01-27 11:10–11:15 local: both solar points dropped their 11:15 sample
    // while the grid kept both, and the EV metered 0.598 kWh. The numerator used to require BOTH
    // endpoints while the denominator required only the left one, so solar stayed in the 19.250064 kW
    // pool but received no edge — and 1 − 7.081758/19.250064 = 63.2% of the EV's energy, 0.378 kWh,
    // was allocated to nothing at all and vanished from the day's matrix.
    const local = 6.290488;
    const remote = 5.877818;
    const grid = 7.081758;
    const pool = local + remote + grid;
    const evKwh = 0.598;
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar.local", power: [local, null] },
        { path: "source.solar.remote", power: [remote, null] },
        { path: "source.grid", power: [grid, grid] },
      ],
      loads: [{ path: "load.ev", power: [7.176, 7.176], energyKwh: [evKwh] }],
    });
    // The whole metered energy is allocated — the invariant the asymmetry broke.
    expect(result.loadTotals[idx(result, "load.ev", "loads")]).toBeCloseTo(
      evKwh,
      9,
    );
    // ...split on the left-endpoint shares, solar included.
    expect(cell(result, "source.grid", "load.ev")).toBeCloseTo(
      evKwh * (grid / pool),
      9,
    );
    expect(cell(result, "source.solar.local", "load.ev")).toBeCloseTo(
      evKwh * (local / pool),
      9,
    );
    expect(cell(result, "source.solar.remote", "load.ev")).toBeCloseTo(
      evKwh * (remote / pool),
      9,
    );
  });

  it("never allocates a source to its own linked load — mid-interval discharge→charge flip, redistributed to another source", () => {
    // Battery discharges 3 kW at t0, flips to charging 2 kW by t1 — impossible for a single raw
    // sample (splitSignedSeries is mutually exclusive per-sample) but routine ACROSS a 5-min
    // interval boundary. Solar is also generating throughout, so the flip interval's load.battery
    // energy must land on solar, never on source.battery (a battery can't charge itself).
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [4, 4] },
        { path: "source.battery", power: [3, 0] }, // discharging at t0, stopped by t1
      ],
      loads: [
        { path: "load", power: [7, 7] },
        { path: "load.battery", power: [0, 2] }, // starts charging by t1
      ],
    });
    expect(cell(result, "source.battery", "load.battery")).toBe(0);
    expect(cell(result, "source.solar", "load.battery")).toBeCloseTo(1, 6);
    // Conservation: load.battery's own trapezoidal energy (1 kWh) is fully attributed, just to
    // solar instead of split with (or given to) the battery itself.
    expect(result.loadTotals[idx(result, "load.battery", "loads")]).toBeCloseTo(
      1,
      6,
    );
  });

  it("drops (does not misattribute) a flip interval's load energy when no other source is active", () => {
    // Battery is the ONLY source at the flip; nothing else to attribute load.battery's energy to.
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [{ path: "source.battery", power: [3, 0] }],
      loads: [
        { path: "load", power: [0, 0] },
        { path: "load.battery", power: [0, 2] },
      ],
    });
    expect(cell(result, "source.battery", "load.battery")).toBe(0);
    // Dropped, not misattributed — the interval is excluded from intervalsUsed too (no source
    // could validly claim it, distinct from "no generation at all" which totalGenPower already
    // handles).
    expect(result.totalEnergy).toBeCloseTo(0, 6);
  });

  it("applies the same self-supply exclusion to grid import/export", () => {
    const result = computeFlowMatrix({
      timestamps: hours(2),
      sources: [
        { path: "source.solar", power: [5, 5] },
        { path: "source.grid", power: [2, 0] }, // importing at t0, flips to export by t1
      ],
      loads: [
        { path: "load", power: [7, 7] },
        { path: "load.grid", power: [0, 1] }, // exporting by t1
      ],
    });
    expect(cell(result, "source.grid", "load.grid")).toBe(0);
    expect(cell(result, "source.solar", "load.grid")).toBeCloseTo(0.5, 6);
  });
});

describe("computeInstantFlowMatrix", () => {
  it("never allocates a source to its own linked load at a single sample", () => {
    // Structurally already impossible from a real signed-series split (proven in flow-matrix-core.ts's
    // channelId exclusion), but assert it directly for the defense-in-depth path too.
    const result = computeInstantFlowMatrix({
      sources: [
        { path: "source.solar", power: [4] },
        { path: "source.battery", power: [3] },
      ],
      loads: [
        { path: "load", power: [7] },
        { path: "load.battery", power: [0] },
      ],
      index: 0,
    });
    expect(cell(result, "source.battery", "load.battery")).toBe(0);
  });
});

/**
 * The per-day `window` slice (used by the flow_attr_1d rollup writer) must integrate a day EXACTLY like
 * integrating that day's own interval set in isolation, and consecutive days must TILE — no hole at the
 * midnight seam, so a month is the plain sum of its days. Two regressions these guard:
 *  - a gap-/midnight-spanning interval attributed WHOLLY to the later day because only its END was
 *    checked (Bug B);
 *  - the day's FIRST interval, (00:00, 00:05], dropped from every day because an interval-END range
 *    (`dayToUnixRangeForAggregation`, which starts at 00:05) was passed to this SPAN filter — the
 *    flow_attr_1d v6 fix.
 *
 * The window bounds are therefore SPANS: local midnight → next local midnight.
 */
describe("computeFlowAccounting per-day window == isolated per-day integration", () => {
  const D1 = Date.parse("2026-01-01T00:00:00Z");
  const DAY = 24 * HOUR;
  const FIVE_MIN = 5 * 60 * 1000;
  // The attribution window for the local day starting at `midnightMs`, as interval SPANS: an interval
  // belongs to the day when it starts at/after this midnight and ends at/before the next.
  const dayWindow = (midnightMs: number) => ({
    startMs: midnightMs,
    endMs: midnightMs + DAY,
  });
  const grid = (ts: number[], kw: number): FlowSeries[] => [
    { path: "source.grid", power: ts.map(() => kw) },
  ];
  const load = (ts: number[], kw: number): FlowSeries[] => [
    { path: "load", power: ts.map(() => kw) },
  ];
  // The day's own interval set, integrated alone: every sample from its opening midnight (which opens
  // the first interval) through its closing one.
  const isolate = (ts: number[], w: { startMs: number; endMs: number }) =>
    ts.filter((t) => t >= w.startMs && t <= w.endMs);

  it("drops a gap/midnight-spanning interval from the later day (Bug B)", () => {
    const win2 = dayWindow(D1 + DAY); // 2026-01-02
    // Day-1 tail 21:00, 22:00; a GAP across midnight; day-2 first samples 08:00, 09:00.
    const fullTs = [
      D1 + 21 * HOUR,
      D1 + 22 * HOUR,
      D1 + DAY + 8 * HOUR,
      D1 + DAY + 9 * HOUR,
    ];
    const modern = computeFlowAccounting({
      timestamps: fullTs,
      sources: grid(fullTs, 2),
      loads: load(fullTs, 2),
      window: win2,
    });
    const isoTs = isolate(fullTs, win2); // [08:00, 09:00]
    const isolated = computeFlowMatrix({
      timestamps: isoTs,
      sources: grid(isoTs, 2),
      loads: load(isoTs, 2),
    });
    // Only the 08:00→09:00 interval (2 kW × 1 h = 2 kWh) belongs to day 2. The 22:00→08:00 gap interval
    // (2 kW × 10 h = 20 kWh) spans midnight and belongs to NEITHER isolated day — it must not appear.
    // It still starts BEFORE midnight, so the span bound keeps dropping it: the v6 fix moved the bound,
    // it did not relax the "entirely inside" rule.
    expect(modern.energyKwh[0][0]).toBeCloseTo(2, 6);
    expect(isolated.matrix[0][0]).toBeCloseTo(2, 6);
    expect(modern.energyKwh[0][0]).toBeCloseTo(isolated.matrix[0][0], 6);
  });

  it("dense day: windowed slice equals isolated integration (no regression)", () => {
    const win2 = dayWindow(D1 + DAY);
    const fullTs: number[] = [];
    for (let h = 22; h <= 24; h++) fullTs.push(D1 + h * HOUR); // day1 22:00,23:00, 00:00 day2
    for (let h = 1; h <= 24; h++) fullTs.push(D1 + DAY + h * HOUR); // day2 01:00 .. 00:00 day3
    const modern = computeFlowAccounting({
      timestamps: fullTs,
      sources: grid(fullTs, 3),
      loads: load(fullTs, 2),
      window: win2,
    });
    const isoTs = isolate(fullTs, win2);
    const isolated = computeFlowMatrix({
      timestamps: isoTs,
      sources: grid(isoTs, 3),
      loads: load(isoTs, 2),
    });
    expect(modern.energyKwh[0][0]).toBeGreaterThan(0);
    expect(modern.energyKwh[0][0]).toBeCloseTo(isolated.matrix[0][0], 6);
  });

  it("attributes the day's FIRST interval, (00:00, 00:05] local (flow_attr_1d v6)", () => {
    const midnight = D1 + DAY; // 2026-01-02 local midnight
    // Five-minute samples across the seam: 23:55 (day 1), then 00:00, 00:05, 00:10 (day 2).
    const fullTs = [
      midnight - FIVE_MIN,
      midnight,
      midnight + FIVE_MIN,
      midnight + 2 * FIVE_MIN,
    ];
    // 12 kW for five minutes = exactly 1 kWh per interval, so the count is readable off the total.
    const modern = computeFlowAccounting({
      timestamps: fullTs,
      sources: grid(fullTs, 12),
      loads: load(fullTs, 12),
      window: dayWindow(midnight),
    });
    // Day 2 owns TWO of these intervals — (00:00, 00:05] and (00:05, 00:10] — so 2 kWh. Under the
    // pre-v6 bound (00:05) the first was skipped and this read 1 kWh. The day-1 tail interval
    // (23:55, 00:00] is correctly excluded either way.
    expect(modern.energyKwh[0][0]).toBeCloseTo(2, 9);
    expect(modern.intervalsUsed).toBe(2);
  });

  it("consecutive per-day windows TILE: Σ days == one window over the whole span", () => {
    // Three days of hourly samples, midnight day 1 → midnight day 4. Power varies on co-prime cycles
    // so no accidental symmetry can hide a dropped interval.
    const ts: number[] = [];
    for (let h = 0; h <= 72; h++) ts.push(D1 + h * HOUR);
    const sources: FlowSeries[] = [
      { path: "source.grid", power: ts.map((_, i) => 1 + (i % 7)) },
    ];
    const loads: FlowSeries[] = [
      { path: "load", power: ts.map((_, i) => 1 + (i % 5)) },
    ];

    const whole = computeFlowAccounting({
      timestamps: ts,
      sources,
      loads,
      window: { startMs: D1, endMs: D1 + 3 * DAY },
    });
    let summed = 0;
    for (let d = 0; d < 3; d++) {
      summed += computeFlowAccounting({
        timestamps: ts,
        sources,
        loads,
        window: dayWindow(D1 + d * DAY),
      }).energyKwh[0][0];
    }

    // This is the property the pre-v6 bound broke: each day silently lost its opening interval, so a
    // month of flow_attr_1d rows summed to LESS than the month's own matrix.
    expect(whole.energyKwh[0][0]).toBeGreaterThan(0);
    expect(summed).toBeCloseTo(whole.energyKwh[0][0], 9);
  });
});

describe("computeFlowAccounting revenue leg (sink-priced)", () => {
  // Solar 5 kW for 1 h: 3 kWh to the house, 2 kWh exported. Grid import price 30 c/kWh (unused here
  // — solar is the only source), feed-in 8 c/kWh on the export sink only.
  const ts = hours(2);
  const sources: FlowSeries[] = [{ path: "source.solar", power: [5, 5] }];
  const loads: FlowSeries[] = [
    { path: "load", power: [3, 3] },
    { path: "load.grid", power: [2, 2] },
  ];
  const solarIntensity = {
    emissions: [0, 0],
    renewable: [1, 1],
    selfRenewable: [1, 1],
    price: [0, 0],
    estimated: [false, false],
  };

  it("prices only the load.grid column, at the feed-in rate", () => {
    const acc = computeFlowAccounting({
      timestamps: ts,
      sources,
      loads,
      sourceIntensities: [solarIntensity],
      loadPrices: [null, [8, 8]],
    });
    // 2 kWh exported × 8 c/kWh = 16 c earned; the house column earns nothing and has no denominator.
    expect(acc.revenueC[0][1]).toBeCloseTo(16, 6);
    expect(acc.revenueKnownKwh[0][1]).toBeCloseTo(2, 6);
    expect(acc.revenueC[0][0]).toBe(0);
    expect(acc.revenueKnownKwh[0][0]).toBe(0);
  });

  it("leaves the revenue leg empty when no load price is supplied", () => {
    const acc = computeFlowAccounting({
      timestamps: ts,
      sources,
      loads,
      sourceIntensities: [solarIntensity],
    });
    expect(acc.revenueC[0][1]).toBe(0);
    expect(acc.revenueKnownKwh[0][1]).toBe(0);
  });

  it("does not let an unknown feed-in price bleed into estimatedKwh or costC", () => {
    const priced = computeFlowAccounting({
      timestamps: ts,
      sources,
      loads,
      sourceIntensities: [solarIntensity],
      loadPrices: [null, [8, 8]],
    });
    // A null feed-in sample (no tariff at that interval) must earn nothing AND leave every
    // source-side leg byte-identical to the priced run.
    const unpriced = computeFlowAccounting({
      timestamps: ts,
      sources,
      loads,
      sourceIntensities: [solarIntensity],
      loadPrices: [null, [null, null]],
    });
    expect(unpriced.revenueC[0][1]).toBe(0);
    expect(unpriced.revenueKnownKwh[0][1]).toBe(0);
    expect(unpriced.estimatedKwh).toEqual(priced.estimatedKwh);
    expect(unpriced.costC).toEqual(priced.costC);
    expect(unpriced.energyKwh).toEqual(priced.energyKwh);
  });

  it("attributes export revenue back to the source that produced the exported energy", () => {
    // Solar 4 kW + battery discharge 2 kW for 1 h; 3 kWh to the house, 3 kWh exported. The export is
    // allocated by generation share (2/3 solar, 1/3 battery), and so is its revenue.
    const mixedSources: FlowSeries[] = [
      { path: "source.solar", power: [4, 4] },
      { path: "source.battery", power: [2, 2] },
    ];
    const acc = computeFlowAccounting({
      timestamps: ts,
      sources: mixedSources,
      loads: [
        { path: "load", power: [3, 3] },
        { path: "load.grid", power: [3, 3] },
      ],
      sourceIntensities: [solarIntensity, null],
      loadPrices: [null, [10, 10]],
    });
    expect(acc.energyKwh[0][1]).toBeCloseTo(2, 6); // solar → export
    expect(acc.energyKwh[1][1]).toBeCloseTo(1, 6); // battery → export
    expect(acc.revenueC[0][1]).toBeCloseTo(20, 6);
    expect(acc.revenueC[1][1]).toBeCloseTo(10, 6);
  });
});
