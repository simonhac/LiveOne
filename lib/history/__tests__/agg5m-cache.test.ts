/**
 * Unit tests for the §1.3a request-scoped agg_5m avg cache. These lock the guardrails the adversarial
 * byte-identity review flagged: stored `avg=null` rows are preserved as present slots (A2), the reused
 * slice is filtered to `[startMs, endMs]` so lead-in/tail rows never leak (A3), coverage is per queried
 * pair (A5), a queried-but-empty point is covered (A9), and a tail gap fails safe to a full re-query.
 */
import { describe, it, expect } from "@jest/globals";
import { Agg5mAvgCache } from "../agg5m-cache";

const row = (pointId: number, t: number, avg: number | null) => ({
  pointId,
  intervalEnd: new Date(t),
  avg,
});

describe("Agg5mAvgCache (§1.3a)", () => {
  it("slice returns in-window rows (incl. stored null avg) and excludes lead-in / tail", () => {
    const c = new Agg5mAvgCache();
    c.record(8, [10, 11], 1000, 5000, [
      row(10, 1000, 1.0),
      row(10, 2000, null), // a stored null avg — must survive as a present slot, not be dropped
      row(10, 5000, 3.0),
      row(11, 3000, 9.0),
    ]);
    // Reuse point 10 over a sub-window [2000, 5000].
    const s = c.slice(8, 10, 2000, 5000);
    expect(s.covered).toBe(true);
    expect(s.from).toBe(1000); // cache lower bound → caller queries only [startMs, 1000)
    expect(s.rows).toEqual([
      { t: 2000, avg: null },
      { t: 5000, avg: 3.0 },
    ]);
    // t=1000 is lead-in (t < startMs) → excluded from reuse.
    expect(s.rows.some((r) => r.t === 1000)).toBe(false);
  });

  it("covered=false for an unqueried point or system → caller full-queries", () => {
    const c = new Agg5mAvgCache();
    c.record(8, [10], 1000, 5000, []);
    expect(c.slice(8, 99, 1000, 5000).covered).toBe(false); // point not queried
    expect(c.slice(7, 10, 1000, 5000).covered).toBe(false); // different system
  });

  it("covered=false when the cache window does not reach endMs (tail-gap fail-safe)", () => {
    const c = new Agg5mAvgCache();
    c.record(8, [10], 1000, 5000, [row(10, 5000, 3.0)]);
    expect(c.slice(8, 10, 1000, 6000).covered).toBe(false); // endMs 6000 > cache.to 5000
    expect(c.slice(8, 10, 1000, 5000).covered).toBe(true);
  });

  it("a queried-but-empty point is covered with zero rows (not a cache miss)", () => {
    const c = new Agg5mAvgCache();
    c.record(8, [10, 11], 1000, 5000, [row(10, 2000, 1.0)]);
    const s = c.slice(8, 11, 1000, 5000);
    expect(s.covered).toBe(true);
    expect(s.rows).toEqual([]);
  });
});
