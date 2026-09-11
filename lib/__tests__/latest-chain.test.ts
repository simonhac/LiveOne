import { describe, expect, it } from "@jest/globals";
import {
  CHAIN_FALLBACK_STALE_MS,
  chainFallbackField,
  resolveChainFields,
  type LatestValue,
  type LatestValuesMap,
} from "../latest-values-store";

const NOW = 1_764_000_000_000;

function value(
  displayName: string,
  ageMs: number,
  overrides: Partial<LatestValue> = {},
): LatestValue {
  return {
    value: 42,
    logicalPath: "bidi.battery/soc",
    measurementTimeMs: NOW - ageMs,
    receivedTimeMs: NOW - ageMs,
    metricUnit: "%",
    displayName,
    ...overrides,
  };
}

const FRESH = 60_000;
const STALE = CHAIN_FALLBACK_STALE_MS + 60_000;

const resolve = (raw: LatestValuesMap) => resolveChainFields(raw, NOW);

describe("chain fallback fields in the latest map", () => {
  it("names a fallback's field but leaves the winner on the bare path", () => {
    expect(chainFallbackField("bidi.battery/soc", 0)).toBe("bidi.battery/soc");
    expect(chainFallbackField("bidi.battery/soc", 1)).toBe(
      "bidi.battery/soc#1",
    );
  });

  it("returns an uncontended map byte-identical — not a rebuilt copy", () => {
    // The overwhelming majority of hashes have no `#` field at all. Identity, not just equality, so
    // the fast path is pinned: a regression that rebuilt every map would still pass on `toEqual`.
    const raw = { "load/power": value("Load", FRESH) };
    expect(resolve(raw)).toBe(raw);
  });

  it("serves the winner while it is fresh, and hides the fallback's field", () => {
    const resolved = resolve({
      "bidi.battery/soc": value("Mondo", FRESH),
      "bidi.battery/soc#1": value("Fronius", FRESH),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Mondo");
    expect(Object.keys(resolved)).toEqual(["bidi.battery/soc"]);
  });

  it("promotes the fallback once the winner goes stale", () => {
    // The defect this exists for: binding Mondo alone left Kinkora with NO soc if Mondo's feed
    // stopped, even though the Fronius was still measuring the same battery.
    const resolved = resolve({
      "bidi.battery/soc": value("Mondo", STALE),
      "bidi.battery/soc#1": value("Fronius", FRESH),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Fronius");
  });

  it("keeps the winner when NOTHING is fresh, rather than promoting a corpse", () => {
    // A wholly offline site reads exactly as it did before chains existed: the preferred
    // instrument's last value. Promoting an equally dead fallback would change which device the
    // number came from for no gain at all.
    const resolved = resolve({
      "bidi.battery/soc": value("Mondo", STALE),
      "bidi.battery/soc#1": value("Fronius", STALE * 2),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Mondo");
  });

  it("serves the fallback when the winner has never published at all", () => {
    const resolved = resolve({ "bidi.battery/soc#1": value("Fronius", FRESH) });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Fronius");
  });

  it("takes the best-ranked fresh member of a three-deep chain", () => {
    const resolved = resolve({
      "bidi.battery/soc": value("first", STALE),
      "bidi.battery/soc#1": value("second", FRESH),
      "bidi.battery/soc#2": value("third", FRESH),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("second");
  });

  it("holds the boundary: exactly at the threshold the winner still serves", () => {
    const resolved = resolve({
      "bidi.battery/soc": value("Mondo", CHAIN_FALLBACK_STALE_MS),
      "bidi.battery/soc#1": value("Fronius", FRESH),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Mondo");
  });

  it("treats an entry with no measurement time as unusable, never as fresh", () => {
    const broken = value("Mondo", FRESH);
    delete (broken as Partial<LatestValue>).measurementTimeMs;
    const resolved = resolve({
      "bidi.battery/soc": broken,
      "bidi.battery/soc#1": value("Fronius", FRESH),
    });
    expect(resolved["bidi.battery/soc"].displayName).toBe("Fronius");
  });

  it("resolves each chained path independently and passes the rest through", () => {
    const resolved = resolve({
      "bidi.battery/soc": value("Mondo", STALE),
      "bidi.battery/soc#1": value("Fronius", FRESH),
      "bidi.grid/power": value("Grid", FRESH),
      "load/power#1": value("Spare load", FRESH),
    });
    expect(
      Object.fromEntries(
        Object.entries(resolved).map(([k, v]) => [k, v.displayName]),
      ),
    ).toEqual({
      "bidi.battery/soc": "Fronius",
      "bidi.grid/power": "Grid",
      "load/power": "Spare load",
    });
  });
});
