/**
 * `droppedConfigPaths` — the audit behind `liveone device config lint`.
 *
 * The parser itself is covered end-to-end by `app/api/admin/__tests__/device-config-route.test.ts`,
 * whose `FULL_CONFIG` round-trip is the guard against a live field being silently destroyed. What is
 * tested HERE is the other direction: that the diff correctly names what a save WOULD discard, since
 * that string is the only warning an operator gets before `--apply` throws the value away.
 *
 * 🛑 The diff is computed structurally, never from a list of retired keys. A hard-coded
 * `["exportTariff"]` would pass every test below and catch nothing the NEXT time a key is deleted —
 * which is the whole failure this tool exists to prevent (#481 deleted `exportTariff` from the code
 * and swept zero rows). The `unknownFuture` case pins that.
 */
import { describe, it, expect } from "@jest/globals";
import {
  parseDeviceConfig,
  droppedConfigPaths,
} from "@/lib/capabilities/parse-config";

describe("droppedConfigPaths", () => {
  it("names a retired key by its full dotted path", () => {
    // The real prod case: Kinkora Mondo, weeks after #481 deleted the field from the code.
    expect(
      droppedConfigPaths({
        batteryProvenance: { exportTariff: { mode: "amber" } },
      }),
    ).toEqual(["batteryProvenance.exportTariff.mode"]);
  });

  it("catches a key nobody has thought of yet, not just the known-retired ones", () => {
    // If this ever passes because someone special-cased `exportTariff`, the tool is decorative.
    expect(droppedConfigPaths({ someFieldInventedIn2027: 5 })).toEqual([
      "someFieldInventedIn2027",
    ]);
  });

  it("reports nothing for a config that round-trips", () => {
    const clean = {
      nameplateKw: 5,
      updateCadenceSeconds: 30,
      spec: { solarSizeKw: 11.9, batterySizeKwh: 32.24 },
      batteryProvenance: { reserveFloorMaxPct: 8 },
    };
    expect(droppedConfigPaths(clean)).toEqual([]);
    // And the parse is genuinely lossless, not merely diff-free.
    const parsed = parseDeviceConfig(clean);
    expect("error" in parsed ? parsed.error : parsed.config).toEqual(clean);
  });

  it("reports nothing for an absent or empty config", () => {
    expect(droppedConfigPaths(null)).toEqual([]);
    expect(droppedConfigPaths({})).toEqual([]);
  });

  it("keeps the surviving siblings of a dropped key", () => {
    // The danger case: a half-recognised sub-object. `reserveFloorMaxPct` must NOT be reported as a
    // drop just because its neighbour is one — reporting a live field as doomed would be as
    // misleading as missing a dead one.
    expect(
      droppedConfigPaths({
        batteryProvenance: {
          exportTariff: { mode: "amber" },
          reserveFloorMaxPct: 9,
        },
      }),
    ).toEqual(["batteryProvenance.exportTariff.mode"]);
  });

  it("says nothing about a config the parser REJECTS", () => {
    // A malformed blob has something to FIX, not something to drop, and `clean` skips it entirely.
    // Returning [] here is what keeps those two findings from being confused for one another.
    const malformed = {
      batteryProvenance: { generatorSource: { pricePerKwh: 4 } },
    };
    expect("error" in parseDeviceConfig(malformed)).toBe(true);
    expect(droppedConfigPaths(malformed)).toEqual([]);
  });

  it("does not report a value the parser merely NORMALISES", () => {
    // `renewableFraction` defaults to 0 when absent — the output differs from the input, but nothing
    // was lost. This answers "what would be discarded", not "what would differ".
    expect(
      droppedConfigPaths({
        batteryProvenance: {
          generatorSource: { emissionsIntensity: 800, pricePerKwh: 40 },
        },
      }),
    ).toEqual([]);
  });
});
