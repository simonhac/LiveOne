import { describe, it, expect } from "@jest/globals";
import {
  TESLA_POLL_DEFAULTS,
  estimatePolls,
  type TeslaPollConfig,
} from "../poll-config";

describe("TESLA_POLL_DEFAULTS", () => {
  it("pins the approved defaults (2-min charging cadence)", () => {
    expect(TESLA_POLL_DEFAULTS).toEqual({
      wakeToPoll: true,
      idlePollMinutes: 15,
      chargingPollMinutes: 2,
    });
  });
});

describe("estimatePolls", () => {
  const cases: Array<{
    name: string;
    config: TeslaPollConfig;
    pollsPerDay: number;
    monthlyCost: number;
    monthlyAfterCredit: number;
  }> = [
    {
      name: "Tez after the prod config change {false, 12, 2}",
      config: {
        wakeToPoll: false,
        idlePollMinutes: 12,
        chargingPollMinutes: 2,
      },
      pollsPerDay: 170,
      monthlyCost: 10.2,
      monthlyAfterCredit: 0.2,
    },
    {
      name: "Tez's stored config {false, 12, 5}, skip shipped",
      config: {
        wakeToPoll: false,
        idlePollMinutes: 12,
        chargingPollMinutes: 5,
      },
      pollsPerDay: 134,
      monthlyCost: 8.04,
      monthlyAfterCredit: 0,
    },
    {
      name: "pure defaults {true, 15, 2} — wake cost dominates",
      config: TESLA_POLL_DEFAULTS,
      pollsPerDay: 148,
      monthlyCost: 66.96,
      monthlyAfterCredit: 56.96,
    },
  ];

  it.each(cases)(
    "$name",
    ({ config, pollsPerDay, monthlyCost, monthlyAfterCredit }) => {
      const estimate = estimatePolls(config);
      expect(estimate.pollsPerDay).toBeCloseTo(pollsPerDay, 5);
      expect(estimate.monthlyCost).toBeCloseTo(monthlyCost, 5);
      expect(estimate.monthlyAfterCredit).toBeCloseTo(monthlyAfterCredit, 5);
    },
  );

  it("floors the after-credit figure at 0 for a cheap config", () => {
    const estimate = estimatePolls({
      wakeToPoll: false,
      idlePollMinutes: 60,
      chargingPollMinutes: 60,
    });
    expect(estimate.monthlyCost).toBeLessThan(10);
    expect(estimate.monthlyAfterCredit).toBe(0);
  });
});
