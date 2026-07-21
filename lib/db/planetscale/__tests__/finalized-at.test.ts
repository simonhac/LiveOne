import { describe, it, expect } from "@jest/globals";
import { CalendarDate } from "@internationalized/date";
import {
  computeFinalizedAt,
  SETTLEMENT_WINDOW_MS,
  localDaysInRange,
} from "../battery-provenance-pg";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";

// Mirror recompute.ts's REHEAL_TRAILING_MS without importing the orchestration module (keeps this a pure
// unit test). Kept in sync by construction: both are SETTLEMENT_WINDOW_MS + a 1-day buffer.
const REHEAL_TRAILING_MS = SETTLEMENT_WINDOW_MS + 24 * 60 * 60 * 1000;

describe("computeFinalizedAt", () => {
  const NOW = Date.parse("2026-02-01T00:05:00Z");

  it("is NULL while the day-end is inside the settlement window", () => {
    expect(computeFinalizedAt(NOW - 1 * 3600 * 1000, NOW)).toBeNull(); // 1h ago
    expect(computeFinalizedAt(NOW - SETTLEMENT_WINDOW_MS, NOW)).toBeNull(); // exactly at the edge (not >)
    expect(computeFinalizedAt(NOW - SETTLEMENT_WINDOW_MS + 1, NOW)).toBeNull();
  });

  it("stamps `now` once the day-end is strictly past the window", () => {
    const at = computeFinalizedAt(NOW - SETTLEMENT_WINDOW_MS - 1, NOW);
    expect(at).toBeInstanceOf(Date);
    expect(at?.getTime()).toBe(NOW);
    expect(computeFinalizedAt(NOW - 100 * 3600 * 1000, NOW)?.getTime()).toBe(
      NOW,
    );
  });
});

describe("finalize timeline invariant (cron at 00:05 local, +1 buffer day)", () => {
  const TZ = 600; // +10:00 AEST
  const D = new CalendarDate(2026, 1, 10);
  const dayEndMs = dayToUnixRangeForAggregation(D, TZ)[1] * 1000; // 00:00 of D+1

  // cron "now" ≈ 00:05 local of day T
  const cronNow = (t: CalendarDate) =>
    dayToUnixRangeForAggregation(t, TZ)[0] * 1000;

  it("stays estimated (NULL) through D+3, finalizes from D+4", () => {
    const early = [1, 2, 3].map((n) =>
      computeFinalizedAt(dayEndMs, cronNow(D.add({ days: n }))),
    );
    expect(early).toEqual([null, null, null]);

    expect(
      computeFinalizedAt(dayEndMs, cronNow(D.add({ days: 4 }))),
    ).toBeInstanceOf(Date);
    expect(
      computeFinalizedAt(dayEndMs, cronNow(D.add({ days: 5 }))),
    ).toBeInstanceOf(Date);
  });

  it("D is still inside the trailing recompute window on the night it finalizes (D+4)", () => {
    const now = cronNow(D.add({ days: 4 }));
    const days = localDaysInRange(now - REHEAL_TRAILING_MS, now, TZ).map((d) =>
      d.toString(),
    );
    // Recomputed that night → the same run that stamps it. A plain 72h window would have dropped D.
    expect(days).toContain(D.toString());
  });
});
