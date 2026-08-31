import { describe, it, expect } from "@jest/globals";
import { isSettledQuality, isDerivedQuality } from "@/lib/data-quality";

describe("isSettledQuality", () => {
  it("treats good / actual / billable (long + Amber abbreviations) as settled", () => {
    for (const q of ["good", "actual", "billable", "a", "b"]) {
      expect(isSettledQuality(q)).toBe(true);
    }
  });

  it("treats forecast / estimated / unknown as provisional", () => {
    for (const q of ["forecast", "estimated", "f", "e", ".", "", "GOOD"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });

  // The allow-list is what makes a new marker safe to introduce: it is provisional until
  // someone deliberately promotes it, so a recovered interval can never be miscounted as
  // measured by a consumer that predates the marker.
  it("treats the gap-recovery markers as provisional", () => {
    for (const q of ["calculated", "interpolated"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });
});

describe("isDerivedQuality", () => {
  it("recognises the markers LiveOne writes for values it derived", () => {
    for (const q of ["calculated", "interpolated", "estimated"]) {
      expect(isDerivedQuality(q)).toBe(true);
    }
  });

  it("does not claim measured or vendor-provisional values as derived", () => {
    for (const q of [
      "good",
      "actual",
      "billable",
      "a",
      "b",
      "f",
      "forecast",
      ".",
      "",
    ]) {
      expect(isDerivedQuality(q)).toBe(false);
    }
  });

  // Derived is a strict subset of provisional — nothing may be both derived and settled.
  it("never overlaps with settled", () => {
    for (const q of ["calculated", "interpolated", "estimated"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });
});
