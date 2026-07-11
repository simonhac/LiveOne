/**
 * Equivalence gate for the capability model (P3 acceptance test = P0 rendering-parity spec).
 *
 * Proves — EXHAUSTIVELY over the power set of the realistic point-path universe — that deriving
 * capabilities from `latest` and filtering the catalog reproduces today's hardcoded string-path
 * derivers BYTE-IDENTICALLY:
 *   availableTilesFromCaps(capabilitiesFromLatest(latest)) === availableTiles(latest)
 *   satisfies(caps, CARD_CATALOG.chart.requires)          === chartHasData(latest)
 *
 * When this stays green, the P4 cutover (repoint availableTiles/chartHasData at the capability model)
 * cannot change behaviour for any combination of the paths the 3 live installs carry.
 */
import { describe, it, expect } from "@jest/globals";
import type { LatestPointValue, LatestPointValues } from "@/lib/types/api";
import { availableTiles, chartHasData, TILE_IDS } from "@/lib/dashboard/cards";
import { capabilitiesFromLatest } from "@/lib/capabilities/derive";
import {
  availableTilesFromCaps,
  CARD_CATALOG,
  satisfies,
  TILE_ORDER,
} from "@/lib/capabilities/catalog";

/** Every logical path any of the 3 live installs (or the current derivers) can carry. */
const UNIVERSE = [
  "source.solar/power",
  "source.solar.local/power",
  "source.solar.remote/power",
  "load/power",
  "load.hvac/power", // a `load.<sub>` example (anyLoad matches load.*/power)
  "bidi.battery/power",
  "bidi.battery/soc",
  "bidi.grid/power",
  "bidi.grid.import/rate",
  "ev.battery/soc",
  "load.hws/temperature",
] as const;

const mkValue = (path: string): LatestPointValue => ({
  value: 1,
  logicalPath: path,
  measurementTime: new Date(0),
  metricUnit: "W",
  displayName: path,
});

/** Build a `latest` map containing exactly the paths whose bit is set in `mask`. */
function latestForMask(mask: number): LatestPointValues {
  const latest: LatestPointValues = {};
  for (let i = 0; i < UNIVERSE.length; i++) {
    if (mask & (1 << i)) latest[UNIVERSE[i]] = mkValue(UNIVERSE[i]);
  }
  return latest;
}

describe("capability model reproduces the current derivers", () => {
  it("catalog tile order matches TILE_IDS", () => {
    expect([...TILE_ORDER]).toEqual([...TILE_IDS]);
  });

  it("availableTilesFromCaps ∘ capabilitiesFromLatest === availableTiles, for EVERY path subset", () => {
    const total = 1 << UNIVERSE.length; // 2^11 = 2048 combinations
    for (let mask = 0; mask < total; mask++) {
      const latest = latestForMask(mask);
      const viaCaps = availableTilesFromCaps(capabilitiesFromLatest(latest));
      const viaLegacy = availableTiles(latest);
      // Compare as ordered id lists (both are TILE_IDS-ordered).
      if (viaCaps.join(",") !== viaLegacy.join(",")) {
        // Surface the offending subset for debuggability.
        expect({ mask, paths: Object.keys(latest), viaCaps }).toEqual({
          mask,
          paths: Object.keys(latest),
          viaCaps: viaLegacy,
        });
      }
    }
  });

  it("chart eligibility from capabilities === chartHasData, for EVERY path subset", () => {
    const total = 1 << UNIVERSE.length;
    for (let mask = 0; mask < total; mask++) {
      const latest = latestForMask(mask);
      const caps = capabilitiesFromLatest(latest);
      const viaCaps = satisfies(caps, CARD_CATALOG.chart.requires);
      expect(viaCaps).toBe(chartHasData(latest));
    }
  });

  it("null-valued points do not contribute capabilities (hasVal parity)", () => {
    const latest: LatestPointValues = {
      "source.solar/power": {
        ...mkValue("source.solar/power"),
        value: null as unknown as number,
      },
    };
    expect(availableTilesFromCaps(capabilitiesFromLatest(latest))).toEqual([]);
    expect(availableTiles(latest)).toEqual([]);
  });
});

describe("representative live-install shapes", () => {
  const build = (paths: string[]): LatestPointValues =>
    Object.fromEntries(paths.map((p) => [p, mkValue(p)]));

  it("kew (sigenergy area-of-one): solar+battery+load+grid+ev tiles", () => {
    const latest = build([
      "source.solar/power",
      "bidi.battery/power",
      "bidi.battery/soc",
      "load/power",
      "bidi.grid/power",
      "ev.battery/soc",
    ]);
    const caps = capabilitiesFromLatest(latest);
    expect(availableTilesFromCaps(caps)).toEqual(availableTiles(latest));
    expect(satisfies(caps, CARD_CATALOG.chart.requires)).toBe(
      chartHasData(latest),
    );
  });

  it("kinkora (multi-device area): full set + amber + hot water", () => {
    const latest = build([
      "source.solar/power",
      "bidi.battery/power",
      "bidi.battery/soc",
      "load/power",
      "load.hws/temperature",
      "bidi.grid/power",
      "bidi.grid.import/rate",
      "ev.battery/soc",
    ]);
    const caps = capabilitiesFromLatest(latest);
    expect(availableTilesFromCaps(caps)).toEqual(availableTiles(latest));
  });

  it("daylesford (selectronic): solar+battery+load+grid, no amber/ev/hws", () => {
    const latest = build([
      "source.solar/power",
      "bidi.battery/power",
      "bidi.battery/soc",
      "load/power",
      "bidi.grid/power",
    ]);
    const caps = capabilitiesFromLatest(latest);
    expect(availableTilesFromCaps(caps)).toEqual(availableTiles(latest));
    expect(satisfies(caps, CARD_CATALOG.chart.requires)).toBe(
      chartHasData(latest),
    );
  });
});
