import { describe, it, expect } from "@jest/globals";
import { pickNumberPreferNonZero } from "../sigenergy-client";

describe("pickNumberPreferNonZero", () => {
  // The live failure: an AC-charger site reports `evPower: 0` (the DC field) alongside the real
  // `acPower`, so plain first-key-wins reported 0 EV charging for every such site.
  it("skips a present-but-zero earlier key in favour of a later non-zero one", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 0, acPower: 6.66 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(6.66);
  });

  it("keeps the first key when it is non-zero", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 3.2, acPower: 6.66 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(3.2);
  });

  it("returns 0 when every candidate is genuinely zero (idle, not missing)", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 0, acPower: 0 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(0);
  });

  it("returns null when no candidate is present", () => {
    expect(pickNumberPreferNonZero({ other: 1 }, ["evPower", "acPower"])).toBe(
      null,
    );
  });

  it("ignores absent keys and negative values are preserved", () => {
    expect(
      pickNumberPreferNonZero({ acPower: -2.5 }, ["evPower", "acPower"]),
    ).toBe(-2.5);
  });
});
