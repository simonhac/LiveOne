import { describe, it, expect } from "@jest/globals";
import { applyCapabilityConfig } from "@/lib/capabilities/config";
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
