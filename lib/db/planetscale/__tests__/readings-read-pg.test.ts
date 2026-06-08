import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// fetchAdminPivotRowsPg reads the `planetscaleDb` singleton; expose a mutable mock.
let mockDb: unknown = null;
jest.mock("../index", () => ({
  get planetscaleDb() {
    return mockDb;
  },
}));

import {
  fetchAdminPivotRowsPg,
  comparePivotData,
  fetchSinglePointReadingsPg,
  compareSinglePoint,
} from "../readings-read-pg";
import { SHADOW_SKIP } from "@/lib/db/readings-serve";

/** Fake the drizzle node-postgres `execute()` surface: capture the query, return canned rows. */
function makeFakeDb(rows: unknown[]) {
  let calls = 0;
  const db = {
    execute: (_sql: unknown) => {
      calls++;
      return Promise.resolve({ rows });
    },
  };
  return { db, calls: () => calls };
}

beforeEach(() => {
  mockDb = null;
});

describe("fetchAdminPivotRowsPg", () => {
  it("returns SHADOW_SKIP when Postgres is unconfigured", async () => {
    mockDb = null;
    const out = await fetchAdminPivotRowsPg({
      systemId: 1,
      source: "raw",
      cursor: null,
      direction: "newer",
      limit: 200,
      pivotColumns: "MAX(pr.value) as point_0",
    });
    expect(out).toBe(SHADOW_SKIP);
  });

  it.each(["raw", "5m", "daily"])(
    "runs one query and returns its rows for source=%s",
    async (source) => {
      const canned = [{ measurement_time: 1, session_id: null, point_0: 5 }];
      const { db, calls } = makeFakeDb(canned);
      mockDb = db;
      const out = await fetchAdminPivotRowsPg({
        systemId: 1,
        source,
        cursor: source === "daily" ? "2026-01-15" : 1_700_000_000_000,
        direction: "older",
        limit: 100,
        pivotColumns: "MAX(pr.value) as point_0",
      });
      expect(out).toEqual(canned);
      expect(calls()).toBe(1);
    },
  );
});

describe("comparePivotData", () => {
  const row = (
    time: string,
    sessionId: string | null,
    points: Record<string, number | string | null>,
  ) => ({ time, sessionId, sessionLabel: sessionId, ...points });

  it("matches identical data", () => {
    const t = [row("T1", "s", { point_0: 1, point_1: 2 })];
    const p = [row("T1", "s", { point_0: 1, point_1: 2 })];
    expect(comparePivotData(t, p)).toEqual({ matched: true });
  });

  it("matches within float tolerance", () => {
    const t = [row("T1", null, { point_0: 1.0 })];
    const p = [row("T1", null, { point_0: 1.0 + 1e-9 })];
    expect(comparePivotData(t, p).matched).toBe(true);
  });

  it("flags a differing point value", () => {
    const r = comparePivotData(
      [row("T1", "s", { point_0: 1 })],
      [row("T1", "s", { point_0: 9 })],
    );
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("point_0");
    expect(r.detail).toContain("turso=1 pg=9");
  });

  it("does NOT flag a row present only on Turso (tail / page boundary)", () => {
    const r = comparePivotData(
      [row("T1", "s", { point_0: 1 }), row("T2", "s", { point_0: 2 })],
      [row("T1", "s", { point_0: 1 })],
    );
    expect(r).toEqual({ matched: true });
  });

  it("does NOT flag null-vs-value (presence-only)", () => {
    const r = comparePivotData(
      [row("T1", "s", { point_0: 5 })],
      [row("T1", "s", { point_0: null })],
    );
    expect(r).toEqual({ matched: true });
  });

  it("keys rows by time+session (same time, different session are distinct)", () => {
    const t = [row("T1", "a", { point_0: 1 }), row("T1", "b", { point_0: 2 })];
    const p = [
      row("T1", "a", { point_0: 1 }),
      row("T1", "b", { point_0: 99 }), // only the session-b row diverges
    ];
    const r = comparePivotData(t, p);
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("T1|b");
    expect(r.detail).not.toContain("T1|a");
  });
});

describe("fetchSinglePointReadingsPg", () => {
  it("returns SHADOW_SKIP when Postgres is unconfigured", async () => {
    mockDb = null;
    const out = await fetchSinglePointReadingsPg({
      systemId: 1,
      pointId: 0,
      source: "raw",
      timestamp: 1_700_000_000_000,
    });
    expect(out).toBe(SHADOW_SKIP);
  });

  it.each(["raw", "5m", "daily"])(
    "runs one query and returns its rows for source=%s",
    async (source) => {
      const canned = [
        { intervalEnd: 1, measurementTime: 1, date: "x", avg: 1 },
      ];
      const { db, calls } = makeFakeDb(canned);
      mockDb = db;
      const out = await fetchSinglePointReadingsPg({
        systemId: 1,
        pointId: 0,
        source,
        timestamp: 1_700_000_000_000,
        startDayStr: "2026-01-06",
        endDayStr: "2026-01-24",
      });
      expect(out).toEqual(canned);
      expect(calls()).toBe(1);
    },
  );
});

describe("compareSinglePoint", () => {
  it("5m: matches identical aggregate rows, flags a differing value", () => {
    const t = [
      {
        intervalEnd: 100,
        avg: 1,
        min: 0,
        max: 2,
        last: 1,
        delta: 0,
        sampleCount: 3,
        errorCount: 0,
      },
    ];
    expect(compareSinglePoint(t, t, "5m")).toEqual({ matched: true });

    const p = [{ ...t[0], avg: 9 }];
    const r = compareSinglePoint(t, p, "5m");
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("100 avg: turso=1 pg=9");
  });

  it("raw: keys by measurementTime, compares value/valueStr", () => {
    const t = [{ measurementTime: 500, value: 12.0, valueStr: null }];
    const p = [{ measurementTime: 500, value: 12.0 + 1e-9, valueStr: null }];
    expect(compareSinglePoint(t, p, "raw").matched).toBe(true);

    const p2 = [{ measurementTime: 500, value: 99, valueStr: null }];
    expect(compareSinglePoint(t, p2, "raw").matched).toBe(false);
  });

  it("daily: keys by date", () => {
    const t = [
      {
        date: "2026-01-15",
        avg: 5,
        min: 1,
        max: 9,
        last: 5,
        delta: 2,
        sampleCount: 10,
        errorCount: 0,
      },
    ];
    const p = [{ ...t[0], delta: 7 }];
    const r = compareSinglePoint(t, p, "daily");
    expect(r.matched).toBe(false);
    expect(r.detail).toContain("2026-01-15 delta");
  });

  it("does NOT flag a row present only on Turso, or null-vs-value", () => {
    const t = [
      { intervalEnd: 1, avg: 1 },
      { intervalEnd: 2, avg: 2 },
    ];
    const p = [{ intervalEnd: 1, avg: null }]; // missing intervalEnd 2; null avg on 1
    expect(compareSinglePoint(t, p, "5m")).toEqual({ matched: true });
  });
});
