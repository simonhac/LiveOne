import { describe, it, expect, beforeEach } from "@jest/globals";
import { Device, Point, type DeviceId, type PointId } from "@/lib/ids";
import type { DeviceAddr, PointAddr } from "@/lib/registry";

// Control point→address resolution: the DAO's SEAM. Tests populate `addrMap`.
const addrMap = new Map<PointId, PointAddr>();
const deviceById = new Map<DeviceId, DeviceAddr>();
const deviceByHandle = new Map<number, DeviceAddr>();
jest.mock("@/lib/registry", () => ({
  RegistryCache: {
    // rid-keyed seam: the flipped DAO resolves PointId → point_rid (from addrMap's `.rid`).
    ridsForPoints: async (ids: PointId[]) =>
      new Map(ids.map((id) => [id, addrMap.get(id)!.rid])),
    ridForPoint: async (id: PointId) => addrMap.get(id)!.rid,
    // Still used by readAdminPivot (needs both `.rid` and `.systemId` for the on-device check).
    addrsForPoints: async (ids: PointId[]) =>
      new Map(ids.map((id) => [id, addrMap.get(id)!])),
  },
  DeviceRegistry: {
    addrsForDevices: async (ids: DeviceId[]) =>
      new Map(ids.map((id) => [id, deviceById.get(id)!])),
    // The `db`/`exec` 2nd arg is ignored by the mock.
    addrForDevice: async (id: DeviceId) => deviceById.get(id)!,
  },
}));
// The DAO falls back to requirePlanetscaleDb() only when no `exec` is passed; every test passes a fake.
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    throw new Error("no exec passed");
  },
}));

import { lt, lte } from "drizzle-orm";
import { ReadingsDao, upperBoundOp } from "../dao";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "../schema-internal";

function tableName(t: unknown): string {
  if (t === pointReadings) return "point_readings";
  if (t === pointReadingsAgg5m) return "point_readings_agg_5m";
  if (t === pointReadingsAgg1d) return "point_readings_agg_1d";
  return "?";
}

/**
 * Fake exec: records inserts/deletes, the conflict mode, and the on-conflict SET keys.
 * `.select…().where().orderBy()` (and `.orderBy().limit()`), `.selectDistinct().where()`, and
 * `.delete().where().returning()` all resolve the canned `selectRows`.
 */
function makeFakeExec(selectRows: any[] = []) {
  const inserts: {
    table: string;
    rows: any[];
    mode: string;
    setKeys?: string[];
  }[] = [];
  const deletes: { table: string }[] = [];
  // A chainable, awaitable read result: awaiting resolves the canned `selectRows`, and `.orderBy`/
  // `.groupBy`/`.limit` each re-chain to the same — so `.where()`, `.where().orderBy()`,
  // `.where().groupBy()`, `.where().groupBy().orderBy()`, `.orderBy().limit()` all resolve `selectRows`.
  const result = (): any => {
    const p: any = Promise.resolve(selectRows);
    p.orderBy = result;
    p.groupBy = result;
    p.limit = result;
    return p;
  };
  const exec: any = {
    insert(table: unknown) {
      return {
        values(rows: any[]) {
          const rec: {
            table: string;
            rows: any[];
            mode: string;
            setKeys?: string[];
          } = { table: tableName(table), rows, mode: "" };
          const returning = () => Promise.resolve(rows.map(() => ({})));
          return {
            onConflictDoNothing() {
              rec.mode = "nothing";
              inserts.push(rec);
              return { returning };
            },
            onConflictDoUpdate(cfg: { set: Record<string, unknown> }) {
              rec.mode = "update";
              rec.setKeys = Object.keys(cfg.set);
              inserts.push(rec);
              return { returning };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          deletes.push({ table: tableName(table) });
          return { returning: () => Promise.resolve(selectRows) };
        },
      };
    },
    select() {
      // Device-keyed reads now `.from(hot).innerJoin(points, …).where()…` — `innerJoin` re-chains to
      // the same object so `.from().where()` and `.from().innerJoin().where()` both resolve `selectRows`.
      const chain: any = { where: result, orderBy: result };
      chain.innerJoin = () => chain;
      return { from: () => chain };
    },
    selectDistinct() {
      // deviceIdsWithAgg5mSince now `.selectDistinct().from(hot).innerJoin(points, …).where()`.
      const chain: any = { where: () => Promise.resolve(selectRows) };
      chain.innerJoin = () => chain;
      return { from: () => chain };
    },
    selectDistinctOn() {
      return {
        from() {
          return {
            where: () => ({ orderBy: () => Promise.resolve(selectRows) }),
          };
        },
      };
    },
    // Raw SQL path (the coverage COUNT-by-local-day methods) — resolves the canned rows.
    execute: () => Promise.resolve({ rows: selectRows }),
  };
  return { exec, inserts, deletes };
}

function point(rid: number, systemId: number, index: number) {
  const id = Point.generate();
  addrMap.set(id, {
    pointId: id,
    uuid: Point.toUuid(id),
    rid: rid as never,
    systemId,
    index,
  });
  return id;
}

function device(handle: number): DeviceId {
  const id = Device.generate();
  const addr: DeviceAddr = {
    deviceId: id,
    uuid: Device.toUuid(id),
    rid: handle as never,
    handle,
  };
  deviceById.set(id, addr);
  deviceByHandle.set(handle, addr);
  return id;
}

beforeEach(() => {
  addrMap.clear();
  deviceById.clear();
  deviceByHandle.clear();
});

describe("ReadingsDao writes — rid-keyed value-building", () => {
  it("insertRaw builds pointRid rows with Date times and first-write-wins", async () => {
    const p = point(11, 1, 3);
    const { exec, inserts } = makeFakeExec();
    const res = await ReadingsDao.insertRaw(
      [
        {
          point: p,
          measurementTimeMs: 1_700_000_000_000,
          receivedTimeMs: 1_700_000_001_000,
          value: 42,
          valueStr: null,
          sessionId: "s1",
        },
      ],
      exec,
    );
    expect(res).toEqual({ inserted: 1 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("point_readings");
    expect(inserts[0].mode).toBe("nothing");
    expect(inserts[0].rows[0]).toMatchObject({
      pointRid: 11,
      value: 42,
    });
    expect(inserts[0].rows[0].measurementTime).toBeInstanceOf(Date);
    expect(inserts[0].rows[0].measurementTime.getTime()).toBe(
      1_700_000_000_000,
    );
  });

  it("insert5m upserts when upsert:true, first-write-wins when false", async () => {
    const p = point(12, 2, 0);
    const base = {
      point: p,
      intervalEndMs: 1_700_000_000_000,
      avg: 1,
      min: 0,
      max: 2,
      last: 1,
      delta: 0,
      valueStr: null,
      sampleCount: 5,
      errorCount: 0,
      dataQuality: "good",
      sessionId: null,
    };
    const up = makeFakeExec();
    await ReadingsDao.insert5m([base], { upsert: true }, up.exec);
    expect(up.inserts[0]).toMatchObject({
      table: "point_readings_agg_5m",
      mode: "update",
    });

    const first = makeFakeExec();
    await ReadingsDao.insert5m([base], { upsert: false }, first.exec);
    expect(first.inserts[0].mode).toBe("nothing");
  });

  it("insert5m upsert overwrites the vendor-meta columns by default", async () => {
    const p = point(14, 2, 0);
    const base = {
      point: p,
      intervalEndMs: 1_700_000_000_000,
      avg: 1,
      min: 0,
      max: 2,
      last: 1,
      delta: 0,
      valueStr: null,
      sampleCount: 5,
      errorCount: 0,
      dataQuality: null,
      sessionId: null,
    };
    const { exec, inserts } = makeFakeExec();
    await ReadingsDao.insert5m([base], { upsert: true }, exec);
    // Full-fidelity SET (receiver path): value columns + vendor meta.
    expect(inserts[0].setKeys).toEqual(
      expect.arrayContaining([
        "avg",
        "min",
        "max",
        "last",
        "delta",
        "sampleCount",
        "errorCount",
        "updatedAt",
        "sessionId",
        "valueStr",
        "dataQuality",
      ]),
    );
  });

  it("insert5m upsert with preserveVendorMeta leaves session/value_str/data_quality untouched", async () => {
    const p = point(15, 2, 0);
    const base = {
      point: p,
      intervalEndMs: 1_700_000_000_000,
      avg: 1,
      min: 0,
      max: 2,
      last: 1,
      delta: 0,
      valueStr: null,
      sampleCount: 5,
      errorCount: 0,
      dataQuality: null,
      sessionId: null,
    };
    const { exec, inserts } = makeFakeExec();
    await ReadingsDao.insert5m(
      [base],
      { upsert: true, preserveVendorMeta: true },
      exec,
    );
    expect(inserts[0].mode).toBe("update");
    // Value-only SET (recompute path): the 7 aggregate value columns + updated_at, and NOTHING else.
    expect(inserts[0].setKeys!.sort()).toEqual(
      [
        "avg",
        "delta",
        "errorCount",
        "last",
        "max",
        "min",
        "sampleCount",
        "updatedAt",
      ].sort(),
    );
    expect(inserts[0].setKeys).not.toContain("sessionId");
    expect(inserts[0].setKeys).not.toContain("valueStr");
    expect(inserts[0].setKeys).not.toContain("dataQuality");
  });

  it("insert5m upsert with preserveVendorMeta + writeDataQuality re-adds data_quality only", async () => {
    const p = point(16, 2, 0);
    const base = {
      point: p,
      intervalEndMs: 1_700_000_000_000,
      avg: 1,
      min: 0,
      max: 2,
      last: 1,
      delta: 0,
      valueStr: null,
      sampleCount: 5,
      errorCount: 0,
      dataQuality: "estimated",
      sessionId: null,
    };
    const { exec, inserts } = makeFakeExec();
    await ReadingsDao.insert5m(
      [base],
      { upsert: true, preserveVendorMeta: true, writeDataQuality: true },
      exec,
    );
    expect(inserts[0].mode).toBe("update");
    // Derived-writer SET (battery-provenance / HWS): the 7 aggregate value cols + updated_at +
    // data_quality, and NEITHER session_id NOR value_str.
    expect(inserts[0].setKeys!.sort()).toEqual(
      [
        "avg",
        "dataQuality",
        "delta",
        "errorCount",
        "last",
        "max",
        "min",
        "sampleCount",
        "updatedAt",
      ].sort(),
    );
    expect(inserts[0].setKeys).not.toContain("sessionId");
    expect(inserts[0].setKeys).not.toContain("valueStr");
  });

  it("upsert1d always upserts into agg_1d keyed by day", async () => {
    const p = point(13, 3, 1);
    const { exec, inserts } = makeFakeExec();
    await ReadingsDao.upsert1d(
      [
        {
          point: p,
          day: "2026-07-22",
          avg: 1,
          min: 0,
          max: 2,
          last: 1,
          delta: 0,
          sampleCount: 288,
          errorCount: 0,
        },
      ],
      exec,
    );
    expect(inserts[0]).toMatchObject({
      table: "point_readings_agg_1d",
      mode: "update",
    });
    expect(inserts[0].rows[0]).toMatchObject({
      pointRid: 13,
      day: "2026-07-22",
    });
  });

  it("empty input is a no-op (no DB call)", async () => {
    const { exec, inserts } = makeFakeExec();
    expect(await ReadingsDao.insertRaw([], exec)).toEqual({ inserted: 0 });
    expect(inserts).toHaveLength(0);
  });
});

describe("ReadingsDao reads — rows map back to PointId, timestamps → epoch-ms", () => {
  it("read5m returns a per-point ascending series keyed by PointId", async () => {
    const p = point(21, 7, 4); // rid 21
    const rows = [
      {
        pointRid: 21,
        intervalEnd: new Date(1_700_000_300_000),
        createdAt: new Date(1_700_000_301_000),
        avg: 1,
        min: 0,
        max: 2,
        last: 1,
        delta: 0,
        valueStr: null,
        sampleCount: 5,
        errorCount: 0,
        dataQuality: "good",
        sessionId: null,
      },
    ];
    const { exec } = makeFakeExec(rows);
    const out = await ReadingsDao.read5m(
      [p],
      { fromMs: 0, toMs: 2_000_000_000_000 },
      exec,
    );
    expect(out.get(p)).toEqual([
      {
        intervalEndMs: 1_700_000_300_000,
        createdAtMs: 1_700_000_301_000,
        avg: 1,
        min: 0,
        max: 2,
        last: 1,
        delta: 0,
        valueStr: null,
        sampleCount: 5,
        errorCount: 0,
        dataQuality: "good",
        sessionId: null,
      },
    ]);
  });

  it("latestForPoints returns null for a point with no rows", async () => {
    const p = point(22, 8, 0);
    const { exec } = makeFakeExec([]); // no rows
    const out = await ReadingsDao.latestForPoints([p], exec);
    expect(out.get(p)).toBeNull();
  });

  it("latest5mForPoints maps the latest agg_5m row per point (incl. createdAtMs), null when none", async () => {
    const p = point(23, 9, 2); // rid 23
    const rows = [
      {
        pointRid: 23,
        intervalEnd: new Date(1_700_000_600_000),
        createdAt: new Date(1_700_000_601_000),
        avg: 3,
        min: 1,
        max: 4,
        last: 3,
        delta: 2,
        valueStr: null,
        sampleCount: 6,
        errorCount: 0,
        dataQuality: "good",
        sessionId: "sess-9",
      },
    ];
    const hit = makeFakeExec(rows);
    const out = await ReadingsDao.latest5mForPoints([p], hit.exec);
    expect(out.get(p)).toEqual({
      intervalEndMs: 1_700_000_600_000,
      createdAtMs: 1_700_000_601_000,
      avg: 3,
      min: 1,
      max: 4,
      last: 3,
      delta: 2,
      valueStr: null,
      sampleCount: 6,
      errorCount: 0,
      dataQuality: "good",
      sessionId: "sess-9",
    });

    const empty = makeFakeExec([]);
    const none = await ReadingsDao.latest5mForPoints([p], empty.exec);
    expect(none.get(p)).toBeNull();
  });

  it("countAgg5mByLocalDay maps per-point per-local-day counts", async () => {
    const p = point(31, 9, 2);
    const { exec } = makeFakeExec([
      { local_day: "2026-07-20", point_rid: 31, n: 48 },
      { local_day: "2026-07-21", point_rid: 31, n: 47 },
    ]);
    const out = await ReadingsDao.countAgg5mByLocalDay(
      [p],
      { fromMs: 0, toMs: 2_000_000_000_000, offsetMin: 600 },
      exec,
    );
    expect(out.get(p)).toEqual(
      new Map([
        ["2026-07-20", 48],
        ["2026-07-21", 47],
      ]),
    );
  });

  it("countAgg5mForLocalDay maps per-point count for one day (0 when absent)", async () => {
    const p = point(32, 9, 2);
    const absent = point(33, 9, 3);
    const { exec } = makeFakeExec([{ point_rid: 32, n: 288 }]);
    const out = await ReadingsDao.countAgg5mForLocalDay(
      [p, absent],
      { day: "2026-07-20", offsetMin: 600 },
      exec,
    );
    expect(out.get(p)).toBe(288);
    expect(out.get(absent)).toBe(0);
  });

  it("latestAgg5mIntervalMsForPoints maps per-point MAX(interval_end) to epoch-ms, null when absent", async () => {
    const p1 = point(41, 7, 4); // rid 41 — has a row
    const p2 = point(42, 7, 5); // rid 42 — no matching row → null
    const { exec } = makeFakeExec([
      { pointRid: 41, m: new Date(1_700_000_300_000) },
    ]);
    const out = await ReadingsDao.latestAgg5mIntervalMsForPoints(
      [p1, p2],
      exec,
    );
    expect(out.get(p1)).toBe(1_700_000_300_000);
    expect(out.get(p2)).toBeNull();
  });

  it("latestAgg5mUpdatedAtForPoint returns MAX(updated_at) epoch-ms, null when no rows / null max", async () => {
    const p = point(43, 7, 4);
    const window = {
      afterIntervalEndMs: 0,
      throughIntervalEndMs: 2_000_000_000_000,
    };
    const hit = makeFakeExec([{ m: new Date(1_700_000_900_000) }]);
    expect(
      await ReadingsDao.latestAgg5mUpdatedAtForPoint(p, window, hit.exec),
    ).toBe(1_700_000_900_000);
    const empty = makeFakeExec([]); // no rows → [row] undefined → null
    expect(
      await ReadingsDao.latestAgg5mUpdatedAtForPoint(p, window, empty.exec),
    ).toBeNull();
    const nullMax = makeFakeExec([{ m: null }]); // rows exist but MAX null → null
    expect(
      await ReadingsDao.latestAgg5mUpdatedAtForPoint(p, window, nullMax.exec),
    ).toBeNull();
  });
});

describe("upperBoundOp — read-window upper-bound operator", () => {
  it("is inclusive (lte) by default and when toInclusive is true", () => {
    expect(upperBoundOp(undefined)).toBe(lte);
    expect(upperBoundOp(true)).toBe(lte);
  });
  it("is half-open (lt) when toInclusive is false", () => {
    expect(upperBoundOp(false)).toBe(lt);
  });
});

describe("ReadingsDao operational readers", () => {
  it("maps active latest rows to PointIds and epoch-ms", async () => {
    const id = Point.generate();
    const { exec } = makeFakeExec([
      {
        point_uid: Point.toUuid(id),
        logical_path_stem: "source.grid",
        metric_type: "power",
        metric_unit: "W",
        display_name: "Grid",
        value: 42,
        value_str: null,
        measurement_time_ms: "1700000000000",
        received_time_ms: "1700000001000",
        session_id: "session-1",
        session_label: "poll",
      },
    ]);

    await expect(ReadingsDao.latestForActivePoints(exec)).resolves.toEqual([
      {
        point: id,
        logicalPathStem: "source.grid",
        metricType: "power",
        metricUnit: "W",
        displayName: "Grid",
        value: 42,
        valueStr: null,
        measurementTimeMs: 1_700_000_000_000,
        receivedTimeMs: 1_700_000_001_000,
        sessionId: "session-1",
        sessionLabel: "poll",
      },
    ]);
  });

  it("returns per-point agg5m coverage and null for missing points", async () => {
    const p1 = point(11, 1, 3);
    const p2 = point(12, 1, 4);
    const { exec } = makeFakeExec([
      {
        pointRid: 11,
        first: new Date("2026-01-01T00:00:00Z"),
        last: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const out = await ReadingsDao.agg5mCoverageForPoints([p1, p2], exec);
    expect(out.get(p1)).toEqual({
      firstMs: Date.parse("2026-01-01T00:00:00Z"),
      lastMs: Date.parse("2026-01-02T00:00:00Z"),
    });
    expect(out.get(p2)).toBeNull();
    await expect(ReadingsDao.agg5mCoverageForPoints([], exec)).resolves.toEqual(
      new Map(),
    );
  });

  it("returns planner estimates and DB-relative raw landing health", async () => {
    const estimate = makeFakeExec([{ n_live_tup: "3000000" }]);
    await expect(
      ReadingsDao.approximateRowCount("agg5m", estimate.exec),
    ).resolves.toBe(3_000_000);

    const health = makeFakeExec([
      { n: "17", latest: new Date("2026-01-02T03:04:05Z") },
    ]);
    await expect(
      ReadingsDao.rawLandingHealth(3_600_000, health.exec),
    ).resolves.toEqual({
      count: 17,
      latestCreatedAtMs: Date.parse("2026-01-02T03:04:05Z"),
    });
  });
});

describe("ReadingsDao maintenance — non-point-keyed range ops", () => {
  it("delete1dRange deletes agg_1d by day range and returns the deleted row count", async () => {
    // returning() resolves one row per deleted row → deleted === selectRows.length.
    const { exec, deletes } = makeFakeExec([
      { day: "2026-07-20" },
      { day: "2026-07-21" },
    ]);
    const res = await ReadingsDao.delete1dRange(
      { startDay: "2026-07-20", endDay: "2026-07-21" },
      exec,
    );
    expect(res).toEqual({ deleted: 2 });
    expect(deletes).toEqual([{ table: "point_readings_agg_1d" }]);
  });

  it("earliestAgg5mMs returns the first row's interval as epoch-ms, null when empty", async () => {
    const withRow = makeFakeExec([
      { intervalEnd: new Date(1_700_000_000_000) },
    ]);
    expect(await ReadingsDao.earliestAgg5mMs(withRow.exec)).toBe(
      1_700_000_000_000,
    );
    const empty = makeFakeExec([]);
    expect(await ReadingsDao.earliestAgg5mMs(empty.exec)).toBeNull();
  });

  it("deviceIdsWithAgg5mSince maps distinct device uuids (via the point_rid → points join) to stable ids", async () => {
    const d1 = device(1);
    const d14 = device(14);
    // The rid-keyed twin has no system_id: the DAO now SELECTs DISTINCT points.device_id.
    const { exec } = makeFakeExec([
      { deviceUuid: Device.toUuid(d1) },
      { deviceUuid: Device.toUuid(d14) },
    ]);
    expect(
      await ReadingsDao.deviceIdsWithAgg5mSince(1_700_000_000_000, exec),
    ).toEqual([d1, d14]);
  });

  // Both device-keyed "latest interval" seams now go through one raw LATERAL that projects
  // `latest_ms` (epoch-ms) rather than a drizzle select of `intervalEnd` — see
  // maxAgg5mIntervalMsForDeviceUuids for why the flat JOIN shape had to go (a stale device took
  // 29.5s on the twin). A null row models "device has no agg_5m rows".
  it("latestAgg5mIntervalMsForDevice returns the newest interval as epoch-ms, null when empty", async () => {
    const d9 = device(9);
    const withRow = makeFakeExec([{ latest_ms: "1700000900000" }]);
    expect(
      await ReadingsDao.latestAgg5mIntervalMsForDevice(d9, withRow.exec),
    ).toBe(1_700_000_900_000);
    // `max()` over no rows yields one row whose latest_ms is NULL — not zero rows.
    const empty = makeFakeExec([{ latest_ms: null }]);
    expect(
      await ReadingsDao.latestAgg5mIntervalMsForDevice(d9, empty.exec),
    ).toBeNull();
  });

  it("countByCreatedAtSince counts raw and agg5m rows since a cutoff (0 when empty)", async () => {
    const raw = makeFakeExec([{ n: 123 }]);
    expect(
      await ReadingsDao.countByCreatedAtSince(
        "raw",
        1_700_000_000_000,
        raw.exec,
      ),
    ).toBe(123);
    const agg = makeFakeExec([{ n: 45 }]);
    expect(
      await ReadingsDao.countByCreatedAtSince(
        "agg5m",
        1_700_000_000_000,
        agg.exec,
      ),
    ).toBe(45);
    const none = makeFakeExec([]);
    expect(
      await ReadingsDao.countByCreatedAtSince(
        "raw",
        1_700_000_000_000,
        none.exec,
      ),
    ).toBe(0);
  });

  it("createdAtHistogramSince maps date_trunc minute buckets to epoch-ms", async () => {
    const { exec } = makeFakeExec([
      { minute: new Date(1_700_000_040_000), count: 5 },
      { minute: new Date(1_700_000_100_000), count: 9 },
    ]);
    expect(await ReadingsDao.createdAtHistogramSince("raw", 0, exec)).toEqual([
      { minuteMs: 1_700_000_040_000, count: 5 },
      { minuteMs: 1_700_000_100_000, count: 9 },
    ]);
  });

  it("distinctSystemsByRawCreatedAtSince returns the distinct-system count", async () => {
    const { exec } = makeFakeExec([{ n: 7 }]);
    expect(
      await ReadingsDao.distinctSystemsByRawCreatedAtSince(
        1_700_000_000_000,
        exec,
      ),
    ).toBe(7);
  });

  it("latestRawCreatedAtMs returns the newest raw created_at, null when empty", async () => {
    const withRow = makeFakeExec([{ createdAt: new Date(1_700_000_500_000) }]);
    expect(await ReadingsDao.latestRawCreatedAtMs(withRow.exec)).toBe(
      1_700_000_500_000,
    );
    const empty = makeFakeExec([]);
    expect(await ReadingsDao.latestRawCreatedAtMs(empty.exec)).toBeNull();
  });

  it("maxAgg5mIntervalMsForDevices returns max for a set; null for empty set or no rows", async () => {
    const d1 = device(1);
    const d2 = device(2);
    const withRow = makeFakeExec([{ latest_ms: "1700000900000" }]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForDevices([d1, d2], withRow.exec),
    ).toBe(1_700_000_900_000);
    const emptyRows = makeFakeExec([{ latest_ms: null }]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForDevices([d1], emptyRows.exec),
    ).toBeNull();
    // Empty system set short-circuits (no query issued).
    const noQuery = makeFakeExec([{ intervalEnd: new Date(1) }]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForDevices([], noQuery.exec),
    ).toBeNull();
  });
});

describe("ReadingsDao admin views — relocated verbatim from readings-read-pg", () => {
  it.each(["raw", "5m", "daily"] as const)(
    "readAdminPivot returns pivot rows for source=%s (raw/5m coerce measurement_time to number, daily keeps YYYY-MM-DD)",
    async (source) => {
      const isDaily = source === "daily";
      const canned = [
        {
          // node-postgres returns the epoch-ms bigint as a string; daily returns pr.day verbatim.
          measurement_time: isDaily ? "2026-01-15" : "1700000000000",
          session_id: null,
          session_label: null,
          point_0: 5,
        },
      ];
      const { exec } = makeFakeExec(canned);
      const d1 = device(1);
      const p0 = point(1, 1, 0);
      const out = await ReadingsDao.readAdminPivot(
        {
          device: d1,
          source,
          cursor: isDaily ? "2026-01-15" : 1_700_000_000_000,
          direction: "older",
          limit: 100,
          points: [
            {
              point: p0,
              outputKey: "point_0",
              valueColumn: source === "raw" ? "value" : "avg",
            },
          ],
        },
        exec,
      );
      expect(out).toHaveLength(1);
      expect(out[0].measurement_time).toBe(
        isDaily ? "2026-01-15" : 1_700_000_000_000,
      );
      expect(out[0].point_0).toBe(5);
    },
  );

  it("hasReadingsForDevice is true when SELECT 1 returns a row, false when empty", async () => {
    const d1 = device(1);
    const hit = makeFakeExec([{ "?column?": 1 }]);
    expect(await ReadingsDao.hasReadingsForDevice(d1, "agg5m", hit.exec)).toBe(
      true,
    );
    const miss = makeFakeExec([]);
    expect(await ReadingsDao.hasReadingsForDevice(d1, "raw", miss.exec)).toBe(
      false,
    );
  });

  it("hasReadingsForDeviceBeyond is true when a row exists beyond the boundary, false when none (both boundary grammars)", async () => {
    const d1 = device(1);
    const olderHit = makeFakeExec([{ "?column?": 1 }]);
    expect(
      await ReadingsDao.hasReadingsForDeviceBeyond(
        d1,
        "raw",
        1_700_000_000_000,
        "older",
        olderHit.exec,
      ),
    ).toBe(true);
    const dailyMiss = makeFakeExec([]);
    expect(
      await ReadingsDao.hasReadingsForDeviceBeyond(
        d1,
        "agg1d",
        "2026-01-15",
        "newer",
        dailyMiss.exec,
      ),
    ).toBe(false);
  });

  // ⚠️  `makeFakeExec` ignores the emitted SQL entirely — `execute` returns canned rows without reading
  // its argument. So the two window-around tests below pin the epoch-ms coercion and the passthrough,
  // NOT the projection or the WHERE clause: any change to the SQL (including the Phase-8 rid flip) is
  // invisible here. Do not read a green as "the query is right". Pinning the SQL text needs a real
  // driver — see the Group-B SQL-capture harness.
  it("readRawWindowAround resolves the PointId and coerces measurement/received times, passing other fields through verbatim", async () => {
    const p = point(41, 1, 3); // systemId 1, index 3
    const canned = [
      {
        sessionId: null,
        measurementTime: "1700000000000",
        receivedTime: "1700000001000",
        value: 42,
        valueStr: null,
        error: null,
        dataQuality: "good",
        sessionLabel: null,
      },
    ];
    const { exec } = makeFakeExec(canned);
    const out = await ReadingsDao.readRawWindowAround(
      p,
      1_700_000_000_000,
      exec,
    );
    expect(out[0].measurementTime).toBe(1_700_000_000_000);
    expect(out[0].receivedTime).toBe(1_700_000_001_000);
    expect(out[0].value).toBe(42);
    expect(out[0].dataQuality).toBe("good");
  });

  it("read5mRowWindowAround coerces intervalEnd and preserves row_num from the verbatim SELECT ranked.*", async () => {
    const p = point(42, 1, 3);
    const canned = [
      {
        sessionId: null,
        intervalEnd: "1700000300000",
        avg: 1,
        min: 0,
        max: 2,
        last: 1,
        delta: 0,
        sampleCount: 5,
        errorCount: 0,
        dataQuality: "good",
        sessionLabel: null,
        // node-postgres returns ROW_NUMBER()'s int8 as a string; the method must NOT strip it.
        row_num: "7",
      },
    ];
    const { exec } = makeFakeExec(canned);
    const out = await ReadingsDao.read5mRowWindowAround(
      p,
      1_700_000_300_000,
      exec,
    );
    expect(out[0].intervalEnd).toBe(1_700_000_300_000);
    expect(out[0].row_num).toBe("7");
  });
});
