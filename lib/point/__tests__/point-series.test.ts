/**
 * Which aggregations a metric type actually has.
 *
 * 🛑 The case that drove this file: an energy point's `.last`. For a `transform: 'd'` point
 * `agg_5m.last` IS the meter reading — the raw lifetime counter — and `getSupportedIntervals`
 * returned `[]` for it, so nothing could read it through the history API at all. That matters when
 * a repair has to write counter values into a gap: the deltas either side are computed against the
 * neighbouring `last`, so getting them right needs the readings, and only `.delta` was reachable.
 *
 * It is deliberately still not OFFERED — see `SeriesInfo.onDemand`. `.delta` is what an energy
 * point means, and a lifetime counter on a chart is a straight line climbing to 200 MWh.
 */
import { describe, it, expect } from "@jest/globals";
import { getSupportedIntervals } from "../point-series";

describe("getSupportedIntervals", () => {
  describe("an energy counter's raw reading", () => {
    it("is available at both intervals", () => {
      expect(getSupportedIntervals("energy", "last")).toEqual(["5m", "1d"]);
    });

    it("leaves delta the primary answer", () => {
      expect(getSupportedIntervals("energy", "delta")).toEqual(["5m", "1d"]);
    });

    it("still refuses the aggregations a counter has no meaning for", () => {
      // A counter's mean/min/max over an interval say nothing; only its last value does.
      for (const f of ["avg", "min", "max"])
        expect(getSupportedIntervals("energy", f)).toEqual([]);
    });
  });

  describe("the other metric types are unchanged", () => {
    it("gives SoC `last` at both intervals and the rest only daily", () => {
      expect(getSupportedIntervals("soc", "last")).toEqual(["5m", "1d"]);
      for (const f of ["avg", "min", "max"])
        expect(getSupportedIntervals("soc", f)).toEqual(["1d"]);
    });

    it("gives power every aggregation at both intervals", () => {
      for (const f of ["avg", "min", "max", "last"])
        expect(getSupportedIntervals("power", f)).toEqual(["5m", "1d"]);
    });

    it("keeps quality 5m-only for every type", () => {
      for (const m of ["energy", "soc", "power"])
        expect(getSupportedIntervals(m, "quality")).toEqual(["5m"]);
    });
  });
});
