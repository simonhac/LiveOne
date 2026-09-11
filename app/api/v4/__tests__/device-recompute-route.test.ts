/**
 * ROUTE-level tests for `POST /api/v4/devices/{id}/recompute` — the scoped derived rebuild.
 *
 * 🛑 What is load-bearing here is that THE DANGEROUS CASE IS NOT REACHABLE BY TYPING LESS. This is a
 * delete-and-reinsert, and its fleet-wide twin (`/api/cron/daily?action=regenerate`) reads a missing
 * date as *all available history* — the same shape through which an unscoped derivation regenerate
 * once collapsed 71 rows to 3. Every "refuses" test below is that property.
 *
 * The second is that the rebuild is SCOPED: `recomputeDerivedForDeviceDays`, never `aggregateRange`.
 * A one-day backfill that reached for the fleet sweep spent a whole 300s budget in it on prod.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/db/planetscale/schema", () => ({ devices: {} }));
jest.mock("@/lib/aggregation/scoped-recompute", () => ({
  recomputeDerivedForDeviceDays: jest.fn(),
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { recomputeDerivedForDeviceDays } from "@/lib/aggregation/scoped-recompute";
import { POST } from "../devices/[id]/recompute/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockRecompute = jest.mocked(recomputeDerivedForDeviceDays);

/** A real dv_ TypeID, so `Device.toUuidOrNull` resolves rather than 400ing on the shape. */
const DEVICE_ID = "dv_01m22s95fteab8gr0w7wxwy4eh";

const post = (body: unknown, id = DEVICE_ID) =>
  POST(
    new NextRequest(`http://localhost/api/v4/devices/${id}/recompute`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as NextRequest,
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/v4/devices/{id}/recompute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ rid: 13 }] }),
        }),
      }),
    } as never);
    mockAuth.mockResolvedValue({
      device: {
        id: 13,
        vendorType: "sigenergy",
        displayName: "Kutis",
        timezoneOffsetMin: 600,
      },
    } as never);
    mockRecompute.mockResolvedValue({ agg1dDays: 2, provenanceAreas: 1 });
  });

  describe("the window is required, and is never inferred", () => {
    it("refuses a body with no window at all", async () => {
      // 🛑 THE test. `/api/cron/daily` treats this exact input as "rebuild everything ever".
      const res = await post({});
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/window is required/);
      expect(mockRecompute).not.toHaveBeenCalled();
    });

    it("refuses a lone start", async () => {
      expect((await post({ start: "2026-09-10" })).status).toBe(422);
      expect(mockRecompute).not.toHaveBeenCalled();
    });

    it("refuses date AND a range together, rather than preferring one", async () => {
      // Silently preferring one gives the caller a rebuild of a window they can see in their own
      // command and did not get.
      const res = await post({
        date: "2026-09-10",
        start: "2026-09-01",
        end: "2026-09-02",
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not both/);
    });

    it("refuses a backwards window", async () => {
      expect(
        (await post({ start: "2026-09-11", end: "2026-09-10" })).status,
      ).toBe(422);
    });

    it("refuses a window past the cap, naming its size", async () => {
      const res = await post({ start: "2026-01-01", end: "2026-06-01" });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/152 days/);
      expect(mockRecompute).not.toHaveBeenCalled();
    });

    it("allows exactly the cap", async () => {
      expect(
        (await post({ start: "2026-09-01", end: "2026-10-01" })).status,
      ).toBe(200);
    });
  });

  it("expands a range into the inclusive local days it will replace", async () => {
    const body = await (
      await post({ start: "2026-09-10", end: "2026-09-12" })
    ).json();
    expect(body.days).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
    expect(body.window).toEqual({
      start: "2026-09-10",
      end: "2026-09-12",
      days: 3,
    });
    expect(mockRecompute.mock.calls[0][2]).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
  });

  it("treats a single date as a one-day window", async () => {
    const body = await (await post({ date: "2026-09-10" })).json();
    expect(body.days).toEqual(["2026-09-10"]);
  });

  it("rebuilds against the DEVICE's day offset, not the server's", async () => {
    // A device's daily aggregates roll up on its own fixed offset; a UTC day would shift every
    // boundary by ten hours and rebuild two half-days.
    await post({ date: "2026-09-10" });
    expect(mockRecompute.mock.calls[0][1]).toEqual({
      id: 13,
      timezoneOffsetMin: 600,
    });
  });

  it("is SCOPED — it reports what it rebuilt, per day and per area", async () => {
    mockRecompute.mockResolvedValue({ agg1dDays: 3, provenanceAreas: 2 });
    const body = await (
      await post({ start: "2026-09-10", end: "2026-09-12" })
    ).json();
    expect(body).toMatchObject({ agg1dDays: 3, provenanceAreas: 2 });
  });

  it("reports a SHORTFALL rather than the request echoed back", async () => {
    // 🛑 The recompute is best-effort per day. `agg1dDays` short of `days.length` is the only signal
    // that some of them did not rebuild, so it must be a measurement and never the ask.
    mockRecompute.mockResolvedValue({ agg1dDays: 1, provenanceAreas: 0 });
    const body = await (
      await post({ start: "2026-09-10", end: "2026-09-12" })
    ).json();
    expect(body.agg1dDays).toBe(1);
    expect(body.days).toHaveLength(3);
  });

  it("a dry run resolves the window and rebuilds NOTHING", async () => {
    const body = await (
      await post({ start: "2026-09-10", end: "2026-09-11", dryRun: true })
    ).json();
    expect(mockRecompute).not.toHaveBeenCalled();
    expect(body.dryRun).toBe(true);
    expect(body.days).toEqual(["2026-09-10", "2026-09-11"]);
    expect(body.agg1dDays).toBe(0);
  });

  it("still refuses a bad window on a dry run", async () => {
    expect((await post({ dryRun: true })).status).toBe(422);
  });

  it("passes an auth rejection straight through", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "nope" }, { status: 403 }) as never,
    );
    expect((await post({ date: "2026-09-10" })).status).toBe(403);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("404s an unknown device without saying whether it exists", async () => {
    mockDb.mockReturnValue({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    } as never);
    expect((await post({ date: "2026-09-10" })).status).toBe(404);
  });

  it("400s a device id that is not a dv_ TypeID", async () => {
    expect((await post({ date: "2026-09-10" }, "nonsense")).status).toBe(400);
  });
});
