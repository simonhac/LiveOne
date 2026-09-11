/**
 * ROUTE-level tests for `POST /api/v4/devices/{id}/import` — operator-supplied readings.
 *
 * 🛑 Two properties are load-bearing, and both are about the fact that NOTHING DOWNSTREAM CAN
 * SECOND-GUESS THIS WRITE. Every other writer has a source of truth it can be re-derived from; an
 * import's source of truth is a person and a file.
 *
 *   1. `quality` is required and allow-listed. The column would happily store `"estimate"`, which
 *      ranks 0 forever and reads as "provenance never recorded" — indistinguishable from data whose
 *      provenance genuinely was not. A typo here is permanent and silent.
 *   2. Points are authorised against the device in the PATH. Authorisation was granted over the
 *      device; a `pt_…` in the body is caller-supplied, and one belonging to another device would
 *      be a write into a system the caller may not hold. Refused for the WHOLE request, because a
 *      partial import leaves nobody able to say which half landed.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/db/planetscale/schema", () => ({ devices: {}, points: {} }));
jest.mock("@/lib/readings", () => ({ ReadingsDao: { insert5m: jest.fn() } }));

import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import { Point } from "@/lib/ids";
import { POST } from "../devices/[id]/import/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockInsert = jest.mocked(ReadingsDao.insert5m);

const DEVICE_ID = "dv_01m22s95fteab8gr0w7wxwy4eh";
const DEVICE_UUID = "device-uuid";

/** Two real pt_ TypeIDs — the device's own, and one belonging to somewhere else. */
const POWER_PT = "pt_3ae6h0d8f2avvbadgq4t3ctsgq";
const ENERGY_PT = "pt_58s3drwwhdacg97vr2ce4s5qnj";
const FOREIGN_PT = "pt_7f3mdterw1bm781kx7dsn5jn5v";

/** 2026-09-11T00:05:00Z — on a 5-minute boundary. */
const T0 = "2026-09-11T00:05:00.000Z";

/** Rows the mocked points SELECT returns: only the device's own two points. */
let ownPoints: Array<Record<string, unknown>>;

const post = (body: unknown, id = DEVICE_ID) =>
  POST(
    new NextRequest(`http://localhost/api/v4/devices/${id}/import`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as NextRequest,
    { params: Promise.resolve({ id }) },
  );

const reading = (point: string, value: unknown = 1, intervalEnd = T0) => ({
  point,
  intervalEnd,
  value,
});

describe("POST /api/v4/devices/{id}/import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ownPoints = [
      {
        id: Point.toUuid(POWER_PT as never),
        metricType: "power",
        transform: null,
        logicalPath: "load.rest-of-house",
        physicalPath: "load_w",
        unit: "W",
      },
      {
        id: Point.toUuid(ENERGY_PT as never),
        metricType: "energy",
        transform: null,
        logicalPath: "source.solar",
        physicalPath: "solar_interval_wh",
        unit: "Wh",
      },
    ];
    mockDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: (() => {
            const r: Record<string, unknown> = {
              // The device lookup chains .limit(); the points lookup awaits the where directly.
              limit: async () => [{ rid: 13, uuid: DEVICE_UUID }],
              then: (res: (v: unknown) => unknown) => res(ownPoints),
            };
            return r;
          }) as never,
        }),
      }),
    } as never);
    mockAuth.mockResolvedValue({ device: { id: 13 } } as never);
    mockInsert.mockResolvedValue({ written: 1 });
  });

  describe("quality is required, and allow-listed", () => {
    it("refuses a body with no quality", async () => {
      const res = await post({ readings: [reading(POWER_PT)] });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/quality is required/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses a marker that is not in the vocabulary", async () => {
      // 🛑 THE test. `estimate` is a plausible typo for `estimated`; the column would take it.
      const res = await post({
        quality: "estimate",
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/unknown quality "estimate"/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("stamps the given marker on every row", async () => {
      const res = await post({
        quality: "interpolated",
        readings: [reading(POWER_PT), reading(ENERGY_PT)],
      });
      expect(res.status).toBe(200);
      const rows = mockInsert.mock.calls[0][0];
      expect(rows.every((r) => r.dataQuality === "interpolated")).toBe(true);
    });
  });

  describe("points are authorised against the device in the path", () => {
    it("refuses a point belonging to another device — for the whole request", async () => {
      const res = await post({
        quality: "good",
        readings: [reading(POWER_PT), reading(FOREIGN_PT)],
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/not this device's points/);
      // Nothing partial: the valid row must not land either.
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("a single value is shaped to the point's metric type", () => {
    it("puts a power value in avg/min/max/last and leaves delta null", async () => {
      await post({ quality: "good", readings: [reading(POWER_PT, 387)] });
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        avg: 387,
        min: 387,
        max: 387,
        last: 387,
        delta: null,
      });
    });

    it("puts an interval-energy value in delta and leaves avg/last null", async () => {
      // The caller sends one `value`; which column it belongs in is a property of the POINT, so an
      // operator never has to know that energy lands somewhere different from power.
      await post({ quality: "good", readings: [reading(ENERGY_PT, 250)] });
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        delta: 250,
        avg: null,
        min: null,
        max: null,
        last: null,
      });
    });
  });

  describe("timestamps must address a real 5-minute interval", () => {
    it("refuses a timestamp off the 5-minute grid", async () => {
      const res = await post({
        quality: "good",
        readings: [reading(POWER_PT, 1, "2026-09-11T00:07:00.000Z")],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not on a 5-minute boundary/);
    });

    it("refuses an unparseable timestamp", async () => {
      const res = await post({
        quality: "good",
        readings: [reading(POWER_PT, 1, "yesterday")],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not a parseable timestamp/);
    });
  });

  describe("the write itself", () => {
    it("upserts, so re-importing a corrected file converges", async () => {
      await post({ quality: "good", readings: [reading(POWER_PT)] });
      expect(mockInsert.mock.calls[0][1]).toEqual({ upsert: true });
    });

    it("writes nothing on a dry run, but still reports the plan", async () => {
      const res = await post({
        quality: "interpolated",
        readings: [reading(POWER_PT)],
        dryRun: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ dryRun: true, written: 0, rows: 1 });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses an interval other than 5m rather than silently writing one", async () => {
      const res = await post({
        interval: "1d",
        quality: "good",
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/import writes 5m only/);
    });
  });
});
