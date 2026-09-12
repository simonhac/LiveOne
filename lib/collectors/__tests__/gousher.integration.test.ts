import { ReadingsDao } from "@/lib/readings/dao";
import { Point } from "@/lib/ids";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  devices,
  legacyHandles,
  observationsOutbox,
  points,
  users,
} from "@/lib/db/planetscale/schema";
import { POST } from "@/app/api/gush/route";
import { adminCollectors, adminPollers, collectorApi } from "../api";

// External services only are substituted. Gusher, registries, point minting,
// poll collection and durable outbox use the real PostgreSQL implementations.
jest.mock("react", () => ({
  ...jest.requireActual<object>("react"),
  cache: (fn: unknown) => fn,
}));
jest.mock("@/lib/api-auth", () => ({
  requireAdmin: async () => ({ userId: "gousher-integration" }),
}));
jest.mock("@/lib/secure-credentials", () => ({
  getDeviceCredentials: async () => ({ apiKey: "local-integration-key" }),
}));
jest.mock("@/lib/qstash", () => ({
  qstash: {},
  getObservationsReceiverUrl: () => "http://127.0.0.1/unused",
}));
jest.mock("@/lib/observations/publish", () => ({
  publishObservationMessage: async () => {},
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  isServingRebuildPending: () => false,
  refreshServingForMintedPoints: async () => {},
  updateLatestPointValue: async () => {},
}));

const privateUrl = process.env.GOUSHER_TEST_DATABASE_URL;
if (
  !privateUrl ||
  process.env.PLANETSCALE_DATABASE_URL !== privateUrl ||
  new URL(privateUrl).hostname !== "127.0.0.1" ||
  !new URL(privateUrl).pathname.startsWith("/gousher_test") ||
  !process.env.GOUSHER_REPLAY_DIR
) {
  throw new Error(
    "This suite requires tools/integration.sh and its disposable database",
  );
}
const db = planetscaleDb!;
const deviceIds = new Map<string, string>();
const owner = "gousher-integration";
const vendors = ["deepsea", "fronius", "selectronic", "sigenergy"];
function request(path: string, method: string, body?: unknown, token?: string) {
  return new NextRequest(`http://127.0.0.1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeAll(async () => {
  await db.insert(users).values({ clerkUserId: owner });
  for (const [index, vendor] of vendors.entries()) {
    const areaId = randomUUID(),
      id = randomUUID(),
      rid = 100 + index;
    await db.insert(areas).values({
      id: areaId,
      ownerUserId: owner,
      name: vendor,
      timezoneOffsetMin: 0,
      displayTimezone: "UTC",
      dayOffsetMin: 0,
    });
    await db.insert(devices).values({
      id,
      rid,
      ownerUserId: owner,
      vendor: vendor === "fronius" ? "fusher" : vendor,
      vendorSiteId: vendor,
      name: vendor,
      primaryAreaId: areaId,
    });
    await db.insert(legacyHandles).values({ handle: rid, deviceId: id });
    deviceIds.set(vendor, id);
  }
});
afterAll(async () => {
  await global.__planetscalePool?.end();
});

describe("computed Go batches through the real gusher and PostgreSQL outbox", () => {
  it.each(vendors)(
    "accepts %s identities, timestamps and metadata",
    async (vendor) => {
      const batches = readFileSync(
        join(process.env.GOUSHER_REPLAY_DIR!, `${vendor}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const batch = batches[0];
      expect(batch.readings.length).toBeGreaterThan(0);
      const response = await POST(
        request("/api/gush", "POST", {
          ...batch,
          apiKey: "local-integration-key",
        }),
      );
      expect({
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        status: 200,
        body: { success: true, pointsStored: batch.readings.length },
      });
      const minted = await db
        .select()
        .from(points)
        .where(eq(points.deviceId, deviceIds.get(vendor)!));
      expect(minted.length).toBe(batch.readings.length);
      const rows = await db
        .select()
        .from(observationsOutbox)
        .where(eq(observationsOutbox.deviceRid, 100 + vendors.indexOf(vendor)));
      expect(rows.length).toBeGreaterThan(0);
      const payload = rows[rows.length - 1].payload as {
        observations: { measurementTime: string }[];
      };
      expect(payload.observations.length).toBe(batch.readings.length);
      for (const observation of payload.observations)
        expect(Date.parse(observation.measurementTime)).toBe(
          Date.parse(batch.measurementTime),
        );
      for (const reading of batch.readings) {
        const point = minted.find(
          (p) => p.physicalPath === reading.physicalPathTail,
        );
        expect(point).toMatchObject({
          metricType: reading.metricType,
          unit: reading.metricUnit,
        });
      }
      expect(JSON.stringify(payload)).not.toContain("local-integration-key");
    },
  );
});

it("persists managed CRUD and rejects a stale revision against PostgreSQL", async () => {
  const enrollment = await adminCollectors(
    request("/api/admin/collectors", "POST", {
      name: "integration",
      destination: "https://receiver.example/capture",
    }),
  );
  expect(enrollment.status).toBe(201);
  const enrolled = await enrollment.json();
  const creation = await adminPollers(
    request("/api/admin/pollers", "POST", {
      collectorId: enrolled.id,
      deviceId: deviceIds.get("deepsea"),
      source: "deepsea",
      settings: {
        host: "master",
        port: 502,
        unitId: 10,
        pollMs: 1000,
        pushMs: 60000,
      },
    }),
  );
  expect({
    status: creation.status,
    body: await creation.clone().json(),
  }).toMatchObject({ status: 201 });
  const poller = await creation.json();
  const config = await collectorApi(
    request("/api/collectors/me/config", "GET", undefined, enrolled.token),
    "config",
  );
  expect(config.status).toBe(200);
  expect((await config.json()).pollers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: poller.id, paused: true, revision: 1 }),
    ]),
  );
  const updated = await adminPollers(
    request(`/api/admin/pollers/${poller.id}`, "PATCH", {
      revision: 1,
      paused: false,
    }),
    poller.id,
  );
  expect(updated.status).toBe(200);
  const stale = await adminPollers(
    request(`/api/admin/pollers/${poller.id}`, "PATCH", {
      revision: 1,
      paused: true,
    }),
    poller.id,
  );
  expect(stale.status).toBe(409);
});

it("exports real raw pages with assignment isolation and a fixed ingestion cutoff", async () => {
  const enrollment = await adminCollectors(
    request("/api/admin/collectors", "POST", {
      name: "reference-integration",
      destination: "https://receiver.example/capture",
    }),
  );
  expect(enrollment.status).toBe(201);
  const enrolled = await enrollment.json();
  const creation = await adminPollers(
    request("/api/admin/pollers", "POST", {
      collectorId: enrolled.id,
      deviceId: deviceIds.get("fronius"),
      source: "fronius",
      settings: {
        pollMs: 2000,
        pushMs: 60000,
        inverters: [{ host: "master", master: true, battery: true }],
      },
    }),
  );
  expect(creation.status).toBe(201);
  const poller = await creation.json();
  const [point] = await db
    .select()
    .from(points)
    .where(eq(points.deviceId, deviceIds.get("fronius")!));
  const start = Date.parse("2026-01-01T00:00:00Z");
  await ReadingsDao.insertRaw(
    [0, 1, 2, 3].map((n) => ({
      point: Point.encode(point.id),
      measurementTimeMs: start + n,
      receivedTimeMs: start + n,
      value: n === 1 ? null : n,
      valueStr: null,
      sessionId: null,
    })),
  );
  // Ensure the millisecond cutoff is later than PostgreSQL's microsecond insertion time.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const query = new URLSearchParams({
    pollerId: poller.id,
    revision: "1",
    pointId: point.id,
    start: new Date(start).toISOString(),
    end: new Date(start + 3).toISOString(),
    asOf: new Date().toISOString(),
    limit: "2",
  });
  const read = () =>
    collectorApi(
      request(
        `/api/collectors/me/readings?${query}`,
        "GET",
        undefined,
        enrolled.token,
      ),
      "readings",
    );
  const first = await read();
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.readings.map((r: { value: number | null }) => r.value)).toEqual([
    0,
    null,
  ]);
  expect(page.nextCursor).toBe("2026-01-01T00:00:00.001000Z");
  query.set("cursor", page.nextCursor);
  const second = await read();
  const last = await second.json();
  expect(last.readings.map((r: { value: number }) => r.value)).toEqual([2]);
  expect(last.nextCursor).toBeNull();
  query.delete("cursor");
  query.set("asOf", "2026-01-01T01:00:00Z");
  expect((await (await read()).json()).readings).toEqual([]);
  const [otherPoint] = await db
    .select()
    .from(points)
    .where(eq(points.deviceId, deviceIds.get("deepsea")!));
  query.set("pointId", otherPoint.id);
  expect((await read()).status).toBe(404);
});
