import { describe, it, expect } from "@jest/globals";
import { openelectricityProvider } from "../coverage-repair";

describe("openelectricityProvider (coverage-repair)", () => {
  it("detects all four grid points, including the derived emissionsIntensity", () => {
    // emissionsIntensity is intentionally IN the detection set: for a whole NEM region its
    // derivation skips (emissions<=0 / power<=0) never fire, so it is ~288/day and its short
    // days are recoverable data-endpoint publish-lag holes we want the weekly repair to heal.
    // (An earlier version wrongly excluded it as "sparse by design".)
    expect(openelectricityProvider.expectedPointTails).toEqual(
      expect.arrayContaining([
        "nem/price",
        "nem/renewableProportion",
        "nem/demand",
        "nem/emissionsIntensity",
      ]),
    );
  });
});
