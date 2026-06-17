import { describe, it, expect } from "@jest/globals";
import {
  EMISSIONS_INTENSITY_POINT,
  PRICE_POINT,
  RENEWABLE_PROPORTION_POINT,
  buildReadingsFromResponses,
} from "../point-metadata";
import type { OeNetworkResponse } from "../types";

const DAY = Date.UTC(2026, 0, 1, 0, 0, 0);
const startMs = (h: number, m: number) => DAY + h * 3600_000 + m * 60_000;
const iso = (h: number, m: number) => new Date(startMs(h, m)).toISOString();

const dataResp: OeNetworkResponse = {
  success: true,
  data: [
    {
      metric: "power",
      unit: "MW",
      results: [
        {
          name: "NSW1.power",
          data: [
            [iso(10, 0), 600], // 600 MW × (5/60) h = 50 MWh
            [iso(10, 5), 0], // no generation → intensity skipped
          ],
        },
      ],
    },
    {
      metric: "emissions",
      unit: "t",
      results: [
        {
          name: "NSW1.emissions",
          data: [
            [iso(10, 0), 30], // 30 t / 50 MWh = 0.6 tCO2e/MWh
            [iso(10, 5), 5],
          ],
        },
      ],
    },
  ],
};

const marketResp: OeNetworkResponse = {
  success: true,
  data: [
    {
      metric: "price",
      unit: "$/MWh",
      results: [
        {
          name: "NSW1.price",
          data: [
            [iso(10, 0), 80.5],
            [iso(10, 5), null], // null skipped
          ],
        },
      ],
    },
    {
      metric: "renewable_proportion",
      unit: "%",
      results: [{ name: "NSW1.renew", data: [[iso(10, 0), 42.1]] }],
    },
  ],
};

describe("buildReadingsFromResponses", () => {
  const readings = buildReadingsFromResponses(dataResp, marketResp, "5m");

  it("computes emissions intensity = emissions ÷ energy (energy from power at 5m)", () => {
    const intensity = readings.filter(
      (r) => r.pointMetadata === EMISSIONS_INTENSITY_POINT,
    );
    expect(intensity).toHaveLength(1); // 10:05 power=0 skipped
    expect(intensity[0].rawValue).toBeCloseTo(0.6, 6);
  });

  it("labels readings by interval END (start + 5 min)", () => {
    const intensity = readings.find(
      (r) => r.pointMetadata === EMISSIONS_INTENSITY_POINT,
    )!;
    expect(intensity.intervalEndMs).toBe(startMs(10, 0) + 5 * 60 * 1000);
  });

  it("passes price and renewable proportion through directly, skipping nulls", () => {
    const price = readings.filter((r) => r.pointMetadata === PRICE_POINT);
    const renew = readings.filter(
      (r) => r.pointMetadata === RENEWABLE_PROPORTION_POINT,
    );
    expect(price).toHaveLength(1); // 10:05 null skipped
    expect(price[0].rawValue).toBe(80.5);
    expect(price[0].intervalEndMs).toBe(startMs(10, 0) + 5 * 60 * 1000);
    expect(renew).toHaveLength(1);
    expect(renew[0].rawValue).toBe(42.1);
  });

  it("produces exactly the three expected readings for this fixture", () => {
    expect(readings).toHaveLength(3);
  });

  it("skips intensity when emissions/power data is missing", () => {
    const onlyMarket = buildReadingsFromResponses(undefined, marketResp, "5m");
    expect(
      onlyMarket.some((r) => r.pointMetadata === EMISSIONS_INTENSITY_POINT),
    ).toBe(false);
    expect(onlyMarket).toHaveLength(2); // price + renewables only
  });

  it("skips intensity when emissions is 0 but power > 0 (transient OE artifact)", () => {
    // The OE API can return a spurious 0 for the freshest/settling interval; a 0 emissions
    // with real generation would compute a non-physical 0 intensity, so the interval is
    // skipped (intensity undefined) rather than emitting a bogus 0.
    const zeroEmissions: OeNetworkResponse = {
      success: true,
      data: [
        {
          metric: "power",
          unit: "MW",
          results: [{ name: "NSW1.power", data: [[iso(10, 0), 600]] }],
        },
        {
          metric: "emissions",
          unit: "t",
          results: [{ name: "NSW1.emissions", data: [[iso(10, 0), 0]] }],
        },
      ],
    };
    const out = buildReadingsFromResponses(zeroEmissions, undefined, "5m");
    expect(out.some((r) => r.pointMetadata === EMISSIONS_INTENSITY_POINT)).toBe(
      false,
    );
    expect(out).toHaveLength(0);
  });
});
