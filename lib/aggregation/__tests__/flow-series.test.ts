import { describe, it, expect } from "@jest/globals";
import {
  resolveSolarSources,
  SOLAR_RESIDUAL_PATH,
  splitSignedSeries,
  sumSeries,
  computeRestOfHouse,
  buildFlowSeries,
  ClassifiedPoint,
} from "../flow-series";

describe("resolveSolarSources", () => {
  it("uses the leaves and drops the bare total when they sum to it (no residual)", () => {
    const out = resolveSolarSources([
      { path: "source.solar", power: [8, 8] }, // bare total = local + remote
      { path: "source.solar.local", power: [5, 5] },
      { path: "source.solar.remote", power: [3, 3] },
    ]);
    expect(out.map((s) => s.path)).toEqual([
      "source.solar.local",
      "source.solar.remote",
    ]);
  });

  it("adds source.solar.residual for the unmetered shortfall (leaves < total)", () => {
    const out = resolveSolarSources([
      { path: "source.solar", power: [10, 10] },
      { path: "source.solar.local", power: [5, 5] },
      { path: "source.solar.remote", power: [3, 3] },
    ]);
    const residual = out.find((s) => s.path === SOLAR_RESIDUAL_PATH);
    expect(residual).toBeDefined();
    expect(residual!.power).toEqual([2, 2]); // 10 - (5 + 3)
  });

  it("uses the bare total as the single node when there are no leaves", () => {
    expect(
      resolveSolarSources([{ path: "source.solar", power: [7, 7] }]),
    ).toEqual([{ path: "source.solar", power: [7, 7] }]);
  });

  it("returns nothing when there is no solar", () => {
    expect(resolveSolarSources([])).toEqual([]);
  });

  it("de-duplicates a repeated bare total", () => {
    expect(
      resolveSolarSources([
        { path: "source.solar", power: [4, 4] },
        { path: "source.solar", power: [4, 4] },
      ]),
    ).toEqual([{ path: "source.solar", power: [4, 4] }]);
  });

  it("drops a sub-epsilon residual as measurement noise", () => {
    const out = resolveSolarSources([
      { path: "source.solar", power: [8.01, 8.01] }, // 10 W over the leaves (< 20 W eps)
      { path: "source.solar.local", power: [5, 5] },
      { path: "source.solar.remote", power: [3, 3] },
    ]);
    expect(out.some((s) => s.path === SOLAR_RESIDUAL_PATH)).toBe(false);
  });
});

describe("splitSignedSeries", () => {
  it("sends positive→source and |negative|→load, preserving nulls", () => {
    const { positive, negative } = splitSignedSeries(
      [5, -3, 0, null],
      "source.battery",
      "load.battery",
    );
    expect(positive).toEqual({
      path: "source.battery",
      power: [5, 0, 0, null],
    });
    expect(negative).toEqual({ path: "load.battery", power: [0, 3, 0, null] });
  });
});

describe("sumSeries", () => {
  it("sums per interval and is null if any contributor is null", () => {
    expect(
      sumSeries([
        [1, 2, 3],
        [4, null, 6],
      ]),
    ).toEqual([5, null, 9]);
  });

  it("returns [] for no arrays", () => {
    expect(sumSeries([])).toEqual([]);
  });
});

describe("computeRestOfHouse", () => {
  it("Case 1: master − children, clamped ≥ 0", () => {
    expect(computeRestOfHouse([10, 4], [3, 5], null, null, null)).toEqual([
      7, 0,
    ]);
  });

  it("Case 2: master with no children → none", () => {
    expect(computeRestOfHouse([10], null, null, null, null)).toBeNull();
  });

  it("Case 3: no master → generation − charge − export − children", () => {
    expect(computeRestOfHouse(null, [3], [2], [1], [10])).toEqual([4]);
  });

  it("returns null when neither master nor generation is available", () => {
    expect(computeRestOfHouse(null, [3], null, null, null)).toBeNull();
  });
});

describe("buildFlowSeries", () => {
  it("assembles canonical solar leaves, battery/grid split, children and rest-of-house", () => {
    const points: ClassifiedPoint[] = [
      { stem: "source.solar", power: [8, 8] }, // bare total = local + remote
      { stem: "source.solar.local", power: [5, 5] },
      { stem: "source.solar.remote", power: [3, 3] },
      { stem: "bidi.battery", power: [2, 2] }, // + = discharge (source)
      { stem: "bidi.grid", power: [1, 1] }, // + = import (source)
      { stem: "load.hws", power: [4, 4] },
    ];
    const { sources, loads } = buildFlowSeries(points);

    expect(new Set(sources.map((s) => s.path))).toEqual(
      new Set([
        "source.solar.local",
        "source.solar.remote",
        "source.battery",
        "source.grid",
      ]),
    );
    const loadPaths = loads.map((l) => l.path);
    expect(loadPaths).toEqual(
      expect.arrayContaining([
        "load.battery",
        "load.grid",
        "load.hws",
        "load.rest-of-house",
      ]),
    );
    // rest-of-house = Σgen(5+3+2+1) − charge(0) − export(0) − hws(4) = 7
    expect(loads.find((l) => l.path === "load.rest-of-house")!.power).toEqual([
      7, 7,
    ]);
  });

  it("splits a bidirectional battery into a charge-load and a discharge-source", () => {
    const points: ClassifiedPoint[] = [
      { stem: "source.solar.local", power: [10, 0] },
      { stem: "bidi.battery", power: [-4, 2] }, // charge then discharge
      { stem: "load", power: [6, 2] },
    ];
    const { sources, loads } = buildFlowSeries(points);
    expect(sources.find((s) => s.path === "source.battery")!.power).toEqual([
      0, 2,
    ]);
    expect(loads.find((l) => l.path === "load.battery")!.power).toEqual([4, 0]);
    // Master load present with no children → no rest-of-house.
    expect(loads.some((l) => l.path === "load.rest-of-house")).toBe(false);
  });
});
