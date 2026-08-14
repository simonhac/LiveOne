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

  it("ignores float noise within epsilon but catches real moves", () => {
    const [base] = projectPriceRecords([forecastRecord({ perKwh: 0.3 })]);
    const [noisy] = projectPriceRecords([
      forecastRecord({ perKwh: 0.1 + 0.2 }), // 0.30000000000000004
    ]);
    const [moved] = projectPriceRecords([forecastRecord({ perKwh: 0.31 })]);
    expect(candidateChanged(noisy, base)).toBe(false);
    expect(candidateChanged(moved, base)).toBe(true);
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
