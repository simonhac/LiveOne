/**
 * The daily aggregation cron is the BACKSTOP for area serving.
 *
 * Serving is normally refreshed the instant a point is minted, but that refresh lives on the ingest
 * path and is best-effort: a transient KV/DB failure sets a retry flag, and a lambda recycle can lose
 * the flag. Without a periodic rebuild the worst case is "invisible until some unrelated area mutation
 * happens" — i.e. indefinitely, which is precisely the defect being closed. Once a day caps it at 24 h
 * and also covers any future mint call site that forgets the hook.
 *
 * (`kv-cache-manager.ts`'s docstring promised "periodically (e.g. daily) as a safety net" for a long
 * time while no cron actually called it. These cases make the promise true and keep it true.)
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest } from "next/server";

jest.mock("@/lib/api-auth", () => ({
  requireCronOrAdmin: jest.fn(async () => ({ type: "cron" })),
}));
jest.mock("@/lib/cron/guard", () => ({ cronSkipReason: jest.fn(() => null) }));
jest.mock("@/lib/aggregation/daily-points", () => ({
  aggregateRange: jest.fn(async () => ({
    pointsAggregated: 3,
    rowsCreated: 9,
    queryCount: 1,
  })),
  deleteRange: jest.fn(async () => ({ rowsDeleted: 0, queryCount: 0 })),
}));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    activeDevices: jest.fn(async () => [{ timezoneOffsetMin: 600 }]),
  },
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  refreshServingForMintedPoints: jest.fn(async () => {}),
}));

import { refreshServingForMintedPoints } from "@/lib/kv-cache-manager";
import { aggregateRange } from "@/lib/aggregation/daily-points";
import { GET } from "../route";

const mockRefresh = jest.mocked(refreshServingForMintedPoints);
const mockAggregate = jest.mocked(aggregateRange);

const req = () =>
  new NextRequest("https://liveone.energy/api/cron/daily?last=1d");

beforeEach(() => {
  jest.clearAllMocks();
  mockRefresh.mockImplementation(async () => {});
});

describe("/api/cron/daily — area-serving backstop", () => {
  it("rebuilds area serving on the scheduled aggregate run", async () => {
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith("cron/daily");
  });

  it("still reports aggregation success if the rebuild throws", async () => {
    // A serving problem must never fail the day's aggregation, even if
    // `refreshServingForMintedPoints` ever stopped swallowing its own errors.
    mockRefresh.mockImplementation(async () => {
      throw new Error("kv down");
    });

    const res = await GET(req());
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.pointsAggregated).toBe(3);
    expect(mockAggregate).toHaveBeenCalledTimes(1);
  });
});
