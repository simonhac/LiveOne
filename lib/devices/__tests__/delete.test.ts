/**
 * `hardDeleteDevice` — the STATEMENT ORDER and the PREDICATES, which are the whole content.
 *
 * Written in the shape of `lib/areas/__tests__/delete.test.ts`, and for the reason that file gives:
 * a stub that throws away the `where` argument and the table each statement targets makes every
 * assertion tautological. So the table is recorded by IDENTITY and each condition is compiled with
 * drizzle's real `PgDialect` — a test asserting `"devices"."status" = $2` with param `archived`
 * cannot pass an implementation that dropped the predicate.
 *
 * What the assertions protect:
 *  1. `legacy_handles` is UPDATEd, not DELETEd. Handle 13 on prod names a device AND an area; a
 *     DELETE there would take the area's leg with it — trading the ambiguity this line of work
 *     exists to remove for data loss instead.
 *  2. The device row is locked `FOR UPDATE` before the dependency scan. That lock conflicts with the
 *     `FOR KEY SHARE` an FK insert takes, which is what makes the scan authoritative, not advisory.
 *  3. The scan runs on the TRANSACTION, not the pool. On the pool it is a committable gap.
 *  4. FK ORDER: readings → sessions → points → device. Every one of those FKs is NO ACTION, so a
 *     reordering is a 23503 in production and nothing else here would notice.
 *  5. `status='archived'` is in the DELETE's own `WHERE`, and a miss throws rather than committing
 *     the destroyed history of a device that still exists.
 *  6. A refusal destroys NOTHING — the entire point of scanning before deleting.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  amberForecastHistory,
  devices,
  legacyHandles,
  points,
  sessions,
} from "@/lib/db/planetscale/schema";

const tx = { select: jest.fn(), update: jest.fn(), delete: jest.fn() };
const mockDb = { transaction: jest.fn() };

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => mockDb,
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));
jest.mock("@/lib/integrity/relied-upon", () => ({ findDependents: jest.fn() }));
jest.mock("@/lib/kv", () => ({ kv: { del: jest.fn() } }));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    deleteRawForPoints: jest.fn(),
    deleteAggsForPoints: jest.fn(),
  },
}));

import { PointManager } from "@/lib/point/point-manager";
import { findDependents, type Dependent } from "@/lib/integrity/relied-upon";
import { ReadingsDao } from "@/lib/readings";
import { kv } from "@/lib/kv";
import { DeviceNotArchivedError, hardDeleteDevice } from "../delete";

const DEV = "01a0a00a-1dcb-7c7b-8580-fd59501666f5";
const dialect = new PgDialect();

const sqlOf = (cond: unknown) => {
  const q = dialect.sqlToQuery((cond as { getSQL(): never }).getSQL());
  return { sql: q.sql, params: q.params as unknown[] };
};

const tableOf = (t: unknown) =>
  t === devices
    ? "devices"
    : t === legacyHandles
      ? "legacy_handles"
      : t === points
        ? "points"
        : t === sessions
          ? "sessions"
          : t === amberForecastHistory
            ? "amber_forecast_history"
            : "OTHER";

interface Stmt {
  op: string;
  table: string;
  sql?: string;
  params?: unknown[];
  set?: Record<string, unknown>;
  forUpdate?: boolean;
}

let stmts: Stmt[];

function stubTx(opts: {
  handle?: number | null;
  deleted: unknown[];
  status?: string | null;
  pointRids?: number[];
}) {
  let selects = 0;
  tx.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const n = selects++;
        const rec: Stmt = {
          op: ["select-lock", "select-points", "select-handle"][n] ?? "select",
          table: tableOf(table),
          ...sqlOf(cond),
        };
        stmts.push(rec);
        const rows =
          n === 0
            ? (() => {
                const status =
                  opts.status === undefined ? "archived" : opts.status;
                return status === null ? [] : [{ id: DEV, status, rid: 16 }];
              })()
            : n === 1
              ? (opts.pointRids ?? []).map((rid) => ({ rid }))
              : opts.handle == null
                ? []
                : [{ handle: opts.handle }];
        // The points select is awaited directly; the other two chain .for()/.limit().
        const chain = {
          for: (mode: string) => {
            rec.forUpdate = mode === "update";
            return chain;
          },
          limit: async () => rows,
          then: (res: (v: unknown) => void) => res(rows),
        };
        return chain;
      },
    }),
  }));
  tx.update.mockImplementation((table: unknown) => ({
    set: (fields: Record<string, unknown>) => ({
      where: async (cond: unknown) => {
        stmts.push({
          op: "update",
          table: tableOf(table),
          set: fields,
          ...sqlOf(cond),
        });
      },
    }),
  }));
  tx.delete.mockImplementation((table: unknown) => ({
    where: (cond: unknown) => {
      stmts.push({ op: "delete", table: tableOf(table), ...sqlOf(cond) });
      const result = { rowCount: 1 };
      return {
        returning: async () => opts.deleted,
        then: (res: (v: unknown) => void) => res(result),
      };
    },
  }));
  mockDb.transaction.mockImplementation(async (fn: unknown) =>
    (fn as (t: typeof tx) => Promise<unknown>)(tx),
  );
}

const ok = (r: Awaited<ReturnType<typeof hardDeleteDevice>>) => {
  if (!r.ok) throw new Error("expected a deletion, got a refusal");
  return r.deleted;
};

/**
 * 🛑 ONE trace for everything.
 *
 * The DAO deletions and the dependency scan used to live in their own mocks, which meant the
 * "deletes in FK order" test could not see them: moving BOTH reading deletes after the session
 * delete still passed it, and the lock test could not prove the scan followed the lock. They now
 * record into the same array as the SQL statements, in call order, so every ordering claim in this
 * file is about one sequence rather than three.
 */
const trace = () => stmts.map((s) => (s.table ? s.op + ":" + s.table : s.op));

let dependents: Dependent[];

beforeEach(() => {
  jest.clearAllMocks();
  stmts = [];
  dependents = [];
  jest
    .mocked(PointManager.getInstance)
    .mockReturnValue({ invalidateSeriesCache: jest.fn() } as never);
  jest.mocked(findDependents).mockImplementation(async () => {
    stmts.push({ op: "scan", table: "" });
    return dependents;
  });
  jest.mocked(ReadingsDao.deleteRawForPoints).mockImplementation(async () => {
    stmts.push({ op: "dao-raw", table: "" });
    return 1234;
  });
  jest.mocked(ReadingsDao.deleteAggsForPoints).mockImplementation(async () => {
    stmts.push({ op: "dao-aggs", table: "" });
    return { deleted5m: 99, deleted1d: 7 };
  });
  jest.mocked(kv.del).mockResolvedValue(undefined as never);
});

describe("hardDeleteDevice", () => {
  it("locks the device row FOR UPDATE before scanning for dependents", async () => {
    stubTx({ handle: 16, deleted: [{ id: DEV, name: "Kutis · derived" }] });
    ok(await hardDeleteDevice(DEV));

    // The ORDER is the claim, and it is now visible: the lock is taken, THEN the scan runs.
    expect(trace().slice(0, 2)).toEqual(["select-lock:devices", "scan"]);
    expect(stmts[0].forUpdate).toBe(true);
    expect(stmts[0].sql).toContain('"devices"."id"');
    expect(stmts[0].params).toEqual([DEV]);
    // Authoritative only if the scan runs on the transaction holding that lock.
    expect(jest.mocked(findDependents).mock.calls[0][2]!.exec).toBe(tx);
    expect(jest.mocked(findDependents).mock.calls[0][1]).toBe(DEV);
  });

  it("asks the DESTRUCTIVE dependency question, not the archive one", async () => {
    stubTx({ handle: 16, deleted: [{ id: DEV, name: "x" }] });
    ok(await hardDeleteDevice(DEV));
    expect(jest.mocked(findDependents).mock.calls[0][0]).toBe("device");
    expect(jest.mocked(findDependents).mock.calls[0][2]!.destructive).toBe(
      true,
    );
  });

  it("🛑 UPDATEs legacy_handles, never DELETEs it — a shared handle keeps its area leg", async () => {
    stubTx({ handle: 16, deleted: [{ id: DEV, name: "x" }] });
    ok(await hardDeleteDevice(DEV));

    // The WRITE, not the read: the handle is SELECTed first (to capture it before it is cleared),
    // so matching on the table alone would find that select and assert nothing about the write.
    const writes = stmts.filter(
      (s) => s.table === "legacy_handles" && s.op !== "select-handle",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("update");
    expect(writes[0].set).toEqual({ deviceId: null });
    // Scoped to THIS device's leg — an unfiltered update would unhook every handle in the table.
    expect(writes[0].sql).toBe('"legacy_handles"."device_id" = $1');
    expect(writes[0].params).toEqual([DEV]);
    expect(
      stmts.some((s) => s.op === "delete" && s.table === "legacy_handles"),
    ).toBe(false);
  });

  it("🛑 deletes in FK order: readings → archives → points → device", async () => {
    stubTx({
      handle: 16,
      deleted: [{ id: DEV, name: "x" }],
      pointRids: [1, 2],
    });
    ok(await hardDeleteDevice(DEV));

    // `tx as never` only to satisfy the DAO signature: the ASSERTION is identity — both must have
    // been handed the same transaction the lock is held on, not the pool.
    // 🛑 ONE sequence. Readings before the archives before the points before the row — every one of
    // those FKs is NO ACTION, so any reordering is a 23503 in production. Asserted across the DAO
    // calls and the SQL together, because separately neither can see the other.
    expect(trace()).toEqual([
      "select-lock:devices",
      "scan",
      "select-points:points",
      "dao-raw",
      "dao-aggs",
      "delete:sessions",
      "delete:amber_forecast_history",
      "delete:points",
      "select-handle:legacy_handles",
      "update:legacy_handles",
      "delete:devices",
    ]);
    expect(ReadingsDao.deleteRawForPoints).toHaveBeenCalledWith(
      [1, 2],
      tx as never,
    );
    expect(ReadingsDao.deleteAggsForPoints).toHaveBeenCalledWith(
      [1, 2],
      tx as never,
    );
    // The owned points are LOCKED, not merely read — the device lock is not transitive.
    expect(stmts.find((s) => s.op === "select-points")!.forUpdate).toBe(true);
  });

  it("restates status='archived' in the DELETE's own WHERE", async () => {
    stubTx({ handle: 16, deleted: [{ id: DEV, name: "x" }] });
    ok(await hardDeleteDevice(DEV));

    const del = stmts.find((s) => s.op === "delete" && s.table === "devices")!;
    // 🛑 The CONJUNCTION, not just the tokens. Asserting `params` contains both would still pass if
    // the AND became an OR — which would delete an archived device that is not this one.
    expect(del.sql).toBe('("devices"."id" = $1 and "devices"."status" = $2)');
    expect(del.params).toEqual([DEV, "archived"]);
  });

  it("throws when the row is not archived, before touching anything", async () => {
    stubTx({ handle: 16, deleted: [], status: "active" });
    await expect(hardDeleteDevice(DEV)).rejects.toBeInstanceOf(
      DeviceNotArchivedError,
    );
    expect(stmts.some((s) => s.op === "delete")).toBe(false);
    expect(ReadingsDao.deleteRawForPoints).not.toHaveBeenCalled();
  });

  it("throws when the DELETE matches nothing — it un-archived mid-flight", async () => {
    stubTx({ handle: 16, deleted: [], pointRids: [1] });
    await expect(hardDeleteDevice(DEV)).rejects.toBeInstanceOf(
      DeviceNotArchivedError,
    );
  });

  it("🛑 a refusal destroys nothing", async () => {
    dependents = [
      {
        kind: "derivation",
        id: "dx_1",
        name: "EV charging",
        via: "derivation_sources.device_id (NO ACTION)",
        effect: "cascade-deleted",
        fix: "delete it first",
      },
    ];
    stubTx({ handle: 16, deleted: [] });

    const res = await hardDeleteDevice(DEV);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.dependents).toHaveLength(1);
    expect(stmts.some((s) => s.op === "delete")).toBe(false);
    expect(stmts.some((s) => s.op === "update")).toBe(false);
    expect(ReadingsDao.deleteRawForPoints).not.toHaveBeenCalled();
  });

  it("reports what it destroyed, and the handle captured before the delete", async () => {
    stubTx({
      handle: 16,
      deleted: [{ id: DEV, name: "Kutis · derived" }],
      pointRids: [1, 2],
    });
    const d = ok(await hardDeleteDevice(DEV));
    expect(d.handle).toBe(16);
    expect(d.destroyed).toEqual({
      points: 1,
      rawReadings: 1234,
      agg5m: 99,
      agg1d: 7,
      sessions: 1,
      amberForecasts: 1,
    });
  });

  it("a KV failure after the commit does not fail a delete that already happened", async () => {
    stubTx({ handle: 16, deleted: [{ id: DEV, name: "x" }] });
    jest.mocked(kv.del).mockRejectedValue(new Error("no KV in dev") as never);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const d = ok(await hardDeleteDevice(DEV));
    expect(d.id).toBe(DEV);
    expect(warn).toHaveBeenCalled();
  });
});
