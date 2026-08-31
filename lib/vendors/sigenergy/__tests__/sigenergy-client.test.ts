import { describe, it, expect } from "@jest/globals";
import { pickNumberPreferNonZero, parseEnergyFlow } from "../sigenergy-client";

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

/**
 * `pickNumber` is module-private, so it is exercised through the two extractors that use it. The
 * hazard is silent COERCION: bare `Number()` turns `false`, `[]` and `" "` into `0`, which is
 * indistinguishable downstream from the site genuinely producing nothing. The live payload really
 * does carry a boolean (`onGrid`) and an array (`greenSourceInfos`) beside the numeric fields, and
 * the keys are candidate LISTS spanning vendor spellings — so a rename landing on the wrong type is
 * the realistic way this bites.
 */
describe("pickNumber (via parseEnergyFlow) — coercion hazards", () => {
  const flow = (over: Record<string, unknown>) =>
    parseEnergyFlow({ data: { pvPower: 1.5, ...over } });

  it("reads a plain number", () => {
    expect(flow({}).pvKw).toBe(1.5);
  });

  it("treats a boolean as absent, not as 0/1", () => {
    expect(flow({ pvPower: false }).pvKw).toBeNull();
    expect(flow({ pvPower: true }).pvKw).toBeNull();
  });

  it("treats an array as absent, however numeric-looking", () => {
    expect(flow({ pvPower: [] }).pvKw).toBeNull();
    expect(flow({ pvPower: [7] }).pvKw).toBeNull();
  });

  it("treats an object as absent", () => {
    expect(flow({ pvPower: {} }).pvKw).toBeNull();
  });

  it("treats whitespace as absence, not zero", () => {
    expect(flow({ pvPower: "  " }).pvKw).toBeNull();
    expect(flow({ pvPower: "" }).pvKw).toBeNull();
  });

  it("rejects a non-finite reading", () => {
    expect(flow({ pvPower: "Infinity" }).pvKw).toBeNull();
    expect(flow({ pvPower: Number.NaN }).pvKw).toBeNull();
  });

  it("still accepts a numeric string, and a genuine zero", () => {
    // Insurance against a vendor that starts quoting its numbers; none does today.
    expect(flow({ pvPower: "2.25" }).pvKw).toBe(2.25);
    expect(flow({ pvPower: 0 }).pvKw).toBe(0);
    expect(flow({ pvPower: "0" }).pvKw).toBe(0);
  });

  it("falls through a bad candidate to a later good one", () => {
    // The realistic shape: the first spelling exists but carries the wrong type.
    expect(
      parseEnergyFlow({ data: { pvPower: false, solarPower: 3.5 } }).pvKw,
    ).toBe(3.5);
  });
});
