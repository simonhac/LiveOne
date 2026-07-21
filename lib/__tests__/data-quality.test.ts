import { describe, it, expect } from "@jest/globals";
import { isSettledQuality } from "@/lib/data-quality";

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
});
