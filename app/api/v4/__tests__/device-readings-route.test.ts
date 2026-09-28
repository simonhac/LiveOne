/**
 * ROUTE-level tests for `GET /api/v4/devices/{id}/readings` — the raw evidence export.
 *
 * The boundary is what matters: who may read it (the device gate, called with the resolved rid),
 * and that a malformed or over-long window, limit, point or cursor is a 400 rather than a query.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Device, Point } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/diagnostics/resolve-device", () => ({
  resolveDeviceParam: jest.fn(),
}));
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [
            {
              id: "11111111-1111-4111-8111-111111111111",
              physicalPath: "battery/soc",
              logicalPath: "bidi.battery",
              metricType: "soc",
              unit: "%",
              name: "Battery SoC",
              transform: null,
              active: true,
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              physicalPath: "load/power",
              logicalPath: "load",
              metricType: "power",
              unit: "W",
              name: "Load",
              transform: "i",
              active: false,
            },
          ],
        }),
      }),
    }),
  })),
}));
jest.mock("@/lib/readings/dao", () => {
  class InvalidRawExportCursor extends Error {}
  return {
    InvalidRawExportCursor,
    ReadingsDao: { readRawExportPage: jest.fn() },
  };
});

import { requireDeviceAccess } from "@/lib/api-auth";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import { InvalidRawExportCursor, ReadingsDao } from "@/lib/readings/dao";
import { GET } from "../devices/[id]/readings/route";

const uuid = "0192f0ab-0000-7000-8000-000000000001";
const id = Device.encode(uuid);
const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/v4/devices/${id}/readings${qs}`), {
    params: Promise.resolve({ id }),
  });
const W = "?since=2026-09-17T09:21:00Z&until=2026-09-17T10:02:00Z";
const read = jest.mocked(ReadingsDao.readRawExportPage);

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(resolveDeviceParam)
    .mockResolvedValue({ uuid, systemId: 1 } as never);
  jest.mocked(requireDeviceAccess).mockResolvedValue({
    device: { vendorType: "selectronic", vendorSiteId: "1586" },
  } as never);
  read.mockResolvedValue({
    asOf: "2026-09-28T00:00:00.000000Z",
    readings: [],
    nextCursor: null,
  });
});

describe("authorization", () => {
  it("passes the resolved rid to the READ-level device gate", async () => {
    await call(W);
    expect(requireDeviceAccess).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("returns the gate's refusal and reads nothing", async () => {
    jest
      .mocked(requireDeviceAccess)
      .mockResolvedValue(
        NextResponse.json({ error: "no" }, { status: 403 }) as never,
      );
    expect((await call(W)).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the window", () => {
  it.each([
    ["no since", "?until=2026-09-17T10:00:00Z"],
    ["no until", "?since=2026-09-17T09:00:00Z"],
    [
      "a zone-less since",
      "?since=2026-09-17T09:00:00&until=2026-09-17T10:00:00Z",
    ],
    ["garbage", "?since=yesterday&until=2026-09-17T10:00:00Z"],
    [
      "until == since",
      "?since=2026-09-17T09:00:00Z&until=2026-09-17T09:00:00Z",
    ],
    ["until < since", "?since=2026-09-17T10:00:00Z&until=2026-09-17T09:00:00Z"],
    ["over 7 days", "?since=2026-09-10T00:00:00Z&until=2026-09-17T00:00:01Z"],
    ["limit 0", `${W}&limit=0`],
    ["limit over 10000", `${W}&limit=10001`],
    ["a fractional limit", `${W}&limit=1.5`],
    ["a non-pt point", `${W}&point=dv_x`],
  ])("400s on %s without reading", async (_l, qs) => {
    const res = await call(qs);
    expect(res.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts exactly 7 days, normalises offsets to UTC, and defaults the limit to 5000", async () => {
    const res = await call(
      "?since=2026-09-10T10:00:00%2B10:00&until=2026-09-17T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(Device.encode(uuid), {
      since: "2026-09-10T00:00:00.000Z",
      until: "2026-09-17T00:00:00.000Z",
      asOf: undefined,
      cursor: undefined,
      limit: 5000,
    });
  });

  it("forwards asOf and cursor, and maps a bad cursor to 400", async () => {
    await call(`${W}&asOf=2026-09-28T00:00:00.000000Z&cursor=abc&limit=10000`);
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        asOf: "2026-09-28T00:00:00.000000Z",
        cursor: "abc",
        limit: 10000,
      }),
    );
    read.mockRejectedValueOnce(new InvalidRawExportCursor("bad cursor"));
    const res = await call(`${W}&cursor=zzz`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad cursor");
  });
});

describe("the payload", () => {
  it("carries every point INCLUDING inactive ones, raw-untransformed, and no rids", async () => {
    const res = await call(W);
    const body = await res.json();
    expect(body.values).toBe("raw-untransformed");
    expect(body.asOf).toBe("2026-09-28T00:00:00.000000Z");
    expect(body.points).toEqual([
      {
        pointId: Point.encode(P1),
        physicalPath: "liveone/selectronic/1586/battery/soc",
        logicalPath: "bidi.battery/soc",
        metricType: "soc",
        unit: "%",
        name: "Battery SoC",
        transform: null,
        active: true,
      },
      expect.objectContaining({
        pointId: Point.encode(P2),
        transform: "i",
        active: false,
      }),
    ]);
    expect(JSON.stringify(body.points)).not.toMatch(/"rid"/);
    expect(read.mock.calls[0][1]).not.toHaveProperty("pointIds");
  });

  it("narrows by --point and --series glob", async () => {
    await call(`${W}&point=${Point.encode(P2)}`);
    expect(read.mock.calls[0][1].pointIds).toEqual([Point.encode(P2)]);
    read.mockClear();
    await call(`${W}&series=bidi.battery/*`);
    expect(read.mock.calls[0][1].pointIds).toEqual([Point.encode(P1)]);
  });

  it("400s on a point from another device and on a glob that matches nothing", async () => {
    const other = Point.encode("33333333-3333-4333-8333-333333333333");
    expect((await call(`${W}&point=${other}`)).status).toBe(400);
    expect((await call(`${W}&series=nope/*`)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
