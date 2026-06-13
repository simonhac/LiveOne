import { describe, it, expect } from "@jest/globals";
import { formatHoursAsDuration } from "@/lib/fe-date-format";

describe("formatHoursAsDuration", () => {
  it("shows 0h for exactly zero", () => {
    expect(formatHoursAsDuration(0)).toBe("0h");
  });

  it("rounds sub-minute values down to 0h", () => {
    expect(formatHoursAsDuration(0.005)).toBe("0h"); // 0.3 min -> 0
  });

  it("shows minutes with a 0h prefix when under an hour", () => {
    expect(formatHoursAsDuration(0.7167)).toBe("0h43m");
  });

  it("does not zero-pad minutes", () => {
    expect(formatHoursAsDuration(1.0833)).toBe("1h5m");
  });

  it("omits minutes when on a whole hour", () => {
    expect(formatHoursAsDuration(2)).toBe("2h");
  });

  it("rolls into days at >= 24h and drops minutes", () => {
    expect(formatHoursAsDuration(25.1)).toBe("1d1h");
    expect(formatHoursAsDuration(24)).toBe("1d0h");
    expect(formatHoursAsDuration(30.5)).toBe("1d6h");
  });
});
