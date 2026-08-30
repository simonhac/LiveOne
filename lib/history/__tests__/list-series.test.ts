import { describe, it, expect, jest } from "@jest/globals";

// The pure core is under test; the IO wrapper's collaborators are stubbed so importing the module
// pulls no DB or registry machinery.
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: () => ({}) },
}));
jest.mock("@/lib/point/series-info", () => ({
  getSeriesPath: (s: {
    point: { getPath: () => string };
    aggregationField: string;
  }) => ({
    toString: () => `13/${s.point.getPath()}.${s.aggregationField}`,
  }),
}));
jest.mock("@/lib/readings/dao", () => ({ ReadingsDao: {} }));
jest.mock("@/lib/ids", () => ({
  Point: { encode: (uuid: string) => `pt_${uuid}` },
}));

import { renderSeriesListing } from "../list-series";

function fakeSeries(opts: {
  uid: string;
  path: string;
  aggField: string;
  metricType: string;
  metricUnit: string;
  name?: string;
  intervals?: ("5m" | "1d")[];
}) {
  return {
    systemIdentifier: {} as never,
    point: {
      pointUid: opts.uid,
      metricType: opts.metricType,
      metricUnit: opts.metricUnit,
      name: opts.name ?? "P",
      getPath: () => opts.path,
    },
    aggregationField: opts.aggField,
    intervals: opts.intervals ?? ["5m", "1d"],
  } as never;
}

describe("renderSeriesListing", () => {
  it("emits the real metric type, coverage local to the subject, and the glob-matchable path", () => {
    const s = fakeSeries({
      uid: "u1",
      path: "load/energy",
      aggField: "delta",
      metricType: "energy",
      metricUnit: "kWh",
      name: "Load Energy",
    });
    const coverage = new Map([
      [
        "pt_u1" as never,
        {
          firstMs: Date.parse("2026-08-29T14:00:00Z"),
          lastMs: Date.parse("2026-08-30T03:55:00Z"),
          samples: 168,
        },
      ],
    ]);
    expect(renderSeriesListing([s], coverage as never, 600)).toEqual([
      {
        id: "13/load/energy.delta",
        path: "load/energy.delta",
        label: "Load Energy",
        // NOT the OpenNEM payload's hardcoded "power" — discovery needs the truth.
        metricType: "energy",
        aggField: "delta",
        units: "kWh",
        intervals: ["5m", "1d"],
        firstData: "2026-08-30T00:00:00+10:00",
        lastData: "2026-08-30T13:55:00+10:00",
        samples: 168,
      },
    ]);
  });

  it("keeps 1d-only series and renders missing coverage as nulls", () => {
    // A soc avg is declared at 1d only — an interval filter would hide it, so the listing
    // deliberately has none; and a point with no agg rows must still be listed.
    const s = fakeSeries({
      uid: "u2",
      path: "bidi.battery/soc",
      aggField: "avg",
      metricType: "soc",
      metricUnit: "%",
      intervals: ["1d"],
    });
    const out = renderSeriesListing([s], new Map() as never, 600);
    expect(out).toHaveLength(1);
    expect(out[0].intervals).toEqual(["1d"]);
    expect(out[0].firstData).toBeNull();
    expect(out[0].lastData).toBeNull();
    expect(out[0].samples).toBeNull();
  });
});
