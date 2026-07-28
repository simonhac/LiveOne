import { describe, expect, it } from "@jest/globals";
import { resolveGeneratorIntensity } from "../generator-source";

describe("resolveGeneratorIntensity", () => {
  it("resolves prod system 1's Daylesford constants", () => {
    expect(
      resolveGeneratorIntensity({
        emissionsIntensity: 1000,
        pricePerKwh: 70,
        renewableFraction: 0,
      }),
    ).toEqual({ gPerKwh: 1000, priceC: 70, renewable: 0 });
  });

  it("returns null when no generatorSource is configured", () => {
    expect(resolveGeneratorIntensity(undefined)).toBeNull();
    expect(resolveGeneratorIntensity(null)).toBeNull();
  });

  it("gates EVERYTHING on a finite emissionsIntensity", () => {
    // The master gate: without it the site has made no statement that its AC-input is a generator,
    // so a configured price must NOT be applied on its own.
    for (const bad of [NaN, Infinity, undefined as unknown as number]) {
      expect(
        resolveGeneratorIntensity({
          emissionsIntensity: bad,
          pricePerKwh: 70,
          renewableFraction: 0,
        }),
      ).toBeNull();
    }
  });

  it("gates price independently — emissions apply without it", () => {
    expect(
      resolveGeneratorIntensity({
        emissionsIntensity: 1000,
        pricePerKwh: NaN,
        renewableFraction: 0.2,
      }),
    ).toEqual({ gPerKwh: 1000, priceC: null, renewable: 0.2 });
  });

  it("defaults a missing/non-finite renewableFraction to 0 (diesel)", () => {
    expect(
      resolveGeneratorIntensity({
        emissionsIntensity: 1000,
        pricePerKwh: 70,
        renewableFraction: undefined as unknown as number,
      }),
    ).toEqual({ gPerKwh: 1000, priceC: 70, renewable: 0 });
  });

  it("passes a bio-fuel blend's renewable fraction through", () => {
    expect(
      resolveGeneratorIntensity({
        emissionsIntensity: 400,
        pricePerKwh: 95,
        renewableFraction: 0.6,
      }),
    ).toEqual({ gPerKwh: 400, priceC: 95, renewable: 0.6 });
  });

  it("accepts a zero price (a free generator is not an unconfigured one)", () => {
    expect(
      resolveGeneratorIntensity({
        emissionsIntensity: 1000,
        pricePerKwh: 0,
        renewableFraction: 0,
      })?.priceC,
    ).toBe(0);
  });
});
