import { describe, it, expect } from "@jest/globals";
import { CalendarDate } from "@internationalized/date";
import { planFlowRecomputeBatch } from "../flow-recompute-batch";

const d = (s: string) => {
  const [y, m, day] = s.split("-").map(Number);
  return new CalendarDate(y, m, day);
};
const iso = (c: CalendarDate) => c.toString();

describe("planFlowRecomputeBatch", () => {
  const start = d("2026-06-01");
  const end = d("2026-06-10"); // 10 days inclusive

  it("a limit covering the whole range → all days newest→oldest, done", () => {
    const r = planFlowRecomputeBatch({ start, end, cursor: end, limit: 31 });
    expect(r.days.map(iso)).toEqual([
      "2026-06-10",
      "2026-06-09",
      "2026-06-08",
      "2026-06-07",
      "2026-06-06",
      "2026-06-05",
      "2026-06-04",
      "2026-06-03",
      "2026-06-02",
      "2026-06-01",
    ]);
    expect(r.done).toBe(true);
    expect(r.nextCursor).toBeNull();
  });

  it("a bounded batch → first `limit` days, nextCursor set, not done", () => {
    const r = planFlowRecomputeBatch({ start, end, cursor: end, limit: 3 });
    expect(r.days.map(iso)).toEqual(["2026-06-10", "2026-06-09", "2026-06-08"]);
    expect(r.done).toBe(false);
    expect(iso(r.nextCursor!)).toBe("2026-06-07");
  });

  it("clamps a cursor beyond end down to end", () => {
    const r = planFlowRecomputeBatch({
      start,
      end,
      cursor: d("2026-06-20"),
      limit: 2,
    });
    expect(r.days.map(iso)).toEqual(["2026-06-10", "2026-06-09"]);
  });

  it("a cursor before start → nothing to do, done", () => {
    const r = planFlowRecomputeBatch({
      start,
      end,
      cursor: d("2026-05-31"),
      limit: 10,
    });
    expect(r.days).toEqual([]);
    expect(r.done).toBe(true);
    expect(r.nextCursor).toBeNull();
  });

  it("a single-day range", () => {
    const r = planFlowRecomputeBatch({
      start: end,
      end,
      cursor: end,
      limit: 5,
    });
    expect(r.days.map(iso)).toEqual(["2026-06-10"]);
    expect(r.done).toBe(true);
  });

  it("looping with nextCursor covers the whole range exactly once, in order", () => {
    const seen: string[] = [];
    let cursor: CalendarDate | null = end;
    let guard = 0;
    while (cursor && guard++ < 100) {
      const r = planFlowRecomputeBatch({ start, end, cursor, limit: 3 });
      seen.push(...r.days.map(iso));
      cursor = r.nextCursor;
      if (r.done) break;
    }
    expect(seen).toEqual([
      "2026-06-10",
      "2026-06-09",
      "2026-06-08",
      "2026-06-07",
      "2026-06-06",
      "2026-06-05",
      "2026-06-04",
      "2026-06-03",
      "2026-06-02",
      "2026-06-01",
    ]);
    expect(new Set(seen).size).toBe(10); // no duplicates, full coverage
  });
});
