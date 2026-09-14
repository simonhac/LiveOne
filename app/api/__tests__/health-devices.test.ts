/**
 * /api/health/devices is reachable from the public internet (it's in `publicRoutes`, so Clerk's
 * middleware doesn't gate it). Its access control is therefore entirely its own, and this repo is
 * public — so the fail-closed behaviour is the part worth pinning.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NextRequest } from "next/server";

const evaluateDeviceHealth =
  jest.fn<() => Promise<Record<string, unknown>[]>>();
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: {} }));
// Only the DB-touching function is faked. `unhealthy`/`alertable` are the REAL ones: they decide
// which codes 503 and which merely appear in the body, and a hand-rolled copy here would let the
// route and the rule drift apart silently — which is the failure this route exists to prevent.
jest.mock("@/lib/monitoring/device-staleness", () => ({
  ...(jest.requireActual("@/lib/monitoring/device-staleness") as object),
  evaluateDeviceHealth: () => evaluateDeviceHealth(),
}));

import { GET } from "../health/devices/route";

const KEY = "test-health-key";
const req = (headers: Record<string, string> = {}) =>
  new NextRequest("https://www.liveone.energy/api/health/devices", { headers });

const device = (over: Record<string, unknown> = {}) => ({
  rid: 1,
  name: "Test",
  vendor: "amber",
  code: "ok",
  staleMin: 1,
  budgetMin: 15,
  consecutiveErrors: 0,
  message: "",
  ...over,
});

beforeEach(() => {
  evaluateDeviceHealth.mockReset();
  process.env.HEALTH_CHECK_KEY = KEY;
});

describe("GET /api/health/devices", () => {
  it("404s without the key, revealing nothing", async () => {
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(evaluateDeviceHealth).not.toHaveBeenCalled();
  });

  it("404s with the wrong key", async () => {
    const res = await GET(req({ "x-health-key": "wrong" }));
    expect(res.status).toBe(404);
  });

  // An unset secret must never mean "open" — that is how a public inventory leak happens.
  it("fails closed when no key is configured", async () => {
    delete process.env.HEALTH_CHECK_KEY;
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(404);
    expect(evaluateDeviceHealth).not.toHaveBeenCalled();
  });

  it("200s when every device is healthy", async () => {
    evaluateDeviceHealth.mockResolvedValue([device(), device({ rid: 2 })]);
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", checked: 2, unhealthy: [] });
  });

  it("503s and names the offenders when a device is stale", async () => {
    evaluateDeviceHealth.mockResolvedValue([
      device(),
      device({ rid: 7, code: "device_poll_stale", staleMin: 99 }),
    ]);
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.unhealthy).toHaveLength(1);
    expect(body.unhealthy[0]).toMatchObject({
      rid: 7,
      code: "device_poll_stale",
      staleMin: 99,
    });
  });

  it("503s on the leading indicator too", async () => {
    evaluateDeviceHealth.mockResolvedValue([
      device({ code: "device_failing", consecutiveErrors: 6 }),
    ]);
    expect((await GET(req({ "x-health-key": KEY }))).status).toBe(503);
  });

  // A device that was added and never wired up would otherwise pin the monitor red forever.
  it("reports but does not fail on a never-polled device", async () => {
    evaluateDeviceHealth.mockResolvedValue([
      device({ code: "device_never_polled", staleMin: null }),
    ]);
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.unhealthy).toHaveLength(1); // still surfaced, just not fatal
  });

  // A vendor doing exactly what it said it would. Reported with its evidence; does not page.
  it("reports but does not fail on a device in its vendor's maintenance window", async () => {
    evaluateDeviceHealth.mockResolvedValue([
      device(),
      device({
        rid: 9,
        code: "device_in_maintenance",
        staleMin: 16,
        consecutiveErrors: 5,
      }),
    ]);
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.unhealthy).toHaveLength(1);
    expect(body.unhealthy[0]).toMatchObject({
      rid: 9,
      code: "device_in_maintenance",
      consecutiveErrors: 5, // the evidence is in the body even though nothing pages
    });
  });

  // Suppressing one device must not suppress the check. This is the shape of a night where Amber
  // is in its window and something else has genuinely gone dark.
  it("still 503s when a maintenance device sits alongside a real failure", async () => {
    evaluateDeviceHealth.mockResolvedValue([
      device({ rid: 9, code: "device_in_maintenance", staleMin: 16 }),
      device({ rid: 1, code: "device_poll_stale", staleMin: 99 }),
    ]);
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.unhealthy).toHaveLength(2); // both reported
    expect(body.unhealthy.map((d: { rid: number }) => d.rid)).toEqual([9, 1]);
  });

  it("503s when the evaluation itself fails", async () => {
    evaluateDeviceHealth.mockRejectedValue(new Error("PG gone"));
    const res = await GET(req({ "x-health-key": KEY }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/PG gone/);
  });
});
