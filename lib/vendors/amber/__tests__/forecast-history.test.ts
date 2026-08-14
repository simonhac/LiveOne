/**
 * Tests for the change-only Amber forecast-history capture (pure logic:
 * projection + diff; the DB legs are exercised in dev, not here).
 */

import { describe, it, expect } from "@jest/globals";
import {
  projectPriceRecords,
  diffAgainstBaseline,
  candidateChanged,
  type ForecastCandidate,
} from "../forecast-history";
import type { AmberPriceRecord } from "../types";

const NEM_TIME = "2026-08-14T18:30:00+10:00";
const NEM_TIME_MS = new Date(NEM_TIME).getTime();

function forecastRecord(
  overrides: Partial<AmberPriceRecord> = {},
): AmberPriceRecord {
  return {
    type: "ForecastInterval",
    date: "2026-08-14",
    duration: 30,
    startTime: "2026-08-14T08:00:00Z",
    endTime: "2026-08-14T08:30:00Z",
    nemTime: NEM_TIME,
    perKwh: 32.5,
    renewables: 41.2,
    spotPerKwh: 12.3,
    channelType: "general",
    spikeStatus: "none",
    descriptor: "neutral",
    ...overrides,
  };
}

describe("projectPriceRecords", () => {
  it("skips ActualIntervals entirely", () => {
    expect(
      projectPriceRecords([forecastRecord({ type: "ActualInterval" })]),
    ).toEqual([]);
  });

  it("emits a channel row plus a site row for a general record", () => {
    const candidates = projectPriceRecords([
      forecastRecord({ advancedPrice: { low: 30, predicted: 32, high: 40 } }),
    ]);
    expect(candidates).toHaveLength(2);

    const channelRow = candidates.find((c) => c.channel === "general")!;
    expect(channelRow).toMatchObject({
      intervalEndMs: NEM_TIME_MS,
      intervalType: "f",
      durationMin: 30,
      perKwh: 32.5,
      advLow: 30,
      advPredicted: 32,
      advHigh: 40,
      descriptor: "neutral",
      spikeStatus: "none",
      estimate: null,
      spotPerKwh: null,
      renewables: null,
    });

    const siteRow = candidates.find((c) => c.channel === "site")!;
    expect(siteRow).toMatchObject({
      intervalEndMs: NEM_TIME_MS,
      intervalType: "f",
      perKwh: null,
      advLow: null,
      spotPerKwh: 12.3,
      renewables: 41.2,
    });
  });

  it("does not emit a site row for feedIn or controlledLoad records", () => {
    const candidates = projectPriceRecords([
      forecastRecord({ channelType: "feedIn", perKwh: -2.1 }),
      forecastRecord({ channelType: "controlledLoad", perKwh: 18.0 }),
    ]);
    expect(candidates.map((c) => c.channel).sort()).toEqual([
      "controlledLoad",
      "feedIn",
    ]);
  });

  it("maps CurrentInterval to interval_type 'c' and carries estimate", () => {
    const [row] = projectPriceRecords([
      forecastRecord({
        type: "CurrentInterval",
        channelType: "feedIn",
        estimate: true,
      }),
    ]);
    expect(row).toMatchObject({ intervalType: "c", estimate: true });
  });

  it("stores null advancedPrice fields when Amber omits the band", () => {
    const [row] = projectPriceRecords([
      forecastRecord({ channelType: "feedIn" }),
    ]);
    expect(row.advLow).toBeNull();
    expect(row.advPredicted).toBeNull();
    expect(row.advHigh).toBeNull();
  });
});

describe("diffAgainstBaseline / candidateChanged", () => {
  const baselineOf = (candidates: ForecastCandidate[]) =>
    new Map(candidates.map((c) => [`${c.channel}|${c.intervalEndMs}`, c]));

  it("treats first sighting as a change", () => {
    const candidates = projectPriceRecords([forecastRecord()]);
    expect(diffAgainstBaseline(candidates, new Map())).toHaveLength(2);
  });

  it("emits zero rows for an identical repoll", () => {
    const candidates = projectPriceRecords([
      forecastRecord({ advancedPrice: { low: 30, predicted: 32, high: 40 } }),
    ]);
    expect(diffAgainstBaseline(candidates, baselineOf(candidates))).toEqual([]);
  });

  it("ignores price moves under 0.1 c/kWh but catches real ones", () => {
    const [base] = projectPriceRecords([forecastRecord({ perKwh: 32.5 })]);
    const [noisy] = projectPriceRecords([forecastRecord({ perKwh: 32.55 })]);
    const [moved] = projectPriceRecords([forecastRecord({ perKwh: 32.65 })]);
    expect(candidateChanged(noisy, base)).toBe(false);
    expect(candidateChanged(moved, base)).toBe(true);
    // Deliberately not asserted at exactly 0.1: float makes 32.6 - 32.5 land
    // fractionally over, and which side of the boundary that falls on is not
    // behaviour worth pinning.
  });

  it("applies the same 0.1 threshold to the advancedPrice band", () => {
    const band = (low: number, predicted: number, high: number) =>
      projectPriceRecords([
        forecastRecord({ advancedPrice: { low, predicted, high } }),
      ])[0];
    const base = band(30, 32, 40);
    // The band twitches every poll — this is the churn the threshold exists for.
    expect(candidateChanged(band(30.02, 32.04, 40.06), base)).toBe(false);
    // A move on any ONE leg is still a change.
    expect(candidateChanged(band(30, 32, 40.2), base)).toBe(true);
  });

  it("applies a 0.1 percentage-point threshold to renewables", () => {
    const site = (renewables: number) =>
      projectPriceRecords([forecastRecord({ renewables })])[1];
    expect(candidateChanged(site(41.25), site(41.2))).toBe(false);
    expect(candidateChanged(site(41.35), site(41.2))).toBe(true);
  });

  it("trips on accumulated creep, because the baseline is the last STORED row", () => {
    // Four polls each drifting 0.04 c/kWh: none clears the threshold on its own,
    // but the total does — so the stored series never lags reality by > epsilon.
    const at = (perKwh: number) =>
      projectPriceRecords([forecastRecord({ perKwh })])[0];
    let stored = at(32.5);
    const kept: number[] = [];
    for (const perKwh of [32.54, 32.58, 32.62, 32.66]) {
      const candidate = at(perKwh);
      if (candidateChanged(candidate, stored)) {
        kept.push(perKwh);
        stored = candidate;
      }
    }
    expect(kept).toEqual([32.62]); // 32.62 - 32.5 = 0.12 > 0.1; then the clock resets
  });

  it("treats null↔value transitions on advancedPrice as changes", () => {
    const [withBand] = projectPriceRecords([
      forecastRecord({ advancedPrice: { low: 30, predicted: 32, high: 40 } }),
    ]);
    const [withoutBand] = projectPriceRecords([forecastRecord()]);
    expect(candidateChanged(withBand, withoutBand)).toBe(true);
    expect(candidateChanged(withoutBand, withBand)).toBe(true);
  });

  it("triggers on discrete-field-only changes (descriptor / spikeStatus)", () => {
    const [base] = projectPriceRecords([forecastRecord()]);
    const [spiky] = projectPriceRecords([
      forecastRecord({ spikeStatus: "potential" }),
    ]);
    const [described] = projectPriceRecords([
      forecastRecord({ descriptor: "high" }),
    ]);
    expect(candidateChanged(spiky, base)).toBe(true);
    expect(candidateChanged(described, base)).toBe(true);
  });

  it("records the f→c transition even when values are unchanged", () => {
    const [asForecast] = projectPriceRecords([forecastRecord()]);
    const [asCurrent] = projectPriceRecords([
      forecastRecord({ type: "CurrentInterval", estimate: true }),
    ]);
    expect(candidateChanged(asCurrent, asForecast)).toBe(true);
  });

  it("only diffs against the matching (channel, interval) baseline", () => {
    const general = projectPriceRecords([forecastRecord()]);
    const feedIn = projectPriceRecords([
      forecastRecord({ channelType: "feedIn", perKwh: -2.1 }),
    ]);
    // A general-channel baseline says nothing about feedIn: feedIn is fresh.
    expect(diffAgainstBaseline(feedIn, baselineOf(general))).toHaveLength(1);
  });
});
