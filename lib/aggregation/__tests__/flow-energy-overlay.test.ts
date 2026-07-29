/**
 * Exact-energy overlay (`FlowSeries.energyKwh`) — the accumulator-first seam.
 *
 * The headline invariant: a bidirectional channel that reverses WITHIN a 5-minute interval keeps its
 * GROSS flows when directional accumulator pairs are present, where the signed power average nets
 * them to ~0 (the Kutis/Sigenergy 64.9 kWh loss). Plus: slot→interval alignment, per-interval
 * fallback, dropped-sample recovery, mixed exact/integrated shares, signed-net splitting, Amber
 * `.controlled` summing, and fold (extractBatteryFlows) consistency with the core's battery cells.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildFlowSeries,
  ClassifiedPoint,
  EnergySeriesInput,
} from "../flow-series";
import { computeFlowAccounting, computeFlowMatrix } from "../flow-matrix-core";
import { extractBatteryFlows } from "../../battery-provenance/battery-flows";

const FIVE_MIN = 300_000;
/** n+1 timestamps → n intervals, 5 minutes each. */
const tl = (n: number) =>
  Array.from({ length: n + 1 }, (_, i) => (i + 1) * FIVE_MIN);

const at = (m: ReturnType<typeof computeFlowMatrix>, s: string, l: string) =>
  m.matrix[m.sources.indexOf(s)][m.loads.indexOf(l)];

describe("energy overlay: flip interval (the headline bug)", () => {
  // One 5-min interval in which the battery BOTH charges 0.100 kWh and discharges 0.080 kWh.
  // The signed power average sees ~0 net; the pair registers preserve the gross flows.
  const timestamps = tl(1);
  const points: ClassifiedPoint[] = [
    { stem: "source.solar", power: [6, 6] },
    { stem: "bidi.battery", power: [0.24, 0.24] }, // netted: 0.1 chg + 0.08 dis ≈ +0.24kW avg
    { stem: "load", power: [5.76, 5.76] },
  ];
  const energy: EnergySeriesInput[] = [
    { stem: "source.solar", energyKwhBySlot: [null, 0.5] },
    { stem: "bidi.battery.charge", energyKwhBySlot: [null, 0.1] },
    { stem: "bidi.battery.discharge", energyKwhBySlot: [null, 0.08] },
    { stem: "load", energyKwhBySlot: [null, 0.48] },
  ];

  it("preserves gross charge AND discharge in the same interval; no battery→battery cell", () => {
    const { sources, loads } = buildFlowSeries(points, energy);
    const m = computeFlowMatrix({ timestamps, sources, loads });

    // Load side is exact: battery charged 0.100 kWh (drawn from solar — its own source excluded).
    expect(at(m, "source.solar", "load.battery")).toBeCloseTo(0.1, 9);
    expect(at(m, "source.battery", "load.battery")).toBeCloseTo(0, 12);

    // Master load 0.48 splits across solar (0.5) and battery discharge (0.08) by energy share.
    expect(at(m, "source.solar", "load")).toBeCloseTo(0.48 * (0.5 / 0.58), 9);
    expect(at(m, "source.battery", "load")).toBeCloseTo(
      0.48 * (0.08 / 0.58),
      9,
    );

    // Grand total = total load energy (conservation of the allocation).
    expect(m.totalEnergy).toBeCloseTo(0.58, 9);
  });

  it("control: signed power alone nets the flip away (documents the failure being fixed)", () => {
    const { sources, loads } = buildFlowSeries(points); // no overlays
    const m = computeFlowMatrix({ timestamps, sources, loads });
    // The netted +0.24 kW average reads as pure discharge: the gross charge is destroyed entirely.
    const lb = m.loads.indexOf("load.battery");
    expect(m.loadTotals[lb]).toBeCloseTo(0, 12);
  });
});

describe("energy overlay: slot→interval alignment", () => {
  it("a delta stamped at interval_end T covers (T−5m, T] and no other interval", () => {
    const timestamps = tl(2); // intervals 0 and 1
    const points: ClassifiedPoint[] = [
      { stem: "source.solar", power: [2, 2, 2] },
      { stem: "load", power: [1, 1, 1] },
    ];
    // Exact load energy ONLY at slot 2 (= interval 1). Interval 0 must fall back to the trapezoid.
    const energy: EnergySeriesInput[] = [
      { stem: "load", energyKwhBySlot: [null, null, 0.5] },
    ];
    const { sources, loads } = buildFlowSeries(points, energy);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    const trapezoid = 1 * (FIVE_MIN / 3_600_000); // 1 kW × 5 min
    expect(at(m, "source.solar", "load")).toBeCloseTo(trapezoid + 0.5, 9);
  });
});

describe("energy overlay: dropped-sample recovery", () => {
  it("an interval with null power but exact deltas still contributes and is counted", () => {
    const timestamps = tl(1);
    const points: ClassifiedPoint[] = [
      { stem: "source.solar", power: [null, null] },
      { stem: "load", power: [null, null] },
    ];
    const energy: EnergySeriesInput[] = [
      { stem: "source.solar", energyKwhBySlot: [null, 0.4] },
      { stem: "load", energyKwhBySlot: [null, 0.4] },
    ];
    const { sources, loads } = buildFlowSeries(points, energy);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    expect(at(m, "source.solar", "load")).toBeCloseTo(0.4, 9);
    expect(m.intervalsUsed).toBe(1);

    // Control: power-only inputs drop the interval entirely.
    const c = buildFlowSeries(points);
    const cm = computeFlowMatrix({
      timestamps,
      sources: c.sources,
      loads: c.loads,
    });
    expect(cm.totalEnergy).toBe(0);
    expect(cm.intervalsUsed).toBe(0);
  });
});

describe("energy overlay: mixed exact/integrated shares", () => {
  it("one weight pool: exact kWh where metered, left-endpoint power × dt where not", () => {
    // 1-hour interval for round numbers: dtH = 1 → a 2 kW grid left endpoint weighs 2 kWh.
    const timestamps = [3_600_000, 7_200_000];
    const points: ClassifiedPoint[] = [
      { stem: "source.solar", power: [1, 1] }, // would integrate to 1 kWh — overridden by exact 0.5
      { stem: "bidi.grid", power: [2, 2] }, // power-only → weight 2 kWh
      { stem: "load", power: [3, 3] },
    ];
    const energy: EnergySeriesInput[] = [
      { stem: "source.solar", energyKwhBySlot: [null, 0.5] },
      { stem: "load", energyKwhBySlot: [null, 2.0] },
    ];
    const { sources, loads } = buildFlowSeries(points, energy);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    expect(at(m, "source.solar", "load")).toBeCloseTo(2.0 * (0.5 / 2.5), 9);
    expect(at(m, "source.grid", "load")).toBeCloseTo(2.0 * (2 / 2.5), 9);
  });
});

describe("energy overlay: signed-net kind (single-stem bidi accumulator)", () => {
  it("splits an exact signed net by sign onto the channel's halves", () => {
    const timestamps = tl(2);
    const points: ClassifiedPoint[] = [
      { stem: "bidi.battery", power: [1, -1, 0] },
      { stem: "load", power: [1, 1, 1] },
    ];
    // Signed net deltas: interval 0 = +0.3 (discharge), interval 1 = −0.2 (charge).
    const energy: EnergySeriesInput[] = [
      { stem: "bidi.battery", energyKwhBySlot: [null, 0.3, -0.2] },
    ];
    const { sources, loads } = buildFlowSeries(points, energy);
    const src = sources.find((s) => s.path === "source.battery")!;
    const load = loads.find((l) => l.path === "load.battery")!;
    expect(src.energyKwh).toEqual([0.3, 0]);
    expect(load.energyKwh).toEqual([0, 0.2]);
  });
});

describe("energy overlay: multiple registers on one node (Amber .controlled)", () => {
  it("sums .import + .controlled into source.grid, with null-poisoning", () => {
    const timestamps = tl(2);
    const points: ClassifiedPoint[] = [
      { stem: "bidi.grid", power: [2, 2, 2] },
      { stem: "load", power: [2, 2, 2] },
    ];
    const energy: EnergySeriesInput[] = [
      { stem: "bidi.grid.import", energyKwhBySlot: [null, 0.1, 0.2] },
      { stem: "bidi.grid.controlled", energyKwhBySlot: [null, 0.05, null] },
    ];
    const { sources } = buildFlowSeries(points, energy);
    const grid = sources.find((s) => s.path === "source.grid")!;
    // Interval 0: 0.1 + 0.05. Interval 1: controlled missing → unknowable → null (power fallback).
    expect(grid.energyKwh![0]).toBeCloseTo(0.15, 12);
    expect(grid.energyKwh![1]).toBeNull();
  });

  it("nulls a negative directional delta (counter reset) instead of ingesting it", () => {
    const timestamps = tl(1);
    const points: ClassifiedPoint[] = [
      { stem: "bidi.grid", power: [2, 2] },
      { stem: "load", power: [2, 2] },
    ];
    const energy: EnergySeriesInput[] = [
      { stem: "bidi.grid.import", energyKwhBySlot: [null, -5] },
    ];
    const { sources } = buildFlowSeries(points, energy);
    const grid = sources.find((s) => s.path === "source.grid")!;
    expect(grid.energyKwh).toEqual([null]);
  });
});

describe("energy overlay: month-style reconciliation (Sankey == registers)", () => {
  // Alternating day/night pattern, 48 intervals: days solar 2 kWh (1.2 to load, 0.8 charges the
  // battery), nights the battery is the only source discharging 0.7 kWh to the load. With exact
  // registers everywhere, the Sankey's battery totals must equal the register sums EXACTLY — the
  // invariant prod violated by 18%.
  const N = 48;
  const timestamps = tl(N);
  const nul = () => new Array<number | null>(N + 1).fill(null);
  const solarSlots = nul();
  const chgSlots = nul();
  const disSlots = nul();
  const loadSlots = nul();
  const solarPower: (number | null)[] = new Array(N + 1).fill(0);
  const batteryPower: (number | null)[] = new Array(N + 1).fill(0);
  const loadPower: (number | null)[] = new Array(N + 1).fill(0);
  for (let i = 0; i < N; i++) {
    const day = i % 2 === 0;
    // slot i+1 carries interval i's energy
    solarSlots[i + 1] = day ? 2.0 : 0;
    chgSlots[i + 1] = day ? 0.8 : 0;
    disSlots[i + 1] = day ? 0 : 0.7;
    loadSlots[i + 1] = day ? 1.2 : 0.7;
    solarPower[i] = day ? 24 : 0;
    batteryPower[i] = day ? -9.6 : 8.4;
    loadPower[i] = day ? 14.4 : 8.4;
  }
  const points: ClassifiedPoint[] = [
    { stem: "source.solar", power: solarPower },
    { stem: "bidi.battery", power: batteryPower },
    { stem: "load", power: loadPower },
  ];
  const energy: EnergySeriesInput[] = [
    { stem: "source.solar", energyKwhBySlot: solarSlots },
    { stem: "bidi.battery.charge", energyKwhBySlot: chgSlots },
    { stem: "bidi.battery.discharge", energyKwhBySlot: disSlots },
    { stem: "load", energyKwhBySlot: loadSlots },
  ];

  it("battery/solar/load Sankey totals equal the register sums", () => {
    const { sources, loads } = buildFlowSeries(points, energy);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    const sum = (a: (number | null)[]) =>
      a.reduce<number>((acc, v) => acc + (v ?? 0), 0);

    // load.battery column == Σ charge registers; source.battery row == Σ discharge registers
    // (nights: the battery is the sole source, so its allocation equals its register).
    const chg = sum(chgSlots);
    const dis = sum(disSlots);
    const lb = m.loads.indexOf("load.battery");
    const sb = m.sources.indexOf("source.battery");
    expect(m.loadTotals[lb]).toBeCloseTo(chg, 9);
    expect(m.sourceTotals[sb]).toBeCloseTo(dis, 9);
    expect(m.totalEnergy).toBeCloseTo(sum(loadSlots) + chg, 9);
  });

  it("fold battery flows match the core's battery cells (one preference implementation)", () => {
    const { sources, loads } = buildFlowSeries(points, energy);
    const acc = computeFlowAccounting({ timestamps, sources, loads });
    const flows = extractBatteryFlows(timestamps, sources, loads);
    const chargeTotal = flows.reduce(
      (a, f) => a + f.solarChargeKwh + f.gridChargeKwh + f.otherChargeKwh,
      0,
    );
    const dischargeTotal = flows.reduce((a, f) => a + f.dischargeKwh, 0);
    const lb = acc.loads.indexOf("load.battery");
    let coreCharge = 0;
    for (let s = 0; s < acc.sources.length; s++)
      coreCharge += acc.energyKwh[s][lb];
    expect(chargeTotal).toBeCloseTo(coreCharge, 9);
    expect(dischargeTotal).toBeCloseTo(
      disSlots.reduce<number>((a, v) => a + (v ?? 0), 0),
      9,
    );
    // The charge is all solar (the only non-battery source in day intervals).
    expect(flows.reduce((a, f) => a + f.solarChargeKwh, 0)).toBeCloseTo(
      coreCharge,
      9,
    );
  });
});

describe("energy overlay: counter re-base (matched negative + catch-up)", () => {
  // A Sigenergy daily counter re-bases mid-day: one negative delta, then a catch-up delta carrying
  // everything the counter had accumulated. Raw deltas self-cancel; keeping only the catch-up would
  // count the day's history twice (measured on prod: −27.3 then +29.3 kWh in adjacent slots).
  const timestamps = tl(4);
  const points: ClassifiedPoint[] = [
    { stem: "source.solar", power: [3, 3, 3, 3, 3] },
    { stem: "load", power: [3, 3, 3, 3, 3] },
  ];
  const energy: EnergySeriesInput[] = [
    { stem: "source.solar", energyKwhBySlot: [null, 0.25, 0.25, 0.25, 0.25] },
    // slots:            i0   i1     i2(reset)  i3(catch-up)  i4
    { stem: "load", energyKwhBySlot: [null, 0.25, -5, 5.25, 0.25] },
  ];

  it("nulls BOTH halves of the re-base — neither interval inherits the catch-up", () => {
    const { sources, loads } = buildFlowSeries(points, energy, timestamps);
    const load = loads.find((l) => l.path === "load")!;
    expect(load.energyKwh![0]).toBeCloseTo(0.25, 9); // normal
    expect(load.energyKwh![1]).toBeNull(); // the negative slot
    expect(load.energyKwh![2]).toBeNull(); // the catch-up slot
    expect(load.energyKwh![3]).toBeCloseTo(0.25, 9); // back to normal
  });

  it("the re-based intervals fall back to power integration, not to the spike", () => {
    const { sources, loads } = buildFlowSeries(points, energy, timestamps);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    const trapezoid = 3 * (FIVE_MIN / 3_600_000); // 0.25 kWh — the two fallback intervals
    expect(at(m, "source.solar", "load")).toBeCloseTo(
      0.25 * 2 + trapezoid * 2,
      9,
    );
  });
});

describe("energy overlay: a master-load register sizes the complement", () => {
  // The Kutis shape: the site meter's ENERGY counter is the total (house + EV); the charger is a
  // power-only sub-meter and the house-excluding-charger point IS the complement, measured. The
  // register has no `load` node to decorate (the master is a budget), so it sizes the complement =
  // total − Σ sub-meters, and the sink side sums to the metered total.
  const timestamps = tl(2);
  const points: ClassifiedPoint[] = [
    { stem: "source.solar", power: [12, 12, 12] },
    { stem: "load.rest-of-house", power: [2, 2, 2] }, // measured complement
    { stem: "load.ev", power: [10, 10, 10] }, // the charger circuit
  ];
  const evKwh = 10 * (FIVE_MIN / 3_600_000); // 0.8333 kWh/interval
  const powerHouseKwh = 2 * (FIVE_MIN / 3_600_000); // what integrating the complement says
  const unmetered = 0.1; // …and what the site meter says it missed
  const siteTotal = powerHouseKwh + evKwh + unmetered;
  const energy: EnergySeriesInput[] = [
    { stem: "source.solar", energyKwhBySlot: [null, 1, 1] },
    { stem: "load", energyKwhBySlot: [null, siteTotal, siteTotal] },
  ];

  it("the measured complement takes the exact total − Σ sub-meters, and the master is not a node", () => {
    const { loads } = buildFlowSeries(points, energy, timestamps);
    expect(loads.some((l) => l.path === "load")).toBe(false);
    const complement = loads.find((l) => l.path === "load.rest-of-house")!;
    // Exact wins over its own power integration — one node, not a measured part plus a leftover.
    expect(complement.energyKwh![0]).toBeCloseTo(powerHouseKwh + unmetered, 9);
  });

  it("only ONE complement node exists — a measured one is never synthesised over", () => {
    const { loads } = buildFlowSeries(points, energy, timestamps);
    expect(loads.filter((l) => l.path === "load.rest-of-house")).toHaveLength(
      1,
    );
  });

  it("total sinks equal the metered site total — nothing counted twice", () => {
    const { sources, loads } = buildFlowSeries(points, energy, timestamps);
    const m = computeFlowMatrix({ timestamps, sources, loads });
    expect(m.totalEnergy).toBeCloseTo(siteTotal * 2, 9);
  });

  it("without a timeline the sub-meters cannot be integrated → the complement falls back to power", () => {
    const { loads } = buildFlowSeries(points, energy); // no timeline
    const complement = loads.find((l) => l.path === "load.rest-of-house")!;
    expect(complement.energyKwh![0]).toBeNull();
  });

  it("no children → the master register attaches to the `load` node unchanged", () => {
    const solo: ClassifiedPoint[] = [
      { stem: "source.solar", power: [12, 12, 12] },
      { stem: "load", power: [2, 2, 2] },
    ];
    const { loads } = buildFlowSeries(solo, energy, timestamps);
    const load = loads.find((l) => l.path === "load")!;
    expect(load.energyKwh![0]).toBeCloseTo(siteTotal, 9);
  });
});
