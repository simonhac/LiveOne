/**
 * The counter-deficit scan — shared by the flow-matrix energy overlay and the Sigenergy power
 * recovery, because they were two guards disagreeing about the same defect.
 */
import { describe, it, expect } from "@jest/globals";
import { trustedByDeficit } from "../counter-deficit";

describe("trustedByDeficit", () => {
  it("trusts a counter that only goes up", () => {
    expect(trustedByDeficit([1, 2, 3])).toEqual([true, true, true]);
  });

  it("distrusts a dropout and its immediate catch-up", () => {
    // The adjacent case — Kutis 2026-08-20 19:20: −26970 Wh then +26970 Wh.
    expect(trustedByDeficit([100, -26970, 26970, 100])).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  /** The case the adjacent-pair guard missed, and the reason this function exists. */
  it("stays distrustful across a multi-interval freeze", () => {
    // Kutis 2026-08-19: −10590, zeros through 17:55, +10590 at 18:00.
    expect(trustedByDeficit([100, -10590, 0, 0, 0, 10590, 100])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("resumes as soon as the debt is cleared, even when repaid in pieces", () => {
    expect(trustedByDeficit([100, -300, 100, 100, 100, 100])).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("does not trust the interval that over-repays, only the one after", () => {
    // The catch-up carries more than one interval's energy even when it clears the debt outright.
    expect(trustedByDeficit([-50, 500, 10])).toEqual([false, false, true]);
  });

  describe("the ULP tolerance", () => {
    it("defaults to zero — any negative is a dropout", () => {
      expect(trustedByDeficit([100, -1, 100])).toEqual([true, false, false]);
    });

    it("reads a negative within one ULP as reporting resolution", () => {
      // A low-volume register rounded to 0.01 kWh flickers 0 → 0.01 → 0. Treating that as a dropout
      // distrusted 49% of Sigenergy's grid intervals for what is only the resolution.
      expect(trustedByDeficit([100, -10, 100], 10)).toEqual([true, true, true]);
      expect(trustedByDeficit([100, -11, 100], 10)).toEqual([
        true,
        false,
        false,
      ]);
    });
  });

  describe("gaps", () => {
    it("never trusts an absent reading", () => {
      expect(trustedByDeficit([1, null, 2])).toEqual([true, false, true]);
      expect(trustedByDeficit([1, undefined, 2])).toEqual([true, false, true]);
    });

    it("does not let an absent reading disturb an open debt", () => {
      // A hole in the middle of a freeze must not be mistaken for repayment.
      expect(trustedByDeficit([-100, null, 100, 5])).toEqual([
        false,
        false,
        false,
        true,
      ]);
    });
  });

  it("handles an empty series", () => {
    expect(trustedByDeficit([])).toEqual([]);
  });
});
