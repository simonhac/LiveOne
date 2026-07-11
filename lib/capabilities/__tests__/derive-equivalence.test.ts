/**
 * Equivalence gate for the capability model.
 *
 * Proves — EXHAUSTIVELY over the power set of the realistic point-path universe — that deriving
 * capabilities from `latest` and filtering the catalog reproduces the ORIGINAL hardcoded string-path
 * derivers BYTE-IDENTICALLY:
 *   availableTilesFromCaps(capabilitiesFromLatest(latest)) === (old availableTiles)
 *   satisfies(caps, CARD_CATALOG.chart.requires)          === (old chartHasData)
 *
 * The old `availableTiles`/`chartHasData` (formerly in lib/dashboard/cards.ts) were deleted at the P5
 * cleanup once the capability model replaced them; their exact logic is INLINED here as the reference
 * oracle so this invariant is pinned permanently, not just during the transition.
 */
import { describe, it, expect } from "@jest/globals";
import type { LatestPointValue, LatestPointValues } from "@/lib/types/api";
import { capabilitiesFromLatest } from "@/lib/capabilities/derive";
import {
  availableTilesFromCaps,
  CARD_CATALOG,
  satisfies,
  TILE_ORDER,
  type TileId,
} from "@/lib/capabilities/catalog";

// ── The original derivers, inlined verbatim as the reference oracle ─────────────────────────────
const LEGACY_TILE_IDS: readonly TileId[] = [
  "solar",
  "load",
  "hotWater",
  "battery",
  "house-to-grid",
  "amber",
  "ev",
];
const hasVal = (latest: LatestPointValues, path: string): boolean =>
  latest[path]?.value != null;
function legacyAvailableTiles(latest: LatestPointValues): TileId[] {
  const solar =
    hasVal(latest, "source.solar/power") ||
    hasVal(latest, "source.solar.local/power") ||
    hasVal(latest, "source.solar.remote/power");
  const anyLoad =
    hasVal(latest, "load/power") ||
    Object.keys(latest).some(
      (p) => p.startsWith("load.") && p.endsWith("/power") && hasVal(latest, p),
    );
  const load =
    anyLoad ||
    solar ||
    hasVal(latest, "bidi.battery/power") ||
    hasVal(latest, "bidi.grid/power");
  const available: Record<TileId, boolean> = {
    solar,
    load,
    hotWater: hasVal(latest, "load.hws/temperature"),
    battery: hasVal(latest, "bidi.battery/soc"),
    "house-to-grid": hasVal(latest, "bidi.grid/power"),
    amber: hasVal(latest, "bidi.grid.import/rate"),
    ev: hasVal(latest, "ev.battery/soc"),
  };
  return LEGACY_TILE_IDS.filter((id) => available[id]);
}
function legacyChartHasData(latest: LatestPointValues): boolean {
  const solar =
    hasVal(latest, "source.solar/power") ||
    hasVal(latest, "source.solar.local/power") ||
    hasVal(latest, "source.solar.remote/power");
  const load =
    hasVal(latest, "load/power") ||
    Object.keys(latest).some(
      (p) => p.startsWith("load.") && p.endsWith("/power") && hasVal(latest, p),
    ) ||
    solar ||
    hasVal(latest, "bidi.battery/power") ||
    hasVal(latest, "bidi.grid/power");
  return solar && load;
}

/** Every logical path any of the 3 live installs (or the original derivers) can carry. */
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

describe("capability model reproduces the original derivers", () => {
  it("catalog tile order matches the original TILE_IDS", () => {
    expect([...TILE_ORDER]).toEqual([...LEGACY_TILE_IDS]);
  });

  it("availableTilesFromCaps ∘ capabilitiesFromLatest === (old availableTiles), for EVERY path subset", () => {
    const total = 1 << UNIVERSE.length; // 2^11 = 2048 combinations
    for (let mask = 0; mask < total; mask++) {
      const latest = latestForMask(mask);
      const viaCaps = availableTilesFromCaps(capabilitiesFromLatest(latest));
      const viaLegacy = legacyAvailableTiles(latest);
      if (viaCaps.join(",") !== viaLegacy.join(",")) {
        expect({ mask, paths: Object.keys(latest), viaCaps }).toEqual({
          mask,
          paths: Object.keys(latest),
          viaCaps: viaLegacy,
        });
      }
    }
  });

  it("chart eligibility from capabilities === (old chartHasData), for EVERY path subset", () => {
    const total = 1 << UNIVERSE.length;
    for (let mask = 0; mask < total; mask++) {
      const latest = latestForMask(mask);
      const caps = capabilitiesFromLatest(latest);
      expect(satisfies(caps, CARD_CATALOG.chart.requires)).toBe(
        legacyChartHasData(latest),
      );
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
    expect(legacyAvailableTiles(latest)).toEqual([]);
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
    expect(availableTilesFromCaps(caps)).toEqual(legacyAvailableTiles(latest));
    expect(satisfies(caps, CARD_CATALOG.chart.requires)).toBe(
      legacyChartHasData(latest),
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
    expect(availableTilesFromCaps(caps)).toEqual(legacyAvailableTiles(latest));
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
    expect(availableTilesFromCaps(caps)).toEqual(legacyAvailableTiles(latest));
    expect(satisfies(caps, CARD_CATALOG.chart.requires)).toBe(
      legacyChartHasData(latest),
    );
  });
});
