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
 * 3. **One walk, every vendor.** The chunking, the session-per-chunk, the deadline and `nextStart`
 *    are the route's; only what to CALL is the vendor's (`lib/vendors/sync-legs.ts`). The tests for
 *    the walk therefore stay Amber's, and each other leg is tested for the one thing that is
 *    genuinely its own — the window it is handed, and the vocabulary it does or does not accept.
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
jest.mock("@/lib/vendors/sigenergy/sigenergy-client", () => ({
  SigenergyClient: jest.fn(),
}));
jest.mock("@/lib/vendors/sigenergy/statistics", () => ({
  backfillEnergyRange: jest.fn(),
}));
jest.mock("@/lib/vendors/openelectricity/backfill", () => ({
  backfillRange: jest.fn(),
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { updateUsage, updateForecasts } from "@/lib/vendors/amber/client";
import { backfillEnergyRange } from "@/lib/vendors/sigenergy/statistics";
import { backfillRange } from "@/lib/vendors/openelectricity/backfill";
import { POST } from "../devices/[id]/sync/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockCreds = jest.mocked(getDeviceCredentials);
const mockCollector = jest.mocked(createPollCollector);
const mockUsage = jest.mocked(updateUsage);
const mockForecasts = jest.mocked(updateForecasts);
const mockSigen = jest.mocked(backfillEnergyRange);
const mockOe = jest.mocked(backfillRange);

/** A real dv_ TypeID, so `Device.toUuidOrNull` resolves rather than 400ing on the shape. */
const DEVICE_ID = "dv_01m22s95fteab8gr0w7wxwy4eh";

/**
 * The device row the route selects — the uuid → handle hop, and ONLY that.
 *
 * 🛑 The vendor, the site id and the day offset come from the registry view on `auth.device`, not
 * from this row. Two sources for "what vendor is this" is how a leg ends up dispatched on one and
 * credentialled from the other.
 */
const row = { rid: 10002 };

function stubDb(present = true) {
  mockDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (present ? [row] : []) }),
      }),
    }),
  } as never);
}

/** The registry view `requireDeviceAccess` hands back — the route's only vendor authority. */
const deviceView: {
  id: number;
  // Nullable: an OpenElectricity region device is OWNERLESS, and the leg that needs no credentials
  // is exactly the one that must be constructible here.
  ownerClerkUserId: string | null;
  vendorType: string;
  vendorSiteId: string;
  displayName: string;
  timezoneOffsetMin: number;
  metadata: unknown;
} = {
  id: 10002,
  ownerClerkUserId: "user_1",
  vendorType: "amber",
  vendorSiteId: "SITE",
  displayName: "Amber",
  timezoneOffsetMin: 600,
  metadata: null,
};

function stubDevice(over: Partial<typeof deviceView> = {}) {
  mockAuth.mockResolvedValue({ device: { ...deviceView, ...over } } as never);
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
    stubDevice();
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
    mockSigen.mockResolvedValue({ days: [], errors: [] } as never);
    mockOe.mockResolvedValue({
      chunks: 1,
      intervalsIngested: 288,
      rateLimited: 0,
      errors: [],
    } as never);
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
    stubDevice({ vendorType: "select.live" });
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

  /**
   * 🛑 `observations: 0` is several outcomes. On 2026-09-10 a run over 2026-06-12 → 2026-07-06
   * published 0 because Amber had nothing, and a control over the already-recovered
   * 2026-07-07 → 2026-07-13 published 0 because stage 1 exited WITHOUT CALLING AMBER. Both looked
   * identical on the wire; separating them meant reading `sessions.response` out of prod.
   */
  describe("why a window published what it did", () => {
    /** `updateUsage` pushes one entry per stage it reaches and stops at the first early exit. */
    const withStages = (n: number, discovery: string) =>
      ({
        action: "updateUsage",
        success: true,
        summary: { numRowsInserted: 0 },
        stages: Array.from({ length: n }, (_, i) => ({
          stage: `usage stage ${i + 1}`,
          ...(i === n - 1 ? { discovery } : {}),
        })),
      }) as never;

    it("reports an empty vendor and a vendor never called as DIFFERENT outcomes", async () => {
      mockUsage.mockResolvedValue(
        withStages(2, "remote usage data for this interval is NOT AVAILABLE"),
      );
      const empty = await (
        await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" })
      ).json();
      expect(empty.chunks[0].audits[0].outcome).toBe("vendor-empty");

      mockUsage.mockResolvedValue(
        withStages(1, "yay, we already have BILLABLE usage data locally"),
      );
      const held = await (
        await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" })
      ).json();
      expect(held.chunks[0].audits[0].outcome).toBe("already-held");
    });

    it("carries the stage that STOPPED the walk, not an earlier one", async () => {
      // An earlier stage's text describes a step that then continued — the opposite of the finding.
      mockUsage.mockResolvedValue(
        withStages(2, "remote usage data for this interval is NOT AVAILABLE"),
      );
      const body = await (
        await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" })
      ).json();
      expect(body.chunks[0].audits[0].discovery).toMatch(/NOT AVAILABLE/);
    });

    it("refuses to classify an audit it does not recognise", async () => {
      // Reaching for the happy answer here is how "0 published" came to read as "vendor is empty".
      mockUsage.mockResolvedValue(withStages(0, ""));
      const body = await (
        await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" })
      ).json();
      expect(body.chunks[0].audits[0].outcome).toBe("unknown");
    });

    it("reports one audit per action, so `both` cannot hide half its answer", async () => {
      mockUsage.mockResolvedValue(withStages(2, "nothing upstream"));
      mockForecasts.mockResolvedValue(withStages(1, "already held"));
      const body = await (
        await post({ start: "2026-07-07", end: "2026-07-08", action: "both" })
      ).json();
      expect(body.chunks[0].audits).toHaveLength(2);
      expect(
        body.chunks[0].audits.map((a: { outcome: string }) => a.outcome),
      ).toEqual(["vendor-empty", "already-held"]);
    });
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
    stubDevice({ vendorType: "select.live" });
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
    stubDb(false);
    expect(
      (await post({ start: "2026-07-07", end: "2026-07-08" })).status,
    ).toBe(404);
  });

  it("runs only the half the action names", async () => {
    await post({ start: "2026-07-07", end: "2026-07-08", action: "usage" });
    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(mockForecasts).not.toHaveBeenCalled();
  });

  /**
   * The other two legs. Their vendor calls are mocked, so what is under test is the seam: the
   * window each is handed, that it is NOT handed an action it has no notion of, and that a zero
   * still explains itself.
   */
  describe("the vendors that are not Amber", () => {
    const sigen = { vendorType: "sigenergy", vendorSiteId: "STATION-1" };
    const oe = {
      vendorType: "openelectricity",
      vendorSiteId: "NSW1",
      ownerClerkUserId: null,
    };

    beforeEach(() => {
      mockCreds.mockResolvedValue({
        username: "u",
        password: "p",
        apiKey: "k",
      } as never);
    });

    it("hands Sigenergy whole local days, in the vendor's own YYYYMMDD", async () => {
      stubDevice(sigen);
      await post({ start: "2026-09-10", end: "2026-09-11" });
      expect(mockSigen).toHaveBeenCalledTimes(1);
      expect(mockSigen.mock.calls[0][0]).toMatchObject({
        systemId: 10002,
        stationId: "STATION-1",
        startDate: "20260910",
        endDate: "20260911",
        // 🛑 The DEVICE's offset, not the server's. The days a Sigenergy station reports are its
        // own, and UTC days would silently shift every window by ten hours.
        tzOffsetMin: 600,
      });
    });

    it("chunks Sigenergy to keep one request inside the route's budget", async () => {
      stubDevice(sigen);
      const body = await (
        await post({ start: "2026-09-01", end: "2026-09-16" })
      ).json();
      expect(
        body.plan.map((p: { start: string; end: string }) => [p.start, p.end]),
      ).toEqual([
        ["2026-09-01", "2026-09-07"],
        ["2026-09-08", "2026-09-14"],
        ["2026-09-15", "2026-09-16"],
      ]);
    });

    it("refuses an action for a vendor that has no action axis", async () => {
      // 🛑 Refused, not ignored. An ignored `--action=usage` would look like it had narrowed the
      // fetch and would silently pull everything — the vendor has one surface, so the flag names
      // nothing and saying so is the only honest answer.
      stubDevice(sigen);
      const res = await post({
        start: "2026-09-10",
        end: "2026-09-11",
        action: "usage",
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/no action axis/);
      expect(mockSigen).not.toHaveBeenCalled();
    });

    it("reports no action rather than inventing Amber's default", async () => {
      stubDevice(sigen);
      const body = await (
        await post({ start: "2026-09-10", end: "2026-09-11" })
      ).json();
      expect(body.action).toBeNull();
    });

    it("refuses Sigenergy without credentials, before fetching anything", async () => {
      stubDevice(sigen);
      mockCreds.mockResolvedValue(null as never);
      const res = await post({ start: "2026-09-10", end: "2026-09-11" });
      expect(res.status).toBe(400);
      expect(mockSigen).not.toHaveBeenCalled();
      expect(jest.mocked(sessionManager.createSession)).not.toHaveBeenCalled();
    });

    it("tells an empty Sigenergy day from one that published", async () => {
      stubDevice(sigen);
      mockSigen.mockResolvedValue({
        days: [{ empty: true, readingsWritten: 0, derivedWritten: 0 }],
        errors: [],
      } as never);
      const empty = await (
        await post({ start: "2026-09-10", end: "2026-09-10" })
      ).json();
      expect(empty.chunks[0].audits[0].outcome).toBe("vendor-empty");

      mockSigen.mockResolvedValue({
        days: [{ empty: false, readingsWritten: 288, derivedWritten: 12 }],
        errors: [],
      } as never);
      const got = await (
        await post({ start: "2026-09-10", end: "2026-09-10" })
      ).json();
      expect(got.chunks[0].audits[0].outcome).toBe("published");
      expect(got.chunks[0].audits[0].discovery).toMatch(/12 derived/);
    });

    it("does not claim an empty vendor when only SOME days were empty", async () => {
      // 🛑 `every`, not `some`. A range where one day published and one did not is not evidence
      // that the vendor has nothing — which is the reading "vendor-empty" invites.
      stubDevice(sigen);
      mockSigen.mockResolvedValue({
        days: [
          { empty: true, readingsWritten: 0, derivedWritten: 0 },
          { empty: false, readingsWritten: 0, derivedWritten: 0 },
        ],
        errors: [],
      } as never);
      const body = await (
        await post({ start: "2026-09-10", end: "2026-09-11" })
      ).json();
      expect(body.chunks[0].audits[0].outcome).toBe("nothing-superior");
    });

    it("hands OpenElectricity the region and an inclusive end-of-day", async () => {
      stubDevice(oe);
      await post({ start: "2026-09-10", end: "2026-09-10" });
      const args = mockOe.mock.calls[0][0];
      expect(args).toMatchObject({ systemId: 10002, region: "NSW1" });
      // +10, so the local day is 2026-09-09T14:00Z → 2026-09-10T14:00Z.
      expect(args.dateStart.toISOString()).toBe("2026-09-09T14:00:00.000Z");
      expect(args.dateEnd.toISOString()).toBe("2026-09-10T14:00:00.000Z");
    });

    it("never lets an OpenElectricity backfill trigger the fleet-wide sweep", async () => {
      // 🛑 `backfillRange`'s `aggregate` runs `aggregateRange` — HWS, battery learning, run periods
      // and two reheal passes, fleet-wide and out to NOW. From a 45s route that is a timeout; from
      // any route it is work nobody asked for. Rebuilding is `liveone device recompute`'s job.
      stubDevice(oe);
      await post({ start: "2026-09-10", end: "2026-09-10" });
      expect(mockOe.mock.calls[0][0].aggregate).toBeNull();
    });

    it("refuses an OpenElectricity device whose site id is not a NEM region", async () => {
      stubDevice({ ...oe, vendorSiteId: "ATLANTIS" });
      const res = await post({ start: "2026-09-10", end: "2026-09-10" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/ATLANTIS/);
      expect(mockOe).not.toHaveBeenCalled();
    });
  });
});
