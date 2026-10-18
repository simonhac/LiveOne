import { describe, it, expect } from "@jest/globals";
import {
  computeDayEnergyReadings,
  dataTimeInstantsUtcMs,
  resolveDataTimes,
  orderedRows,
  enumerateDays,
  type Agg5mReading,
} from "../statistics";
import type { SigenergyEnergyInterval, SigenergyEnergyTotals } from "../types";

// The station's civil zone. The fixtures below are July — standard time, +10 — so they read the
// same as the fixed offset; the DST cases further down are the ones that tell the two apart.
const TZ = "Australia/Melbourne";
const at = (dataTime: string) => resolveDataTimes([dataTime], TZ)[0];

// A tiny synthetic day: cumulative-since-local-midnight kWh counters at 5-min marks (dataTime = START).
const rows: SigenergyEnergyInterval[] = [
  mk("00:00", { gen: 0, load: 0 }),
  mk("00:05", { gen: 0.1, load: 0.2 }),
  mk("00:10", { gen: 0.3, load: 0.35 }),
  mk("00:15", { gen: 0.3, load: 0.5 }), // last sample; PV flat after 00:10
];
// Vendor daily totals (cumulative to 24:00): the tail [00:15,00:20) carries gen 0.05, load 0.10.
const totals: SigenergyEnergyTotals = {
  powerGeneration: 0.35,
  powerUse: 0.6,
  powerToGrid: 0,
  powerFromGrid: 0,
  esCharging: 0,
  esDischarging: 0,
};

function mk(
  hhmm: string,
  v: { gen: number; load: number },
): SigenergyEnergyInterval {
  return {
    dataTime: `20260711 ${hhmm}`,
    powerGeneration: v.gen,
    powerUse: v.load,
    powerToGrid: 0,
    powerFromGrid: 0,
    esCharging: 0,
    esDischarging: 0,
    // The instantaneous half of an itemList row. Null here: these cases exercise the COUNTER
    // differencing, and a null power field is what an older payload (or a field we cannot read)
    // looks like — the path that must still fall back to energy-derived power.
    solarKw: null,
    loadKw: null,
    gridImportKw: null,
    gridExportKw: null,
    batteryChargeKw: null,
    batteryDischargeKw: null,
    socPct: null,
  };
}

const byStem = (rs: Agg5mReading[], stem: string) =>
  rs.filter((r) => r.pointMetadata.logicalPathStem === stem);
const sumWh = (rs: Agg5mReading[]) => rs.reduce((a, r) => a + r.rawValue, 0);

describe("dataTimeInstantsUtcMs", () => {
  it("reads a standard-time wall clock at +10", () => {
    // 2026-07-11 00:05 AEST === 2026-07-10 14:05 UTC.
    expect(dataTimeInstantsUtcMs("20260711 00:05", TZ)).toEqual([
      Date.UTC(2026, 6, 10, 14, 5),
    ]);
  });
  it("reads a daylight-time wall clock at +11 — the 2026-10-17 regression", () => {
    // 2026-10-17 19:05 AEDT === 08:05 UTC. Parsed at a fixed +10 it came out 09:05: an hour late.
    expect(dataTimeInstantsUtcMs("20261017 19:05", TZ)).toEqual([
      Date.UTC(2026, 9, 17, 8, 5),
    ]);
  });
  it("has no instant inside the spring-forward gap", () => {
    // 2026-10-04: 02:00 AEST jumps to 03:00 AEDT.
    expect(dataTimeInstantsUtcMs("20261004 02:30", TZ)).toEqual([]);
  });
  it("has two instants inside the fall-back hour, ascending", () => {
    // 2027-04-04: 03:00 AEDT falls back to 02:00 AEST, so 02:30 happens twice.
    expect(dataTimeInstantsUtcMs("20270404 02:30", TZ)).toEqual([
      Date.UTC(2027, 3, 3, 15, 30), // AEDT (+11)
      Date.UTC(2027, 3, 3, 16, 30), // AEST (+10)
    ]);
  });
  it("returns null for an unparseable string", () => {
    expect(dataTimeInstantsUtcMs("not-a-time", TZ)).toBeNull();
  });
});

describe("resolveDataTimes", () => {
  it("takes the repeated fall-back hour as DST first, standard second — strictly increasing", () => {
    const times = [
      "20270404 01:55",
      "20270404 02:00",
      "20270404 02:55",
      "20270404 02:00",
      "20270404 02:55",
      "20270404 03:00",
    ];
    const got = resolveDataTimes(times, TZ) as number[];
    expect(got.every((ms) => ms != null)).toBe(true);
    for (let i = 1; i < got.length; i++)
      expect(got[i]).toBeGreaterThan(got[i - 1]);
    expect(got[1]).toBe(Date.UTC(2027, 3, 3, 15, 0)); // 02:00 AEDT
    expect(got[3]).toBe(Date.UTC(2027, 3, 3, 16, 0)); // 02:00 AEST, an hour later
    // Every gap is 5 minutes except the two around the repeat: 01:55→02:00 and the fall back.
    expect(got[5] - got[4]).toBe(5 * 60 * 1000);
  });
  it("leaves a nonexistent spring-forward time null without disturbing its neighbours", () => {
    const got = resolveDataTimes(
      ["20261004 01:55", "20261004 02:30", "20261004 03:00"],
      TZ,
    );
    expect(got[1]).toBeNull();
    // 01:55 AEST → 03:00 AEDT is the 5-minute step the clocks actually took.
    expect(got[2]! - got[0]!).toBe(5 * 60 * 1000);
  });
});

describe("computeDayEnergyReadings", () => {
  it("differences consecutive counters and labels at interval_end = next dataTime", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    const solar = byStem(rd, "source.solar");
    // 3 consecutive diffs (no tail on an incomplete day).
    expect(solar).toHaveLength(3);
    // First interval [00:00,00:05): 0.10 kWh → 100 Wh, labelled at 00:05.
    expect(solar[0].rawValue).toBe(100);
    expect(solar[0].intervalEndMs).toBe(at("20260711 00:05"));
    expect(solar[1].rawValue).toBe(200); // 0.10→0.30
    expect(solar[2].rawValue).toBe(0); // PV flat 0.30→0.30
  });

  it("flickering near-zero counter (grid import) reconstructs to the small vendor total exactly — no clamp inflation", () => {
    // A self-sufficient day: powerFromGrid is ~0 and its 0.01-kWh-rounded counter FLICKERS.
    const gi = (hhmm: string, v: number): SigenergyEnergyInterval => ({
      dataTime: `20260711 ${hhmm}`,
      powerGeneration: 0,
      powerUse: 0,
      powerToGrid: 0,
      powerFromGrid: v,
      esCharging: 0,
      esDischarging: 0,
      solarKw: null,
      loadKw: null,
      gridImportKw: null,
      gridExportKw: null,
      batteryChargeKw: null,
      batteryDischargeKw: null,
      socPct: null,
    });
    const flick = [
      gi("00:00", 0),
      gi("00:05", 0.01),
      gi("00:10", 0),
      gi("00:15", 0.01),
      gi("00:20", 0.01),
    ];
    const t: SigenergyEnergyTotals = { ...totals, powerFromGrid: 0.01 };
    const rd = computeDayEnergyReadings(flick, t, TZ, true);
    const imp = byStem(rd, "bidi.grid.import");
    // Signed diffs telescope + tail reconciles → exactly 10 Wh (NOT the clamped-inflated 20 Wh).
    expect(sumWh(imp)).toBe(10);
    // signed diffs are genuinely used (a −0.01 flicker interval is emitted, not clamped to 0).
    expect(imp.some((r) => r.rawValue < 0)).toBe(true);
  });

  it("an INCOMPLETE day gets no tail; sum equals the last counter (not the daily total)", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    expect(sumWh(byStem(rd, "source.solar"))).toBe(300); // = counter[last] 0.30 kWh
    expect(sumWh(byStem(rd, "load"))).toBe(500); // = counter[last] 0.50 kWh
  });

  it("a COMPLETED day reconstructs EXACTLY to the vendor daily total (residual tail)", () => {
    const rd = computeDayEnergyReadings(rows, totals, TZ, true);
    const solar = byStem(rd, "source.solar");
    const load = byStem(rd, "load");
    // 3 diffs + 1 tail interval.
    expect(solar).toHaveLength(4);
    expect(sumWh(solar)).toBe(Math.round(totals.powerGeneration! * 1000)); // 350
    expect(sumWh(load)).toBe(Math.round(totals.powerUse! * 1000)); // 600
    // The tail lands one interval past the last sample.
    const tail = solar[solar.length - 1];
    expect(tail.intervalEndMs).toBe(at("20260711 00:15")! + 5 * 60 * 1000);
    expect(tail.rawValue).toBe(50); // 0.35 total − 0.30 accumulated
  });

  it("telescopes: no drift accumulates over the day (sum of diffs = last counter, exact)", () => {
    // Even with 0.01-rounded counters, the intermediate diffs sum to counter[last] exactly.
    const rd = computeDayEnergyReadings(rows, totals, TZ, false);
    expect(sumWh(byStem(rd, "source.solar"))).toBe(300);
  });

  it("labels a daylight-time day at +11, not the fixed offset", () => {
    const dst = rows.map((r) => ({
      ...r,
      dataTime: r.dataTime.replace("20260711", "20261017"),
    }));
    const solar = byStem(
      computeDayEnergyReadings(dst, totals, TZ, false),
      "source.solar",
    );
    // [00:00, 00:05) AEDT ends at 2026-10-16 13:05 UTC — 14:05 is where the fixed +10 put it.
    expect(solar[0].intervalEndMs).toBe(Date.UTC(2026, 9, 16, 13, 5));
  });

  it("returns nothing for an empty day", () => {
    expect(computeDayEnergyReadings([], totals, TZ, true)).toEqual([]);
  });
});

describe("orderedRows", () => {
  it("sorts an ordinary day", () => {
    const got = orderedRows([
      { dataTime: "20260711 00:10" },
      { dataTime: "20260711 00:05" },
    ]);
    expect(got.map((r) => r.dataTime)).toEqual([
      "20260711 00:05",
      "20260711 00:10",
    ]);
  });
  it("keeps the vendor's order on a fall-back day, so the repeated hour stays two hours", () => {
    const vendor = ["01:55", "02:00", "02:55", "02:00", "02:55", "03:00"].map(
      (t) => ({
        dataTime: `20270404 ${t}`,
      }),
    );
    const got = orderedRows(vendor);
    expect(got).toBe(vendor);
    const instants = resolveDataTimes(
      got.map((r) => r.dataTime),
      TZ,
    );
    expect(instants.every((ms) => ms != null)).toBe(true);
  });
});

describe("enumerateDays", () => {
  it("is inclusive of both ends", () => {
    const days = enumerateDays("20260706", "20260712");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("20260706");
    expect(days[6]).toBe("20260712");
  });
  it("handles a single day", () => {
    expect(enumerateDays("20260712", "20260712")).toEqual(["20260712"]);
  });
});
