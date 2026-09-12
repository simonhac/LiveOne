import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { collectorApi, adminPollers } from "../api";
import { settingsSchema, statusSchema, validateSettings } from "../contracts";
import { requireAdmin } from "@/lib/api-auth";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { planetscaleDb } from "@/lib/db/planetscale";

jest.mock("@/lib/api-auth", () => ({ requireAdmin: jest.fn() }));
jest.mock("@/lib/secure-credentials", () => ({
  getDeviceCredentials: jest.fn(),
}));
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: {
    select: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(),
  },
}));
const db = planetscaleDb!;
const collectorId = "11111111-1111-4111-8111-111111111111";
const pollerId = "22222222-2222-4222-8222-222222222222";
const token = `lo_col_${collectorId}_${"a".repeat(64)}`;
const collector = {
  id: collectorId,
  disabled: false,
  tokenHash: createHash("sha256").update(token).digest("hex"),
  destination: "https://receiver.example/capture",
};
const p = {
  id: pollerId,
  collectorId,
  source: "selectronic",
  deviceId: "33333333-3333-4333-8333-333333333333",
  revision: 2,
  appliedRevision: 1,
  deleted: false,
};
function queued(...rows: unknown[][]) {
  for (const data of rows) {
    const result = Object.assign(Promise.resolve(data), {
      for: () => Promise.resolve(data),
    });
    (db.select as jest.Mock).mockReturnValueOnce({
      from: () => ({ where: () => result }),
    });
  }
}
function req(method: string, op: string, body?: unknown, bearer = token) {
  return new NextRequest(`https://liveone.test/api/collectors/me/${op}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  (db.transaction as jest.Mock).mockImplementation(async (fn: unknown) =>
    (fn as (db: unknown) => unknown)(db),
  );
});
describe("collector authorization and revisions", () => {
  it("refuses missing/invalid collector tokens before any DB read", async () => {
    const r = await collectorApi(
      req("GET", "config", undefined, "invalid"),
      "config",
    );
    expect(r.status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });
  it("refuses a disabled collector", async () => {
    queued([{ ...collector, disabled: true }]);
    expect((await collectorApi(req("GET", "config"), "config")).status).toBe(
      401,
    );
  });
  it("exports only vendor credentials, never production ingestion keys", async () => {
    queued(
      [collector],
      [p],
      [{ id: p.deviceId, ownerUserId: "owner", rid: 1 }],
    );
    jest.mocked(getDeviceCredentials).mockResolvedValue({
      systemId: 1,
      vendorType: "selectronic",
      created_at: "",
      email: "user",
      password: "vendor-password",
      apiKey: "PRODUCTION",
      accessToken: "PRODUCTION",
    });
    const r = await collectorApi(
      req("GET", `credentials?pollerId=${pollerId}`),
      "credentials",
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      revision: 2,
      credentials: { email: "user", password: "vendor-password" },
    });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("cannot fetch another collector's credentials", async () => {
    queued([collector], []);
    expect(
      (
        await collectorApi(
          req("GET", `credentials?pollerId=${pollerId}`),
          "credentials",
        )
      ).status,
    ).toBe(404);
    expect(getDeviceCredentials).not.toHaveBeenCalled();
  });
  it("does not acknowledge a future revision", async () => {
    queued([collector], [p]);
    const r = await collectorApi(
      req("POST", "status", {
        pollers: [
          {
            id: pollerId,
            appliedRevision: 3,
            stopped: false,
            supervising: false,
          },
        ],
      }),
      "status",
    );
    expect(r.status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
  });
  it("cannot acknowledge deletion while generator supervision is armed", async () => {
    queued([collector], [{ ...p, deleted: true }]);
    const r = await collectorApi(
      req("POST", "status", {
        pollers: [
          {
            id: pollerId,
            appliedRevision: 2,
            stopped: true,
            supervising: true,
          },
        ],
      }),
      "status",
    );
    expect(r.status).toBe(409);
  });
  it("requires admin authentication for poller management", async () => {
    jest
      .mocked(requireAdmin)
      .mockResolvedValue(
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      );
    expect((await adminPollers(req("GET", "config"))).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
describe("managed configuration validation", () => {
  it("rejects secrets and device-control options in managed settings", () => {
    expect(
      settingsSchema.safeParse({ pollMs: 1000, pushMs: 1000, apiKey: "secret" })
        .success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        pollMs: 1000,
        pushMs: 1000,
        control: { enabled: true },
      }).success,
    ).toBe(false);
  });
  it("enforces cloud budgets and Fronius sampling cadence", () => {
    expect(() =>
      validateSettings("sigenergy", {
        pollMs: 60000,
        pushMs: 60000,
        region: "aus",
      }),
    ).toThrow();
    expect(() =>
      validateSettings("fronius", {
        pollMs: 2000,
        pushMs: 60000,
        inverters: [{ host: "master", master: true, battery: true }],
      }),
    ).not.toThrow();
  });
  it("rejects arbitrary vendor error text in persisted health", () => {
    expect(
      statusSchema.safeParse({
        id: pollerId,
        appliedRevision: 1,
        stopped: false,
        supervising: false,
        error: "password=secret",
      }).success,
    ).toBe(false);
  });
});

it("does not transfer a device to a different trial destination", async () => {
  jest.mocked(requireAdmin).mockResolvedValue({ userId: "admin" } as never);
  const oldCollectorId = "44444444-4444-4444-8444-444444444444";
  queued(
    [{ id: p.deviceId, vendor: "selectronic", vendorSiteId: "site" }],
    [
      {
        ...collector,
        destination: "https://different-receiver.example/capture",
      },
    ],
    [
      {
        ...p,
        collectorId: oldCollectorId,
        deleted: true,
        appliedRevision: 2,
        status: { stopped: true, supervising: false },
      },
    ],
    [{ id: oldCollectorId, destination: collector.destination }],
  );
  (db.insert as jest.Mock).mockReturnValue({
    values: () => ({ returning: async () => [{ id: pollerId }] }),
  });
  const request = new NextRequest("https://liveone.test/api/admin/pollers", {
    method: "POST",
    body: JSON.stringify({
      collectorId,
      deviceId: p.deviceId,
      source: "selectronic",
      settings: { pollMs: 60000, pushMs: 60000 },
    }),
  });
  const result = await adminPollers(request);
  expect(result.status).toBe(409);
  expect(db.insert).not.toHaveBeenCalled();
});

it("exports only scoped measured cloud read evidence", async () => {
  process.env.LIVEONE_TRIAL_READ_EVIDENCE = "1";
  process.env.LIVEONE_TRIAL_READ_EVIDENCE_SINCE = "2026-01-01T00:00:00Z";
  queued([collector], [{ ...p, vendorSiteId: "site" }], [{ rid: 7 }]);
  (db.select as jest.Mock).mockReturnValueOnce({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () =>
            Promise.resolve([
              {
                at: new Date("2026-01-02T00:01:00Z"),
                response: {
                  gousherTrialRead: {
                    version: 1,
                    source: "selectronic",
                    durationMs: 42,
                    ok: true,
                  },
                },
              },
            ]),
        }),
      }),
    }),
  });
  const response = await collectorApi(
    req(
      "GET",
      `production?pollerId=${pollerId}&revision=2&kind=window&start=2026-01-02T00:00:00Z&end=2026-01-02T00:15:00Z`,
    ),
    "production",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    role: "production",
    siteId: "site",
    windowEnd: "2026-01-02T00:15:00.000Z",
    metrics: { samples: 1, failureRate: 0, p95ReadMs: 42 },
  });
  delete process.env.LIVEONE_TRIAL_READ_EVIDENCE;
  delete process.env.LIVEONE_TRIAL_READ_EVIDENCE_SINCE;
});
