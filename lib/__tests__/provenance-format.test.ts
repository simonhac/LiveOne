import { describe, it, expect } from "@jest/globals";
import {
  formatDollars,
  formatCentsPerKwh,
  formatGramsPerKwh,
  formatRenewablePct,
  formatKwh,
  formatKgCo2,
} from "@/lib/provenance-format";

// Byte-match tripwires against the spellings that used to be inlined in LoadProvenanceCard.tsx
// (see the pre-refactor git history) — the extraction into lib/provenance-format.ts must not change a
// single character of what's on screen today.

describe("formatDollars", () => {
  // Old inline: `${dollars < 0 ? "−" : ""}$${Math.abs(dollars).toFixed(2)}`, dollars = costC / 100.
  it("formats positive cents as $X.XX", () => {
    expect(formatDollars(1245)).toBe("$12.45");
  });
  it("formats zero as $0.00", () => {
    expect(formatDollars(0)).toBe("$0.00");
  });
  it("formats negative cents with a leading − (not a hyphen)", () => {
    expect(formatDollars(-350)).toBe("−$3.50");
    expect(formatDollars(-350).charAt(0)).toBe("−");
  });
  it("rounds to 2dp", () => {
    expect(formatDollars(1233.4)).toBe("$12.33");
  });
});

describe("formatCentsPerKwh", () => {
  // Old inline: `summary.avgCentsPerKwh.toFixed(1)` (rendered only when non-null; card omitted entirely
  // on null — formatCentsPerKwh(null) → "—" is new tooltip-only behavior, not a byte-match target).
  it("formats to 1dp", () => {
    expect(formatCentsPerKwh(23.456)).toBe("23.5");
    expect(formatCentsPerKwh(0)).toBe("0.0");
  });
  it("returns an em-dash for null", () => {
    expect(formatCentsPerKwh(null)).toBe("—");
  });
});

describe("formatGramsPerKwh", () => {
  // Old inline: `${Math.round(summary.avgGramsPerKwh)}` | "—".
  it("rounds to the nearest whole gram", () => {
    expect(formatGramsPerKwh(123.4)).toBe("123");
    expect(formatGramsPerKwh(123.6)).toBe("124");
  });
  it("returns an em-dash for null", () => {
    expect(formatGramsPerKwh(null)).toBe("—");
  });
});

describe("formatRenewablePct", () => {
  // Old inline: `${Math.round(summary.pctRenewable)}%` | "—".
  it("rounds to the nearest whole percent with a % suffix", () => {
    expect(formatRenewablePct(89.4)).toBe("89%");
    expect(formatRenewablePct(89.6)).toBe("90%");
    expect(formatRenewablePct(0)).toBe("0%");
  });
  it("returns an em-dash for null", () => {
    expect(formatRenewablePct(null)).toBe("—");
  });
});

describe("formatKwh", () => {
  // Old inline: `${summary.energyKwh.toFixed(1)}`.
  it("formats to 1dp", () => {
    expect(formatKwh(13.26)).toBe("13.3");
    expect(formatKwh(0)).toBe("0.0");
  });
  it("drops the decimal once the value reaches 100 ('over 99.9')", () => {
    expect(formatKwh(99.9)).toBe("99.9"); // at the threshold, keep the decimal
    expect(formatKwh(99.94)).toBe("99.9"); // rounds to 99.9 → keep
    expect(formatKwh(99.96)).toBe("100"); // rounds to 100.0 → drop, never "100.0"
    expect(formatKwh(123.4)).toBe("123");
  });
});

describe("formatKgCo2", () => {
  // No inline precedent (LoadProvenanceCard never showed kg) — new for the Sankey tooltip only.
  it("formats to 1dp", () => {
    expect(formatKgCo2(1.049)).toBe("1.0");
    expect(formatKgCo2(0)).toBe("0.0");
  });
});
