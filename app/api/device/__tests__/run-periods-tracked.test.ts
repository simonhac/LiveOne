/**
 * `/api/device/{id}/run-periods` must not answer "nothing is tracked here" and "this detector
 * produced nothing in this window" with the same response.
 *
 * 🛑 Why this is pinned. Both used to be `200 { events: [] }`, and a client rendering the period
 * message for the configuration state makes a confident false claim: a dashboard bracketed four EV
 * charge sessions on its chart while the panel beneath it said "No charge sessions in this period",
 * and nothing anywhere reported a problem. The cause was a resolver returning the wrong device
 * (pinned separately in `lib/capabilities/__tests__/member-devices-dispatch.test.ts`) — but what made
 * it invisible for as long as it was, is that this endpoint had no way to say "no detector".
 *
 * This route is in `shareableRoutes`, so it also answers anonymous `?access=` viewers, who have no
 * CLI to check it against. See `docs/plans/exact-resolution-or-refuse.md`.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NextRequest } from "next/server";

/** A drizzle-shaped chain where every builder method returns itself and awaiting yields `rows`. */
const chain = (rows: unknown[]) => {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "from",
    "where",
    "innerJoin",
    "orderBy",
    "limit",
    "offset",
  ]) {
    c[m] = () => c;
  }
  c.then = (resolve: (v: unknown) => void) => resolve(rows);
  return c;
};

let dbRows: unknown[] = [];
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: {},
  requirePlanetscaleDb: () => chain(dbRows),
}));
jest.mock("@/lib/db/planetscale/schema", () => ({
  devices: {},
  points: {},
  derivedIntervals: {
    derivationId: "di.derivation_id",
    startTime: "di.start",
    endTime: "di.end",
  },
  derivedIntervalProvenance: {},
}));

const requireDashboardAccess = jest.fn<() => Promise<unknown>>();
jest.mock("@/lib/api-auth", () => ({
  requireDashboardAccess: () => requireDashboardAccess(),
}));
jest.mock("@/lib/dashboard/subject", () => ({
  subjectDisplayTimezone: () => "Australia/Melbourne",
}));

const memberDevices = jest.fn<() => Promise<{ deviceId: string }[]>>();
jest.mock("@/lib/capabilities/server", () => ({
  memberDevices: () => memberDevices(),
}));

const getRunDetectorForDevices = jest.fn<() => Promise<unknown>>();
jest.mock("@/lib/derivations/resolve", () => ({
  getRunDetectorForDevices: () => getRunDetectorForDevices(),
}));

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: async () => ({ areaId: null }),
    areaByHandle: async () => null,
  },
}));
jest.mock("@/lib/ids", () => ({
  Device: { toUuid: (x: string) => x },
  Point: { toUuid: (x: string) => x },
}));

import { GET } from "../[systemId]/run-periods/route";

const call = (qs: string) =>
  GET(
    new NextRequest(
      `https://www.liveone.energy/api/device/13/run-periods?${qs}`,
    ),
    { params: Promise.resolve({ systemId: "13" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  // `readSignalMeta` warns when the signal point has no `points` row — which is exactly what the
  // empty db stub presents. That degradation is deliberate (warn, omit the column, never 500), so
  // the warning is expected here and silenced rather than left as CI noise.
  jest.spyOn(console, "warn").mockImplementation(() => {});
  dbRows = [];
  requireDashboardAccess.mockResolvedValue({ subject: { kind: "device" } });
  memberDevices.mockResolvedValue([{ deviceId: "dv_1" }]);
});

describe("GET run-periods — tracked vs empty", () => {
  it("reports tracked:false when no detector resolves for the role", async () => {
    getRunDetectorForDevices.mockResolvedValue(null);
    const body = await (await call("role=ev&period=7d")).json();
    expect(body.tracked).toBe(false);
    expect(body.events).toEqual([]);
  });

  it("reports tracked:true when a detector exists but produced nothing", async () => {
    getRunDetectorForDevices.mockResolvedValue({
      id: "dx_1",
      signalPoint: "pt_1",
      energyPoint: null,
    });
    const body = await (await call("role=ev&period=7d")).json();
    expect(body.tracked).toBe(true);
    expect(body.events).toEqual([]);
  });

  it("🛑 the two states are distinguishable — the whole point of the field", async () => {
    getRunDetectorForDevices.mockResolvedValue(null);
    const untracked = await (await call("role=ev&period=7d")).json();
    getRunDetectorForDevices.mockResolvedValue({
      id: "dx_1",
      signalPoint: "pt_1",
      energyPoint: null,
    });
    const empty = await (await call("role=ev&period=7d")).json();

    expect(untracked.events).toEqual(empty.events); // identical under the old contract…
    expect(untracked.tracked).not.toBe(empty.tracked); // …and told apart under the new one.
  });

  it("carries tracked in paged mode too", async () => {
    getRunDetectorForDevices.mockResolvedValue(null);
    const body = await (await call("role=generator&limit=10")).json();
    expect(body.tracked).toBe(false);
    expect(body.hasMore).toBe(false);
  });
});
