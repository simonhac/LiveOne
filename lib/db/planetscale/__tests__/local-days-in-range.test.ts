import { describe, it, expect } from "@jest/globals";
import { CalendarDate } from "@internationalized/date";
import { localDaysInRange } from "../battery-provenance-pg";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";

/**
 * The flow_attr_1d rollup writer iterates `localDaysInRange(winStart, winEnd)` and does a per-day
 * delete-then-insert. `winEnd` is `dayToUnixRangeForAggregation(newest)[1]` = 00:00 of the NEXT day, so
 * mapping it with the naive calendar-day of the timestamp overshoots to `newest+1`. In the backward
 * batch loop of `recompute-provenance`, that extra day is the PREVIOUS batch's oldest, and recomputing
 * it (empty, since it's beyond the loaded window) wipes correct rows — losing one day per batch seam.
 * These guard that the range covers exactly [oldest, newest] (Bug A).
 */
describe("localDaysInRange", () => {
  const TZ = 600; // +10:00 (AEST) — the off-grid / Daylesford case

  it("covers exactly [oldest, newest] for a 14-day batch window (no newest+1 overshoot)", () => {
    const oldest = new CalendarDate(2025, 12, 2);
    const newest = new CalendarDate(2025, 12, 15);
    const [startSec] = dayToUnixRangeForAggregation(oldest, TZ);
    const [, endSec] = dayToUnixRangeForAggregation(newest, TZ);

    const days = localDaysInRange(startSec * 1000, endSec * 1000, TZ);

    expect(days.length).toBe(14);
    expect(days[0].toString()).toBe("2025-12-02");
    expect(days[days.length - 1].toString()).toBe("2025-12-15");
    // newest+1 belongs to the adjacent batch; including it here is exactly the wipe.
    expect(days.some((d) => d.toString() === "2025-12-16")).toBe(false);
  });

  it("covers a single local day", () => {
    const d = new CalendarDate(2026, 1, 20);
    const [s] = dayToUnixRangeForAggregation(d, TZ);
    const [, e] = dayToUnixRangeForAggregation(d, TZ);
    expect(
      localDaysInRange(s * 1000, e * 1000, TZ).map((x) => x.toString()),
    ).toEqual(["2026-01-20"]);
  });

  it("works for a negative (western) tz offset", () => {
    const oldest = new CalendarDate(2026, 3, 10);
    const newest = new CalendarDate(2026, 3, 12);
    const tz = -420; // -07:00
    const [s] = dayToUnixRangeForAggregation(oldest, tz);
    const [, e] = dayToUnixRangeForAggregation(newest, tz);
    expect(
      localDaysInRange(s * 1000, e * 1000, tz).map((x) => x.toString()),
    ).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
  });
});
