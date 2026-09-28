/**
 * `ReadingsDao.readRawExportPage` — the evidence export behind `GET /api/v4/devices/{id}/readings`.
 *
 * What is load-bearing: the SQL bounds (device's points, half-open measurement window, ingestion
 * cutoff, keyset cursor on BOTH halves of the key), the µs-exact `to_char` rendering of all three
 * timestamps, a database-minted `asOf`, and a cursor that keeps the integer rid off the wire.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { Device, Point } from "@/lib/ids";
import { InvalidRawExportCursor, ReadingsDao } from "../dao";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry", () => ({ RegistryCache: {} }));

const DEVICE_UUID = "0192f0ab-0000-7000-8000-000000000001";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const device = Device.encode(DEVICE_UUID);
const dialect = new PgDialect();
const US = /^'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'$/;

interface Captured {
  pointsWhere?: unknown;
  readingsSelection?: Record<string, unknown>;
  readingsWhere?: unknown;
  orderBy?: unknown[];
  limit?: number;
  executed: unknown[];
}

function fakeExec(readingRows: Record<string, unknown>[], cap: Captured) {
  return {
    execute: async (q: unknown) => {
      cap.executed.push(q);
      return { rows: [{ asOf: "2026-09-28T01:02:03.456789Z" }] };
    },
    select: (fields: Record<string, unknown>) => ({
      from: () =>
        "pointRid" in fields
          ? {
              where: (w: unknown) => {
                cap.readingsSelection = fields;
                cap.readingsWhere = w;
                return {
                  orderBy: (...o: unknown[]) => {
                    cap.orderBy = o;
                    return {
                      limit: async (n: number) => {
                        cap.limit = n;
                        return readingRows;
                      },
                    };
                  },
                };
              },
            }
          : {
              where: async (w: unknown) => {
                cap.pointsWhere = w;
                return [
                  { id: P1, rid: 41 },
                  { id: P2, rid: 42 },
                ];
              },
            },
    }),
  };
}

const row = (rid: number, t: string) => ({
  pointRid: rid,
  sessionId: "s1",
  measurementTime: t,
  receivedTime: t,
  createdAt: t,
  value: 1.5,
  valueStr: null,
  error: null,
  dataQuality: "good",
});

let cap: Captured;
beforeEach(() => {
  cap = { executed: [] };
});

describe("readRawExportPage", () => {
  const window = {
    since: "2026-09-17T09:21:00.000Z",
    until: "2026-09-17T10:02:00.000Z",
    limit: 2,
  };

  it("mints asOf from the DATABASE clock on the first page and bounds the SQL", async () => {
    const page = await ReadingsDao.readRawExportPage(
      device,
      window,
      fakeExec([], cap) as never,
    );
    expect(page.asOf).toBe("2026-09-28T01:02:03.456789Z");
    expect(cap.executed).toHaveLength(1);
    const clock = dialect.sqlToQuery(cap.executed[0] as never).sql;
    expect(clock).toContain("now() AT TIME ZONE 'UTC'");
    expect(clock).toContain('HH24:MI:SS.US"Z"');

    expect(dialect.sqlToQuery(cap.pointsWhere as never).params).toEqual([
      DEVICE_UUID,
    ]);
    const q = dialect.sqlToQuery(cap.readingsWhere as never);
    expect(q.sql).toContain('"point_rid" in');
    expect(q.sql).toContain('"measurement_time" >=');
    expect(q.sql).toContain('"measurement_time" <');
    expect(q.sql).toContain('"created_at" <=');
    expect(q.params).toEqual([
      41,
      42,
      window.since,
      window.until,
      "2026-09-28T01:02:03.456789Z",
    ]);
    expect(cap.limit).toBe(3);
    expect(cap.orderBy).toHaveLength(2);
  });

  it("renders all three timestamps with to_char .US — drizzle's Date would truncate to ms", async () => {
    await ReadingsDao.readRawExportPage(
      device,
      window,
      fakeExec([], cap) as never,
    );
    for (const k of ["measurementTime", "receivedTime", "createdAt"]) {
      const q = dialect.sqlToQuery(cap.readingsSelection![k] as never);
      expect(q.sql).toMatch(/^to_char\(/);
      expect(q.sql.split(", ")[1].replace(/\)$/, "")).toMatch(US);
    }
  });

  it("echoes a supplied asOf without reading the clock, and pages with an opaque two-part cursor", async () => {
    const t1 = "2026-09-17T09:21:00.123456Z";
    const t2 = "2026-09-17T09:21:05.000001Z";
    const page = await ReadingsDao.readRawExportPage(
      device,
      { ...window, asOf: "2026-09-28T00:00:00.000000Z" },
      fakeExec([row(41, t1), row(42, t1), row(41, t2)], cap) as never,
    );
    expect(cap.executed).toHaveLength(0);
    expect(page.readings).toHaveLength(2);
    expect(page.readings[1]).toEqual({
      pointId: Point.encode(P2),
      sessionId: "s1",
      measurementTime: t1,
      receivedTime: t1,
      createdAt: t1,
      value: 1.5,
      valueStr: null,
      error: null,
      dataQuality: "good",
    });
    expect(page.readings[0]).not.toHaveProperty("pointRid");
    expect(page.nextCursor).toBeTruthy();
    // Opaque: not a timestamp, not a number.
    expect(page.nextCursor).not.toContain(t1);

    cap = { executed: [] };
    await ReadingsDao.readRawExportPage(
      device,
      {
        ...window,
        asOf: "2026-09-28T00:00:00.000000Z",
        cursor: page.nextCursor!,
      },
      fakeExec([], cap) as never,
    );
    const q = dialect.sqlToQuery(cap.readingsWhere as never);
    expect(q.sql).toMatch(
      /\("point_readings"\."measurement_time", "point_readings"\."point_rid"\) > \(\$\d+::timestamp, \$\d+\)/,
    );
    expect(q.params.slice(-3)).toEqual([t1, t1, 42]);
  });

  it("returns a null cursor on the last page", async () => {
    const page = await ReadingsDao.readRawExportPage(
      device,
      window,
      fakeExec([row(41, "2026-09-17T09:21:00.000000Z")], cap) as never,
    );
    expect(page.nextCursor).toBeNull();
  });

  it("narrows to pointIds and skips the readings query when none are the device's", async () => {
    await ReadingsDao.readRawExportPage(
      device,
      { ...window, pointIds: [Point.encode(P2)] },
      fakeExec([], cap) as never,
    );
    expect(dialect.sqlToQuery(cap.readingsWhere as never).params[0]).toBe(42);

    cap = { executed: [] };
    const page = await ReadingsDao.readRawExportPage(
      device,
      {
        ...window,
        pointIds: [Point.encode("33333333-3333-4333-8333-333333333333")],
      },
      fakeExec([], cap) as never,
    );
    expect(page.readings).toEqual([]);
    expect(cap.readingsWhere).toBeUndefined();
  });

  it.each([
    ["garbage", { cursor: "not-a-cursor" }],
    [
      "a ms-precision timestamp",
      {
        cursor: Buffer.from(
          JSON.stringify(["2026-09-17T09:21:00.123Z", 41]),
        ).toString("base64url"),
      },
    ],
    [
      "a non-integer rid",
      {
        cursor: Buffer.from(
          JSON.stringify(["2026-09-17T09:21:00.123456Z", "41"]),
        ).toString("base64url"),
      },
    ],
    ["a malformed asOf", { asOf: "2026-09-28T00:00:00Z" }],
  ])("refuses %s before querying", async (_label, extra) => {
    await expect(
      ReadingsDao.readRawExportPage(
        device,
        { ...window, ...extra },
        fakeExec([], cap) as never,
      ),
    ).rejects.toBeInstanceOf(InvalidRawExportCursor);
    expect(cap.readingsWhere).toBeUndefined();
  });
});
