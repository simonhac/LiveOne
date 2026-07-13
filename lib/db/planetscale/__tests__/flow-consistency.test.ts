import { describe, it, expect } from "@jest/globals";
import { reduceFlowConsistency, FlowConsistencyRow } from "../flow-consistency";

/** A day present in both tables with the given energy on each side. */
const both = (
  areaId: string,
  day: string,
  legacyKwh: number,
  modernKwh: number,
): FlowConsistencyRow => ({
  areaId,
  day,
  legacyKwh,
  modernKwh,
  hasLegacy: true,
  hasModern: true,
});

/** A day present in legacy (flow_1d) only — the modern rollup never materialised it. */
const legacyOnly = (
  areaId: string,
  day: string,
  legacyKwh: number,
): FlowConsistencyRow => ({
  areaId,
  day,
  legacyKwh,
  modernKwh: 0,
  hasLegacy: true,
  hasModern: false,
});

describe("reduceFlowConsistency", () => {
  it("on-grid area with matching legacy/modern energy is clean", () => {
    // Every day materialised identically in both tables (the invariant when a re-backfill is complete).
    const rows: FlowConsistencyRow[] = [
      both("area-ongrid", "2026-06-28", 12.4, 12.4),
      both("area-ongrid", "2026-06-29", 9.1, 9.1),
      both("area-ongrid", "2026-06-30", 15.0, 15.0),
    ];
    const [c] = reduceFlowConsistency(rows);
    expect(c.areaId).toBe("area-ongrid");
    expect(c.divergentDays).toHaveLength(0);
    expect(c.deltaKwh).toBeCloseTo(0, 6);
    expect(c.legacyDays).toBe(3);
    expect(c.modernDays).toBe(3);
  });

  it("off-grid area with an un-materialised day is flagged (the 2026-06-30 hole)", () => {
    // Mirrors the live prod finding: modern is missing exactly one generator day, which is the
    // entire delta and a day-coverage mismatch.
    const rows: FlowConsistencyRow[] = [
      both("area-offgrid", "2026-06-28", 5.0, 5.0),
      both("area-offgrid", "2026-06-29", 6.2, 6.2),
      legacyOnly("area-offgrid", "2026-06-30", 17.71),
    ];
    const [c] = reduceFlowConsistency(rows);
    expect(c.divergentDays).toHaveLength(1);
    expect(c.divergentDays[0].day).toBe("2026-06-30");
    expect(c.divergentDays[0].diffKwh).toBeCloseTo(17.71, 2);
    expect(c.deltaKwh).toBeCloseTo(17.71, 2);
    expect(c.legacyDays).toBe(3);
    expect(c.modernDays).toBe(2); // the hole
  });

  it("ignores sub-tolerance per-day differences (float noise)", () => {
    const rows: FlowConsistencyRow[] = [
      both("area-x", "2026-06-29", 10.0, 10.02),
      both("area-x", "2026-06-30", 10.0, 9.99),
    ];
    const [c] = reduceFlowConsistency(rows); // default tol 0.05 kWh
    expect(c.divergentDays).toHaveLength(0);
  });

  it("respects an explicit tolerance", () => {
    const rows = [both("area-x", "2026-06-30", 10.0, 9.9)];
    expect(reduceFlowConsistency(rows, 0.05)[0].divergentDays).toHaveLength(1);
    expect(reduceFlowConsistency(rows, 0.2)[0].divergentDays).toHaveLength(0);
  });

  it("groups multiple areas independently and sorts divergent days", () => {
    const rows: FlowConsistencyRow[] = [
      both("a", "2026-06-30", 1, 1),
      legacyOnly("b", "2026-06-30", 3),
      legacyOnly("b", "2026-06-28", 2),
    ];
    const out = reduceFlowConsistency(rows);
    const a = out.find((c) => c.areaId === "a")!;
    const b = out.find((c) => c.areaId === "b")!;
    expect(a.divergentDays).toHaveLength(0);
    expect(b.divergentDays.map((d) => d.day)).toEqual([
      "2026-06-28",
      "2026-06-30",
    ]);
  });
});
