/**
 * ROUTE-level tests for `GET /api/v4/points/{pt_}/commands` — the device's command audit trail.
 *
 * Pinned: the owner-only gate, the optional `requested_at` window (half-open, each edge
 * independent, 400 on a malformed or inverted one), and the per-row `physicalPath`.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { Point } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/automations/store", () => ({ getByIds: async () => [] }));
jest.mock("@/lib/control/point-actions", () => ({
  loadPointByUuid: jest.fn(async () => ({
    point: { deviceId: "0192f0ab-0000-7000-8000-000000000014" },
    deviceRid: 14,
  })),
}));

const cap: { where?: unknown } = {};
const P = "11111111-1111-4111-8111-111111111111";
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (w: unknown) => {
            cap.where = w;
            return {
              orderBy: () => ({
                limit: () => ({
                  offset: async () => [
                    {
                      command: {
                        pointId: "11111111-1111-4111-8111-111111111111",
                        action: "set_value",
                        value: 0,
                        status: "succeeded",
                        vendorResult: null,
                        error: null,
                        requestedBy: "user_abc",
                        requestedAt: new Date("2026-09-17T09:30:00Z"),
                        completedAt: null,
                      },
                      point: {
                        physicalPath: "generator/control",
                        logicalPath: "generator",
                        metricType: "run",
                      },
                    },
                  ],
                }),
              }),
            };
          },
        }),
      }),
    }),
  }),
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { GET } from "../points/[id]/commands/route";

const id = Point.encode(P);
const call = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/v4/points/${id}/commands${qs}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  delete cap.where;
  jest.mocked(requireDeviceAccess).mockResolvedValue({} as never);
});

it("gates on OWNERSHIP of the point's device", async () => {
  jest
    .mocked(requireDeviceAccess)
    .mockResolvedValueOnce(
      NextResponse.json({ error: "no" }, { status: 403 }) as never,
    );
  expect((await call()).status).toBe(403);
  expect(requireDeviceAccess).toHaveBeenCalledWith(expect.anything(), 14, {
    requireOwner: true,
  });
});

it("serves physicalPath per row, and no clerk id", async () => {
  const body = await (await call()).json();
  expect(body.commands[0]).toMatchObject({
    pointId: id,
    physicalPath: "generator/control",
    logicalPath: "generator",
    requestedBy: { kind: "user" },
  });
  expect(JSON.stringify(body)).not.toContain("user_abc");
});

it("windows requested_at half-open, each edge optional", async () => {
  await call();
  expect(new PgDialect().sqlToQuery(cap.where as never).sql).not.toContain(
    "requested_at",
  );
  await call("?since=2026-09-17T09:00:00Z&until=2026-09-17T11:00:00Z");
  const q = new PgDialect().sqlToQuery(cap.where as never);
  expect(q.sql).toContain('"point_commands"."requested_at" >=');
  expect(q.sql).toContain('"point_commands"."requested_at" <');
  await call("?until=2026-09-17T11:00:00Z");
  expect(new PgDialect().sqlToQuery(cap.where as never).sql).not.toContain(
    ">=",
  );
});

it.each([
  ["a malformed since", "?since=yesterday"],
  [
    "an inverted window",
    "?since=2026-09-17T11:00:00Z&until=2026-09-17T09:00:00Z",
  ],
])("400s on %s", async (_l, qs) => {
  expect((await call(qs)).status).toBe(400);
  expect(cap.where).toBeUndefined();
});
