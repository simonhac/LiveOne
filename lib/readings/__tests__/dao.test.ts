import { describe, it, expect, beforeEach } from "@jest/globals";
import { Point, type PointId } from "@/lib/ids";
import type { PointAddr } from "@/lib/registry";

// Control point→address resolution: the DAO's SEAM. Tests populate `addrMap`.
const addrMap = new Map<PointId, PointAddr>();
jest.mock("@/lib/registry", () => ({
  RegistryCache: {
    addrsForPoints: async (ids: PointId[]) =>
      new Map(ids.map((id) => [id, addrMap.get(id)!])),
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
      return {
        from() {
          return { where: result, orderBy: result };
        },
      };
    },
    selectDistinct() {
      return {
        from() {
          return { where: () => Promise.resolve(selectRows) };
        },
      };
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

beforeEach(() => addrMap.clear());

describe("ReadingsDao writes — composite-key expansion", () => {
  it("insertRaw builds (systemId, pointId=index) rows with Date times and first-write-wins", async () => {
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
      systemId: 1,
      pointId: 3,
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
      systemId: 3,
      pointId: 1,
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
    const p = point(21, 7, 4); // systemId 7, index 4
    const rows = [
      {
        pointId: 4,
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
    const p = point(23, 9, 2); // systemId 9, index 2
    const rows = [
      {
        pointId: 2,
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
      { local_day: "2026-07-20", point_id: 2, n: 48 },
      { local_day: "2026-07-21", point_id: 2, n: 47 },
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
    const { exec } = makeFakeExec([{ point_id: 2, n: 288 }]);
    const out = await ReadingsDao.countAgg5mForLocalDay(
      [p, absent],
      { day: "2026-07-20", offsetMin: 600 },
      exec,
    );
    expect(out.get(p)).toBe(288);
    expect(out.get(absent)).toBe(0);
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

  it("systemIdsWithAgg5mSince maps distinct system ids", async () => {
    const { exec } = makeFakeExec([{ systemId: 1 }, { systemId: 14 }]);
    expect(
      await ReadingsDao.systemIdsWithAgg5mSince(1_700_000_000_000, exec),
    ).toEqual([1, 14]);
  });

  it("latestAgg5mIntervalMsForSystem returns the newest interval as epoch-ms, null when empty", async () => {
    const withRow = makeFakeExec([
      { intervalEnd: new Date(1_700_000_900_000) },
    ]);
    expect(
      await ReadingsDao.latestAgg5mIntervalMsForSystem(9, withRow.exec),
    ).toBe(1_700_000_900_000);
    const empty = makeFakeExec([]);
    expect(
      await ReadingsDao.latestAgg5mIntervalMsForSystem(9, empty.exec),
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

  it("maxAgg5mIntervalMsForSystems returns max for a set; null for empty set or no rows", async () => {
    const withRow = makeFakeExec([
      { intervalEnd: new Date(1_700_000_900_000) },
    ]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForSystems([1, 2], withRow.exec),
    ).toBe(1_700_000_900_000);
    const emptyRows = makeFakeExec([]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForSystems([1], emptyRows.exec),
    ).toBeNull();
    // Empty system set short-circuits (no query issued).
    const noQuery = makeFakeExec([{ intervalEnd: new Date(1) }]);
    expect(
      await ReadingsDao.maxAgg5mIntervalMsForSystems([], noQuery.exec),
    ).toBeNull();
  });
});
