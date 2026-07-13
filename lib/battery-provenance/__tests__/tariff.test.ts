import { describe, it, expect } from "@jest/globals";
import type { ExportTariffConfig } from "@/lib/capabilities/config";
import {
  NO_TARIFF,
  ScheduleTariffProvider,
  resolveExportPriceSeries,
} from "../tariff";

// AEST standard offset (+10h). Used to exercise local-date selection independent of UTC.
const TZ = 600;
const utc = (iso: string) => new Date(iso).getTime();

describe("resolveExportPriceSeries", () => {
  const timeline = [utc("2026-01-01T00:00:00Z"), utc("2026-01-01T00:05:00Z")];
  const amber = [7.5, -2];

  it("mode none / undefined config → all null", () => {
    expect(resolveExportPriceSeries(undefined, timeline, TZ, amber)).toEqual([
      null,
      null,
    ]);
    expect(
      resolveExportPriceSeries({ mode: "none" }, timeline, TZ, amber),
    ).toEqual([null, null]);
  });

  it("mode amber → passes the measured series through unchanged (incl. negatives)", () => {
    expect(
      resolveExportPriceSeries({ mode: "amber" }, timeline, TZ, amber),
    ).toEqual([7.5, -2]);
  });

  it("mode schedule (flat, single always-on plan) → constant", () => {
    const cfg: ExportTariffConfig = {
      mode: "schedule",
      plans: [{ rate: { kind: "flat", cPerKwh: 5 } }],
    };
    expect(resolveExportPriceSeries(cfg, timeline, TZ, amber)).toEqual([5, 5]);
  });
});

describe("ScheduleTariffProvider — effective-dated plans", () => {
  const cfg = new ScheduleTariffProvider(
    [
      { effectiveFrom: "2026-01-01", rate: { kind: "flat", cPerKwh: 6 } },
      { effectiveFrom: "2026-07-01", rate: { kind: "flat", cPerKwh: 3.3 } },
    ],
    TZ,
  );

  it("picks the plan in force on the interval's LOCAL date", () => {
    expect(cfg.exportPriceAt(utc("2026-03-15T02:00:00Z"))).toBe(6);
    expect(cfg.exportPriceAt(utc("2026-09-15T02:00:00Z"))).toBe(3.3);
  });

  it("switches exactly at the new plan's effectiveFrom (local date)", () => {
    // 2026-06-30T15:00Z == 2026-07-01T01:00 AEST → the July plan is now in force.
    expect(cfg.exportPriceAt(utc("2026-06-30T15:00:00Z"))).toBe(3.3);
    // 2026-06-30T13:00Z == 2026-06-30T23:00 AEST → still the January plan.
    expect(cfg.exportPriceAt(utc("2026-06-30T13:00:00Z"))).toBe(6);
  });

  it("returns null before the earliest plan's effectiveFrom", () => {
    expect(cfg.exportPriceAt(utc("2025-12-01T02:00:00Z"))).toBeNull();
  });

  it("orders plans regardless of array order", () => {
    const unordered = new ScheduleTariffProvider(
      [
        { effectiveFrom: "2026-07-01", rate: { kind: "flat", cPerKwh: 3.3 } },
        { effectiveFrom: "2026-01-01", rate: { kind: "flat", cPerKwh: 6 } },
      ],
      TZ,
    );
    expect(unordered.exportPriceAt(utc("2026-03-15T02:00:00Z"))).toBe(6);
  });
});

describe("ScheduleTariffProvider — TOU reserved", () => {
  it("throws until the TOU evaluator is built", () => {
    const p = new ScheduleTariffProvider(
      [{ rate: { kind: "tou", bands: [], defaultCPerKwh: 4 } }],
      TZ,
    );
    expect(() => p.exportPriceAt(utc("2026-03-15T02:00:00Z"))).toThrow(
      /TOU export tariffs are not implemented/,
    );
  });
});

describe("NO_TARIFF", () => {
  it("is always null", () => {
    expect(NO_TARIFF.exportPriceAt(utc("2026-03-15T02:00:00Z"))).toBeNull();
  });
});
