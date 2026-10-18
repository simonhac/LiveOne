/**
 * `backfillEnergyRange` across the DST seam: our days are fixed +10, the vendor's are civil, so in
 * daylight time one of ours ends an hour into the vendor's next day.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const inserted: { intervalEndMs: number }[][] = [];
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: {
    getInstance: () => ({
      insertPointReadingsAgg5m: async (
        _id: number,
        _s: unknown,
        rows: { intervalEndMs: number }[],
      ) => {
        inserted.push(rows);
      },
    }),
  },
}));
const calls: string[] = [];
const deleted: { fromMs: number; toMs: number }[] = [];
jest.mock("../derive-power", () => ({
  deriveDayPowerReadings: async () => {
    calls.push("derive");
    return [];
  },
  deleteDerivedPowerRows: async (
    _id: number,
    w: { fromMs: number; toMs: number },
  ) => {
    calls.push("delete");
    deleted.push(w);
    return 7;
  },
}));

import { backfillEnergyRange } from "../statistics";
import type { SigenergyClient } from "../sigenergy-client";
import type { SigenergyEnergyInterval } from "../types";

const FIVE_MIN = 5 * 60 * 1000;

/** A full civil day of rows, every counter climbing 0.01 kWh per interval. */
function civilDay(date: string, ticks: string[]) {
  const intervals: SigenergyEnergyInterval[] = ticks.map((hhmm, i) => ({
    dataTime: `${date} ${hhmm}`,
    powerGeneration: i * 0.01,
    powerUse: i * 0.01,
    powerToGrid: 0,
    powerFromGrid: 0,
    esCharging: 0,
    esDischarging: 0,
    solarKw: null,
    loadKw: null,
    gridImportKw: null,
    gridExportKw: null,
    batteryChargeKw: null,
    batteryDischargeKw: null,
    socPct: null,
  }));
  return {
    date,
    // The day's headline totals: one more tick than the last counter, which the completed-day
    // residual puts in the interval ending at the vendor's midnight.
    totals: {
      powerGeneration: ticks.length * 0.01,
      powerUse: ticks.length * 0.01,
      powerToGrid: 0,
      powerFromGrid: 0,
      esCharging: 0,
      esDischarging: 0,
    },
    intervals,
    raw: null,
  };
}

const ALL_TICKS = Array.from({ length: 288 }, (_, i) => {
  const m = i * 5;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

function fakeClient() {
  const asked: string[] = [];
  const client = {
    getEnergyStatistics: async (_station: string, date: string) => {
      asked.push(date);
      return civilDay(date, ALL_TICKS);
    },
  } as unknown as SigenergyClient;
  return { client, asked };
}

const run = (
  client: SigenergyClient,
  endDate: string,
  now: number,
  replaceDerived = false,
) =>
  backfillEnergyRange({
    replaceDerived,
    client,
    systemId: 13,
    stationId: "s",
    startDate: endDate,
    endDate,
    tzOffsetMin: 600,
    timeZone: "Australia/Melbourne",
    session: {} as never,
    now,
  });

describe("backfillEnergyRange across the DST seam", () => {
  beforeEach(() => {
    inserted.length = 0;
    calls.length = 0;
    deleted.length = 0;
  });

  it("in daylight time fetches the next vendor day and fills our day exactly to 24:00 +10", async () => {
    const { client, asked } = fakeClient();
    const res = await run(
      client,
      "20261017",
      Date.parse("2026-10-19T00:00:00Z"),
    );
    expect(asked).toEqual(["20261017", "20261018"]);
    expect(res.errors).toEqual([]);

    // Our 17 Oct is (16 Oct 14:00Z, 17 Oct 14:00Z] — every interval end inside it, once per point.
    const from = Date.parse("2026-10-16T14:00:00Z");
    const to = Date.parse("2026-10-17T14:00:00Z");
    const ends = new Set(inserted.flat().map((r) => r.intervalEndMs));
    expect([...ends].every((ms) => ms > from && ms <= to)).toBe(true);
    // 288 slots: 276 from the vendor's 17th (its first hour belongs to our 16th; its residual tail
    // ends at its midnight, 13:00Z) + 11 from its 18th's first hour.
    expect(ends.size).toBe(288);
    expect(ends.has(to)).toBe(true);
    expect(ends.has(from + FIVE_MIN)).toBe(true);
  });

  it("in standard time fetches only the one day, unclipped", async () => {
    const { client, asked } = fakeClient();
    await run(client, "20260717", Date.parse("2026-07-19T00:00:00Z"));
    expect(asked).toEqual(["20260717"]);
    // 287 differenced intervals + the residual tail at midnight.
    expect(new Set(inserted.flat().map((r) => r.intervalEndMs)).size).toBe(288);
  });

  it("does not ask for a vendor day that has not started", async () => {
    const { client, asked } = fakeClient();
    // 17 Oct 23:30 AEDT: the vendor's 18th is half an hour away.
    await run(client, "20261017", Date.parse("2026-10-17T12:30:00Z"));
    expect(asked).toEqual(["20261017"]);
  });

  it("under replaceDerived, deletes each vendor day's slots of OUR window before re-deriving", async () => {
    const { client } = fakeClient();
    const res = await run(
      client,
      "20261017",
      Date.parse("2026-10-19T00:00:00Z"),
      true,
    );
    // Delete precedes derive for every vendor day: the derive pass reads the store to find holes.
    expect(calls).toEqual(["delete", "derive", "delete", "derive"]);
    // Each delete is that vendor day ∩ our fixed-offset 17th — never a slot outside it.
    expect(deleted).toEqual([
      {
        fromMs: Date.parse("2026-10-16T14:00:00Z"), // our 00:00 +10 (vendor day began an hour earlier)
        toMs: Date.parse("2026-10-17T13:00:00Z"), // the vendor's midnight
      },
      {
        fromMs: Date.parse("2026-10-17T13:00:00Z"),
        toMs: Date.parse("2026-10-17T14:00:00Z"), // our 24:00 +10
      },
    ]);
    expect(res.days.map((d) => d.derivedReplaced)).toEqual([7, 7]);
  });

  it("without it, deletes nothing", async () => {
    const { client } = fakeClient();
    await run(client, "20261017", Date.parse("2026-10-19T00:00:00Z"));
    expect(deleted).toEqual([]);
  });
});
