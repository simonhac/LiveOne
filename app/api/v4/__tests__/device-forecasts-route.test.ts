import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { Device } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/diagnostics/resolve-device", () => ({
  resolveDeviceParam: jest.fn(),
}));
jest.mock("@/lib/vendors/amber/forecast-store", () => ({
  ...(jest.requireActual("@/lib/vendors/amber/forecast-store") as object),
  readInForce: jest.fn(),
  readAsOf: jest.fn(),
  readCaptureHealth: jest.fn(),
}));
import { requireDeviceAccess } from "@/lib/api-auth";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import { MAX_IN_FORCE_ROWS } from "@/lib/vendors/amber/forecast-wire";
import {
  InForceTooLarge,
  readAsOf,
  readCaptureHealth,
  readInForce,
} from "@/lib/vendors/amber/forecast-store";
import { GET } from "../devices/[id]/forecasts/route";

const uuid = "0192f0ab-0000-7000-8000-000000000009";
const id = Device.encode(uuid);
const call = (qs: string) =>
  GET(new NextRequest(`http://localhost/api/v4/devices/${id}/forecasts${qs}`), {
    params: Promise.resolve({ id }),
  });

const vendor = (vendorType: string) =>
  jest
    .mocked(requireDeviceAccess)
    .mockResolvedValue({ device: { vendorType } } as never);

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(resolveDeviceParam)
    .mockResolvedValue({ uuid, systemId: 9 } as never);
  vendor("amber");
  jest.mocked(readInForce).mockImplementation(async (o) => ({
    channel: o.channel,
    captured: [],
    leads: [],
  }));
  jest.mocked(readAsOf).mockResolvedValue([]);
  jest.mocked(readCaptureHealth).mockResolvedValue({ rows: 0 } as never);
});

describe("authorization", () => {
  it("returns the gate's refusal and reads nothing", async () => {
    jest
      .mocked(requireDeviceAccess)
      .mockResolvedValue(
        NextResponse.json({ error: "no" }, { status: 403 }) as never,
      );
    expect((await call("?start=2026-09-01&end=2026-09-02")).status).toBe(403);
    expect(readInForce).not.toHaveBeenCalled();
  });

  it("passes the resolved handle to the device gate", async () => {
    await call("?start=2026-09-01&end=2026-09-02");
    expect(requireDeviceAccess).toHaveBeenCalledWith(expect.anything(), 9);
  });

  it("refuses a non-Amber device with 422 rather than an empty answer", async () => {
    vendor("fusher");
    const res = await call("?start=2026-09-01&end=2026-09-02");
    expect(res.status).toBe(422);
    expect(readInForce).not.toHaveBeenCalled();
  });
});

describe("in-force", () => {
  it("defaults to general + feedIn, leads 1-12, anchor end, over the AEST window", async () => {
    const res = await call("?start=2026-09-01&end=2026-09-02");
    expect(res.status).toBe(200);
    expect(readInForce).toHaveBeenCalledTimes(2);
    expect(readInForce).toHaveBeenCalledWith({
      deviceRid: 9,
      channel: "general",
      fromMs: Date.parse("2026-08-31T14:00:00Z"),
      toMs: Date.parse("2026-09-02T14:00:00Z"),
      leads: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      anchor: "end",
      maxRows: MAX_IN_FORCE_ROWS,
    });
    const body = await res.json();
    expect(body.channels.map((c: { channel: string }) => c.channel)).toEqual([
      "general",
      "feedIn",
    ]);
  });

  it("accepts repeatable channel/lead params and a start anchor", async () => {
    await call(
      "?start=2026-09-01&end=2026-09-01&channel=feedIn&lead=0.5&lead=1-3&anchor=start",
    );
    expect(readInForce).toHaveBeenCalledTimes(1);
    expect(readInForce).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feedIn",
        leads: [0.5, 1, 2, 3],
        anchor: "start",
      }),
    );
  });

  it("spends ONE row budget across channels, and answers 413 when it runs out", async () => {
    jest.mocked(readInForce).mockImplementation(async (o) => {
      if (o.channel === "feedIn")
        throw new InForceTooLarge("feedIn", 1000, 12, o.maxRows!);
      return {
        channel: o.channel,
        captured: Array.from({ length: 1000 }, () => "x"),
        leads: [],
      };
    });
    const res = await call("?start=2026-09-01&end=2026-09-02");
    expect(res.status).toBe(413);
    expect(
      jest.mocked(readInForce).mock.calls.map((c) => c[0].maxRows),
    ).toEqual([MAX_IN_FORCE_ROWS, MAX_IN_FORCE_ROWS - 12_000]);
  });

  it.each([
    ["missing window", ""],
    ["bad day", "?start=2026-02-30&end=2026-03-01"],
    ["backwards", "?start=2026-09-02&end=2026-09-01"],
    ["over 62 days", "?start=2026-06-01&end=2026-09-01"],
    ["unknown channel", "?start=2026-09-01&end=2026-09-01&channel=site"],
    ["bad lead", "?start=2026-09-01&end=2026-09-01&lead=abc"],
    ["too many leads", "?start=2026-09-01&end=2026-09-01&lead=1-49"],
    ["bad anchor", "?start=2026-09-01&end=2026-09-01&anchor=middle"],
    ["unknown mode", "?mode=everything&start=2026-09-01&end=2026-09-01"],
  ])("400 on %s", async (_label, qs) => {
    expect((await call(qs)).status).toBe(400);
    expect(readInForce).not.toHaveBeenCalled();
  });
});

describe("as-of", () => {
  it("requires at, defaults the horizon to 48h", async () => {
    expect((await call("?mode=as-of")).status).toBe(400);
    const res = await call("?mode=as-of&at=2026-09-01T00:00:00Z");
    expect(res.status).toBe(200);
    expect(readAsOf).toHaveBeenCalledWith({
      deviceRid: 9,
      atMs: Date.parse("2026-09-01T00:00:00Z"),
      horizonHours: 48,
    });
  });

  it("caps the horizon", async () => {
    expect(
      (await call("?mode=as-of&at=2026-09-01T00:00:00Z&horizon=500")).status,
    ).toBe(400);
  });
});

describe("health", () => {
  it("reads capture health over the window", async () => {
    const res = await call("?mode=health&start=2026-09-01&end=2026-09-07");
    expect(res.status).toBe(200);
    expect(readCaptureHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceRid: 9,
        fromMs: Date.parse("2026-08-31T14:00:00Z"),
        toMs: Date.parse("2026-09-07T14:00:00Z"),
      }),
    );
    expect((await res.json()).health).toEqual({ rows: 0 });
  });
});
