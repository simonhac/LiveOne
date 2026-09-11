/**
 * Tests for the stale-`agg_1d` sweep.
 *
 * 🛑 Two properties keep this from becoming a nightly self-inflicted load:
 *   1. TODAY is never swept. The live poll writes 5m rows all day, so today's `agg_5m` is always
 *      newer than its `agg_1d` — today would match on every run, forever, and rebuilding it achieves
 *      nothing that `cron/daily` will not do tomorrow.
 *   2. The per-run cap works oldest-first, so a long backlog drains monotonically instead of the
 *      run re-picking the same slice and never reaching the rest.
 * And one that keeps it from breaking the caller: it is a backstop, so it must never throw.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/readings", () => ({
  ReadingsDao: { staleAgg1dLocalDays: jest.fn() },
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));
jest.mock("@/lib/aggregation/scoped-recompute", () => ({
  recomputeDerivedForDeviceDays: jest.fn(),
}));

import { ReadingsDao } from "@/lib/readings";
import { PointManager } from "@/lib/point/point-manager";
import { recomputeDerivedForDeviceDays } from "@/lib/aggregation/scoped-recompute";
import { healStaleAgg1dForDevice } from "../heal-stale-agg1d";

const mockStale = jest.mocked(ReadingsDao.staleAgg1dLocalDays);
const mockPM = jest.mocked(PointManager.getInstance);
const mockRecompute = jest.mocked(recomputeDerivedForDeviceDays);

/** Melbourne, UTC+10 — the device this whole investigation came from. */
const DEVICE = { id: 13, timezoneOffsetMin: 600 };
const db = {} as never;

/** 2026-09-11T07:08:00Z = 17:08 local on 11 Sep. */
const NOW = Date.parse("2026-09-11T07:08:00.000Z");

describe("healStaleAgg1dForDevice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPM.mockReturnValue({
      loadPointInfoMap: async () => ({
        a: { pointUid: "00000000-0000-7000-8000-000000000001" },
      }),
    } as never);
    mockStale.mockResolvedValue([]);
    mockRecompute.mockResolvedValue({ agg1dDays: 1, provenanceAreas: 1 });
  });

  it("scans up to the START of the device's current local day, never into it", async () => {
    await healStaleAgg1dForDevice(db, DEVICE, { lookbackDays: 7, nowMs: NOW });
    const opts = mockStale.mock.calls[0][1];
    // 11 Sep 00:00 +10:00 === 2026-09-10T14:00:00Z
    expect(new Date(opts.toMs).toISOString()).toBe("2026-09-10T14:00:00.000Z");
    expect(new Date(opts.fromMs).toISOString()).toBe(
      "2026-09-03T14:00:00.000Z",
    );
    expect(opts.offsetMin).toBe(600);
  });

  it("uses the DEVICE's offset for the day boundary, not the server's", async () => {
    await healStaleAgg1dForDevice(
      db,
      { id: 1, timezoneOffsetMin: 0 },
      { lookbackDays: 1, nowMs: NOW },
    );
    const opts = mockStale.mock.calls[0][1];
    expect(new Date(opts.toMs).toISOString()).toBe("2026-09-11T00:00:00.000Z");
  });

  it("does nothing when no day is stale", async () => {
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 7,
      nowMs: NOW,
    });
    expect(r.healed).toEqual([]);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("rebuilds the stale days it finds", async () => {
    mockStale.mockResolvedValue(["2026-09-09", "2026-09-10"]);
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 7,
      nowMs: NOW,
    });
    expect(r.healed).toEqual(["2026-09-09", "2026-09-10"]);
    expect(mockRecompute.mock.calls[0][2]).toEqual([
      "2026-09-09",
      "2026-09-10",
    ]);
  });

  it("caps a long backlog and takes the OLDEST days, so successive runs make progress", async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`,
    );
    mockStale.mockResolvedValue(many);
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 90,
      nowMs: NOW,
    });
    expect(r.found).toHaveLength(30);
    expect(r.healed).toHaveLength(14);
    expect(r.healed[0]).toBe("2026-08-01");
  });

  it("returns empty rather than throwing when the device has no points", async () => {
    mockPM.mockReturnValue({ loadPointInfoMap: async () => ({}) } as never);
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 7,
      nowMs: NOW,
    });
    expect(r.healed).toEqual([]);
    expect(mockStale).not.toHaveBeenCalled();
  });

  it("swallows a failure — a backstop must never be why the backfill did not run", async () => {
    mockStale.mockRejectedValue(new Error("connection reset"));
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 7,
      nowMs: NOW,
    });
    expect(r).toMatchObject({ found: [], healed: [], agg1dDays: 0 });
  });

  it("stops between batches when the deadline passes, and reports only what it rebuilt", async () => {
    // 🛑 A caller-level check BEFORE this function does not bound it: one device can rebuild 14 days
    // plus Area provenance for each, so a device entered a second before the budget expires could
    // otherwise consume the whole invocation.
    mockStale.mockResolvedValue([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
    // A clock the test drives: the first batch is inside the budget, the second is not.
    let t = 0;
    mockRecompute.mockImplementation(async () => {
      t += 100;
      return { agg1dDays: 1, provenanceAreas: 0 };
    });
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 90,
      nowMs: NOW,
      deadlineMs: 50,
      now: () => t,
    });
    expect(r.found).toHaveLength(6);
    expect(r.healed).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it("rebuilds every planned day when there is budget", async () => {
    mockStale.mockResolvedValue([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    const r = await healStaleAgg1dForDevice(db, DEVICE, {
      lookbackDays: 90,
      nowMs: NOW,
      deadlineMs: Date.now() + 60_000,
    });
    expect(r.healed).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    // Batched in threes, so two calls — not one per day, and not one for all four.
    expect(mockRecompute).toHaveBeenCalledTimes(2);
  });
});
