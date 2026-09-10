/**
 * ROUTE-level tests for `POST /api/v4/devices/{id}/sync` — the headless vendor re-fetch.
 *
 * Two things here are load-bearing:
 *
 * 1. **Chunking to the VENDOR's window.** Amber answers at most 7 days; the admin route validated
 *    30, so every call in 8..30 sailed through our validation and died at Amber with an opaque 422.
 *    The caller passes the range it wants and this route walks it.
 * 2. **Nothing is called "inserted".** `observations` counts what was PUBLISHED. The 2026-09-09
 *    backfill reported `Rows inserted: 1008` ten times for zero materialised rows, because the
 *    number described a comparison, not a write. Proving data landed is a separate READ.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { CalendarDate } from "@internationalized/date";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/db/planetscale/schema", () => ({ devices: {} }));
jest.mock("@/lib/secure-credentials", () => ({
  getDeviceCredentials: jest.fn(),
}));
jest.mock("@/lib/session-manager", () => ({
  sessionManager: {
    createSession: jest.fn(),
    updateSessionResult: jest.fn(),
  },
}));
jest.mock("@/lib/observations/poll-collector", () => ({
  createPollCollector: jest.fn(),
}));
jest.mock("@/lib/vendors/amber/client", () => ({
  AMBER_MAX_SYNC_DAYS: 7,
  updateUsage: jest.fn(),
  updateForecasts: jest.fn(),
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { updateUsage, updateForecasts } from "@/lib/vendors/amber/client";
import { POST } from "../devices/[id]/sync/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockCreds = jest.mocked(getDeviceCredentials);
const mockCollector = jest.mocked(createPollCollector);
const mockUsage = jest.mocked(updateUsage);
const mockForecasts = jest.mocked(updateForecasts);

/** A real dv_ TypeID, so `Device.toUuidOrNull` resolves rather than 400ing on the shape. */
const DEVICE_ID = "dv_01m22s95fteab8gr0w7wxwy4eh";

/** The device row the route selects. */
const row = {
  rid: 10002,
  vendor: "amber",
  vendorSiteId: "SITE",
  name: "Amber",
};

function stubDb(over: Partial<typeof row> | null = {}) {
  mockDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (over === null ? [] : [{ ...row, ...over }]),
        }),
      }),
    }),
  } as never);
}

/** The windows `updateUsage` was actually asked for — the whole point of the chunking test. */
const windowsAsked = () =>
  mockUsage.mock.calls.map((c) => [
    (c[1] as CalendarDate).toString(),
    c[2] as number,
  ]);

const post = (body: unknown, id = DEVICE_ID) =>
  POST(
    new NextRequest(`http://localhost/api/v4/devices/${id}/sync`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as NextRequest,
    { params: Promise.resolve({ id }) },
  );

const audit = (ok = true) =>
  ({
    success: ok,
    summary: { numRowsInserted: 999, error: ok ? undefined : "vendor said no" },
    stages: [],
  }) as never;

describe("POST /api/v4/devices/{id}/sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubDb();
    mockAuth.mockResolvedValue({
      device: { ownerClerkUserId: "user_1" },
    } as never);
    mockCreds.mockResolvedValue({ apiKey: "k", siteId: "S" } as never);
    jest
      .mocked(sessionManager.createSession)
      .mockResolvedValue({ id: 1 } as never);
    jest
      .mocked(sessionManager.updateSessionResult)
      .mockResolvedValue(undefined as never);
    mockCollector.mockReturnValue({
      observations: Array.from({ length: 12 }),
      mergedCount: 0,
      lane: "backfill",
      add: jest.fn(),
    } as never);
    mockUsage.mockResolvedValue(audit());
    mockForecasts.mockResolvedValue(audit());
  });

  it("passes an auth rejection straight through", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "nope" }, { status: 403 }) as never,
    );
    expect(
      (await post({ start: "2026-07-07", end: "2026-07-08" })).status,
    ).toBe(403);
  });

  it("chunks a long window to the VENDOR's 7 days, and covers it exactly", async () => {
    // 🛑 The caller asked for 16 days and never mentioned 7. Amber refuses anything longer with
    // `"Range requested is too large. Maximum 7 days."`, and the admin route's `days <= 30` let
    // 8..30 through to die there.
    const res = await post({
      start: "2026-07-07",
      end: "2026-07-22",
      action: "usage",
    });
    const body = await res.json();

    expect(windowsAsked()).toEqual([
      ["2026-07-07", 7],
      ["2026-07-14", 7],
      ["2026-07-21", 2], // the remainder, not a full window padded past the range
    ]);
    expect(
      body.chunks.map((c: { start: string; end: string }) => [c.start, c.end]),
    ).toEqual([
      ["2026-07-07", "2026-07-13"],
      ["2026-07-14", "2026-07-20"],
      ["2026-07-21", "2026-07-22"],
    ]);
    expect(body.done).toBe(true);
    expect(body.nextStart).toBeNull();
  });

  it("a dry run touches NOTHING, and still reports the real boundaries", async () => {
    // 🛑 The admin sync's "dry run" fetched every window from Amber and wrote an `ADMIN-DRYRUN`
    // session per call — minutes of vendor traffic and a row per chunk, to answer a question about
    // what WOULD happen. The harness contract is "report what would change and write nothing".
    const body = await (
      await post({
        start: "2026-07-07",
        end: "2026-07-22",
        action: "usage",
        dryRun: true,
      })
    ).json();

    expect(mockUsage).not.toHaveBeenCalled();
    expect(mockForecasts).not.toHaveBeenCalled();
    expect(jest.mocked(sessionManager.createSession)).not.toHaveBeenCalled();
    expect(
      jest.mocked(sessionManager.updateSessionResult),
    ).not.toHaveBeenCalled();

    // The boundaries are real, not a promise to work them out later — the caller renders these.
    expect(
      body.plan.map((p: { start: string; end: string }) => [p.start, p.end]),
    ).toEqual([
      ["2026-07-07", "2026-07-13"],
      ["2026-07-14", "2026-07-20"],
      ["2026-07-21", "2026-07-22"],
    ]);
    expect(body.chunks).toEqual([]);
    expect(body.dryRun).toBe(true);
  });

  it("still refuses an unsyncable device on a dry run, before any of it", async () => {
    // The credential and vendor checks are the part worth learning BEFORE committing.
    stubDb({ vendor: "select.live" });
    expect(
      (await post({ start: "2026-07-07", end: "2026-07-08", dryRun: true }))
        .status,
    ).toBe(422);
  });

  it("publishes every chunk on the BACKFILL lane", async () => {
    // A multi-week replay on the live lane is exactly what took ingest down for 2h20m.
    await post({ start: "2026-07-07", end: "2026-07-22" });
    for (const call of mockCollector.mock.calls)
      expect(call[0]).toMatchObject({ lane: "backfill" });
  });

  it("counts what was PUBLISHED, and never calls it inserted", async () => {
    // The vendor audit says `numRowsInserted: 999`. That number describes a comparison, and it is
    // the one that reported success for a backfill that materialised nothing.
    const body = await (
      await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" })
    ).json();

    expect(body.observations).toBe(12); // the collector's real payload
    expect(JSON.stringify(body)).not.toMatch(/999/);
    expect(JSON.stringify(body)).not.toMatch(/inserted/i);
  });

  it("stops the walk at a failed window rather than repeating the error", async () => {
    mockUsage
      .mockResolvedValueOnce(audit(true))
      .mockResolvedValueOnce(audit(false));

    const body = await (
      await post({ start: "2026-07-07", end: "2026-08-07", action: "usage" })
    ).json();

    expect(body.chunks).toHaveLength(2);
    expect(body.failed).toBe(1);
    expect(body.chunks[1].error).toMatch(/vendor said no/);
    expect(body.done).toBe(false);
  });

  it("publishes a failed window's partial haul instead of discarding it", async () => {
    // The session is closed — and therefore published — on the failure path too.
    mockUsage.mockResolvedValue(audit(false));
    await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" });

    expect(
      jest.mocked(sessionManager.updateSessionResult),
    ).toHaveBeenCalledTimes(1);
    const [, result] = jest.mocked(sessionManager.updateSessionResult).mock
      .calls[0];
    expect(result).toMatchObject({ successful: false, numRows: 12 });
  });

  it("refuses a vendor with no re-fetch path, naming it", async () => {
    stubDb({ vendor: "select.live" });
    const res = await post({ start: "2026-07-07", end: "2026-07-08" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/select\.live/);
  });

  it("refuses a backwards or malformed window", async () => {
    expect(
      (await post({ start: "2026-07-22", end: "2026-07-07" })).status,
    ).toBe(422);
    expect((await post({ start: "2026-07-07" })).status).toBe(422);
    expect((await post({ start: "not-a-day", end: "2026-07-07" })).status).toBe(
      422,
    );
    expect(
      (await post({ start: "2026-07-07", end: "2026-07-08", action: "nope" }))
        .status,
    ).toBe(422);
  });

  it("404s an unknown device without saying whether it exists", async () => {
    stubDb(null);
    expect(
      (await post({ start: "2026-07-07", end: "2026-07-08" })).status,
    ).toBe(404);
  });

  it("runs only the half the action names", async () => {
    await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" });
    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(mockForecasts).not.toHaveBeenCalled();
  });
});
