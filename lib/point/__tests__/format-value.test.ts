import { describe, it, expect } from "@jest/globals";
import { formatPercent } from "@/lib/point/format-value";

describe("formatPercent", () => {
  it("keeps one decimal below 100", () => {
    expect(formatPercent(99.5)).toBe("99.5");
    expect(formatPercent(72.5)).toBe("72.5");
    expect(formatPercent(8)).toBe("8.0");
    expect(formatPercent(0)).toBe("0.0");
  });

  it("rounds to 1dp before deciding, so 99.96 is 100 and not 100.0", () => {
    expect(formatPercent(99.94)).toBe("99.9");
    expect(formatPercent(99.96)).toBe("100");
  });

  it("drops the decimal at 100 and above", () => {
    expect(formatPercent(100)).toBe("100");
    expect(formatPercent(100.04)).toBe("100");
    expect(formatPercent(100.4)).toBe("100");
  });

  it("treats a negative magnitude the same", () => {
    expect(formatPercent(-100)).toBe("-100");
    expect(formatPercent(-99.5)).toBe("-99.5");
  });
});
