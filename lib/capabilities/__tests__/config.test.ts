import { describe, it, expect } from "@jest/globals";
import {
  applyCapabilityConfig,
  maxPowerHintFromSpec,
} from "@/lib/capabilities/config";
import type { CapabilityId } from "@/lib/capabilities/registry";

const set = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);
const sorted = (s: Set<CapabilityId>) => [...s].sort();

describe("applyCapabilityConfig", () => {
  it("is a no-op for null / empty config (parity preserved)", () => {
    const s = set("solar/power", "battery/soc");
    expect(sorted(applyCapabilityConfig(s, null))).toEqual(sorted(s));
    expect(sorted(applyCapabilityConfig(s, {}))).toEqual(sorted(s));
    expect(sorted(applyCapabilityConfig(s, { capabilities: {} }))).toEqual(
      sorted(s),
    );
  });

  it("force-off (false) removes a derived capability", () => {
    const out = applyCapabilityConfig(set("solar/power", "battery/soc"), {
      capabilities: { "battery/soc": false },
    });
    expect(out.has("battery/soc")).toBe(false);
    expect(out.has("solar/power")).toBe(true);
  });

  it("force-on (true) adds a capability the points don't provide", () => {
    const out = applyCapabilityConfig(set("solar/power"), {
      capabilities: { "grid/rate": true },
    });
    expect(out.has("grid/rate")).toBe(true);
  });

  it("does not mutate the input set", () => {
    const s = set("solar/power");
    applyCapabilityConfig(s, { capabilities: { "solar/power": false } });
    expect(s.has("solar/power")).toBe(true);
  });
});

/**
 * `maxPowerHintFromSpec` (config-v4 slice K1) is the successor to the free-text regex
 * `maxPowerHintFromSystemInfo`. Its RULE must match ("larger of PV array and inverter"); its INPUT
 * deliberately does not (see the function's own note on Kutis / "11.9kW"). The cross-environment
 * proof that no OTHER device's hint moves is `scripts/config-v4/verify-slice-k1-parity.ts` block 3.
 */
describe("maxPowerHintFromSpec", () => {
  it("takes the larger of solar and inverter when both are known", () => {
    expect(maxPowerHintFromSpec({ solarSizeKw: 9, inverterSizeKw: 7.5 })).toBe(
      9,
    );
    expect(maxPowerHintFromSpec({ solarSizeKw: 5, inverterSizeKw: 7.5 })).toBe(
      7.5,
    );
  });

  it("falls back to whichever single value is known", () => {
    expect(maxPowerHintFromSpec({ solarSizeKw: 11.9 })).toBe(11.9);
    expect(maxPowerHintFromSpec({ inverterSizeKw: 7.5 })).toBe(7.5);
  });

  it("is undefined when neither is known — an absent spec must mean what unparseable free text meant", () => {
    expect(maxPowerHintFromSpec(undefined)).toBeUndefined();
    expect(maxPowerHintFromSpec(null)).toBeUndefined();
    expect(maxPowerHintFromSpec({})).toBeUndefined();
    // Battery-only spec (a device with no PV and no inverter rating) must not scale the power axis.
    expect(maxPowerHintFromSpec({ batterySizeKwh: 63.6 })).toBeUndefined();
  });
});
