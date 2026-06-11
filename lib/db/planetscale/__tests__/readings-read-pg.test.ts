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
  fetchSinglePointReadingsPg,
} from "../readings-read-pg";

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

describe("fetchSinglePointReadingsPg", () => {
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
