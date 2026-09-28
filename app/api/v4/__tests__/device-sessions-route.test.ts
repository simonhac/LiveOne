/**
 * ROUTE-level tests for `GET /api/v4/devices/{id}/sessions`.
 *
 * Two modes: the windowless newest-first list (capped at 200), and the windowed evidence read
 * (oldest first, keyset-paged, up to 5000 a page). Pinned here: the `cause` filter is in SQL — it
 * used to be applied in JS AFTER the LIMIT, so a cause absent from the newest N returned nothing —
 * `failed=true`, the µs `createdAt`, the per-row outcome fields, and the 400 boundaries.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { Device } from "@/lib/ids";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));

interface Cap {
  selection?: Record<string, unknown>;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}
const cap: Cap = {};
let pageRows: Record<string, unknown>[] = [];

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(() => ({
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: (w: unknown) =>
          "numRows" in fields
            ? ((cap.selection = fields),
              (cap.where = w),
              {
                orderBy: (...o: unknown[]) => {
                  cap.orderBy = o;
                  return {
                    limit: async (n: number) => {
                      cap.limit = n;
                      return pageRows;
                    },
                  };
                },
              })
            : { limit: async () => [{ rid: 1 }] },
      }),
    }),
  })),
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { GET } from "../devices/[id]/sessions/route";

const id = Device.encode("0192f0ab-0000-7000-8000-000000000001");
const call = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/v4/devices/${id}/sessions${qs}`), {
    params: Promise.resolve({ id }),
  });
const dialect = new PgDialect();
const whereSql = () => dialect.sqlToQuery(cap.where as never);
const W = "?since=2026-09-17T09:19:00Z&until=2026-09-17T10:04:00Z";
const session = (id: string, createdAt: string) => ({
  id,
  label: null,
  cause: "POLL",
  successful: false,
  duration: 1234,
  errorCode: "ETIMEDOUT",
  error: "timed out",
  numRows: 0,
  createdAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(cap)) delete cap[k as keyof Cap];
  pageRows = [];
  jest.mocked(requireDeviceAccess).mockResolvedValue({} as never);
});

describe("authorization", () => {
  it("calls the read gate with the device rid and returns its refusal", async () => {
    jest
      .mocked(requireDeviceAccess)
      .mockResolvedValueOnce(
        NextResponse.json({ error: "no" }, { status: 403 }) as never,
      );
    expect((await call()).status).toBe(403);
    expect(requireDeviceAccess).toHaveBeenCalledWith(expect.anything(), 1);
    expect(cap.where).toBeUndefined();
  });
});

describe("windowless", () => {
  it("is newest-first, default 20, capped at 200, and has no cursor", async () => {
    const body = await (await call()).json();
    expect(cap.limit).toBe(20);
    expect(cap.orderBy).toHaveLength(1);
    expect(body).not.toHaveProperty("nextCursor");
    await call("?limit=5000");
    expect(cap.limit).toBe(200);
    await call("?limit=5");
    expect(cap.limit).toBe(5);
  });

  it("filters cause and failed IN SQL, not after the limit", async () => {
    await call("?cause=ADMIN&failed=true");
    const q = whereSql();
    expect(q.sql).toContain('"sessions"."cause" =');
    expect(q.sql).toContain('"sessions"."successful" =');
    expect(q.params).toEqual([1, "ADMIN", false]);
  });

  it("selects createdAt via to_char .US and the outcome fields, never the manifest", async () => {
    await call();
    const created = dialect.sqlToQuery(cap.selection!.createdAt as never).sql;
    expect(created).toContain("to_char(");
    expect(created).toContain('HH24:MI:SS.US"Z"');
    for (const k of ["duration", "errorCode", "error", "successful"])
      expect(cap.selection).toHaveProperty(k);
    expect(cap.selection).not.toHaveProperty("response");
    expect(cap.selection).not.toHaveProperty("manifest");
  });

  it("refuses a cursor without a window", async () => {
    expect((await call("?cursor=abc")).status).toBe(400);
  });
});

describe("windowed", () => {
  it.each([
    ["since alone", "?since=2026-09-17T09:00:00Z"],
    ["until alone", "?until=2026-09-17T09:00:00Z"],
    ["garbage", "?since=x&until=2026-09-17T09:00:00Z"],
    [
      "an inverted window",
      "?since=2026-09-17T10:00:00Z&until=2026-09-17T09:00:00Z",
    ],
    ["over 31 days", "?since=2026-08-01T00:00:00Z&until=2026-09-17T00:00:00Z"],
    ["a forged cursor", `${W}&cursor=abc`],
  ])("400s on %s", async (_l, qs) => {
    expect((await call(qs)).status).toBe(400);
    expect(cap.where).toBeUndefined();
  });

  it("bounds created_at half-open, orders oldest-first on (created_at, id), pages of 5000", async () => {
    const res = await call(W);
    expect(res.status).toBe(200);
    const q = whereSql();
    expect(q.sql).toContain('"sessions"."created_at" >=');
    expect(q.sql).toContain('"sessions"."created_at" <');
    expect(q.params).toEqual([
      1,
      "2026-09-17T09:19:00.000Z",
      "2026-09-17T10:04:00.000Z",
    ]);
    expect(cap.orderBy).toHaveLength(2);
    expect(cap.limit).toBe(5001);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.window).toEqual({
      since: "2026-09-17T09:19:00.000Z",
      until: "2026-09-17T10:04:00.000Z",
    });
  });

  it("returns an opaque keyset cursor that the next page turns into a row comparison", async () => {
    const t = "2026-09-17T09:20:00.123456Z";
    pageRows = [session("a", t), session("b", t)];
    const body = await (await call(`${W}&limit=1`)).json();
    expect(body.sessions).toEqual([session("a", t)]);
    expect(body.nextCursor).toBeTruthy();
    expect(body.nextCursor).not.toContain(t);

    pageRows = [];
    await call(`${W}&cursor=${body.nextCursor}`);
    const q = whereSql();
    expect(q.sql).toMatch(
      /\("sessions"\."created_at", "sessions"\."id"\) > \(\$\d+::timestamp, \$\d+\)/,
    );
    expect(q.params.slice(-2)).toEqual([t, "a"]);
  });
});
