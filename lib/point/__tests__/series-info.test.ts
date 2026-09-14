/**
 * `SeriesInfo.onDemandIntervals` and the listing filter over it.
 *
 * A series can exist, be queryable by name, and still be absent from "what does this subject have?"
 * — and since 2026-09-15 that judgement is per INTERVAL. The regression this guards is specific:
 * a SoC point's `avg`/`min`/`max` became reachable at 5m, and marking them on demand with the old
 * boolean would have silently removed them from the 1d listings they have always been part of.
 */
import { describe, it, expect } from "@jest/globals";
import { isWithheldFromListing, type SeriesInfo } from "../series-info";

/** Only the three fields `isWithheldFromListing` reads. */
const series = (
  intervals: ("5m" | "1d")[],
  onDemand?: ("5m" | "1d")[],
): SeriesInfo =>
  ({
    intervals,
    ...(onDemand ? { onDemandIntervals: new Set(onDemand) } : {}),
  }) as SeriesInfo;

describe("isWithheldFromListing", () => {
  it("never withholds a series with no onDemandIntervals", () => {
    const s = series(["5m", "1d"]);
    expect(isWithheldFromListing(s)).toBe(false);
    expect(isWithheldFromListing(s, "5m")).toBe(false);
    expect(isWithheldFromListing(s, "1d")).toBe(false);
  });

  describe("an energy counter's `.last` — on demand everywhere", () => {
    const counter = series(["5m", "1d"], ["5m", "1d"]);

    it("is withheld at each interval", () => {
      expect(isWithheldFromListing(counter, "5m")).toBe(true);
      expect(isWithheldFromListing(counter, "1d")).toBe(true);
    });

    it("is withheld from the interval-less metadata listing too", () => {
      // `?list=series` passes no interval on purpose. A series withheld in every interval it
      // supports is not part of the answer to "what does this device have" in any of them.
      expect(isWithheldFromListing(counter)).toBe(true);
    });
  });

  describe("a SoC `avg` — on demand at 5m, listed at 1d", () => {
    const socAvg = series(["5m", "1d"], ["5m"]);

    it("is withheld at 5m", () => {
      expect(isWithheldFromListing(socAvg, "5m")).toBe(true);
    });

    it("🛑 is NOT withheld at 1d — its long-standing place in that listing is unchanged", () => {
      expect(isWithheldFromListing(socAvg, "1d")).toBe(false);
    });

    it("🛑 is NOT withheld from the interval-less listing", () => {
      // The listing reports each entry's own `intervals`, so keeping it here is what tells a reader
      // the 1d series exists at all. Dropping it would have been the regression.
      expect(isWithheldFromListing(socAvg)).toBe(false);
    });
  });

  it("withholds a single-interval series that is on demand in it", () => {
    expect(isWithheldFromListing(series(["5m"], ["5m"]))).toBe(true);
  });

  it("ignores an on-demand interval the series does not support", () => {
    // Defensive: a 1d-only series marked on demand at 5m is listed, not hidden by a marker that
    // names an interval it never serves.
    expect(isWithheldFromListing(series(["1d"], ["5m"]))).toBe(false);
    expect(isWithheldFromListing(series(["1d"], ["5m"]), "1d")).toBe(false);
  });
});
