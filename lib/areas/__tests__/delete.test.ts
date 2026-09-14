/**
 * `hardDeleteArea` — the STATEMENT ORDER and the PREDICATES, which are the whole content.
 *
 * 🛑 An earlier cut of this file threw away every `where` argument and the table each statement
 * targeted. Review caught that the tests were therefore tautological: deleting the
 * `status = 'archived'` predicate still passed all of them, and so did retargeting the sole DELETE
 * at `legacy_handles` — the one mistake that would destroy a live device's `?systemId=N` mapping.
 *
 * So the stubs here record the TABLE by identity and compile each condition with drizzle's real
 * `PgDialect`. A test asserting `"areas"."status" = $2` with param `archived` cannot pass an
 * implementation that dropped the predicate.
 *
 * What the assertions protect:
 *  1. `legacy_handles` is UPDATEd, not DELETEd. On prod 16 of the 17 empty area-of-one shells share
 *     their handle row with a live device.
 *  2. The area row is locked `FOR UPDATE` before the dependency scan — that lock conflicts with the
 *     `FOR KEY SHARE` an FK insert takes, which is what makes the scan authoritative.
 *  3. The scan runs on the TRANSACTION, not the pool. On the pool it was a committable gap.
 *  4. `status='archived'` is in the DELETE's own `WHERE`, and a miss rolls the handle update back.
 *  5. A KV failure after the commit does not fail a delete that has already happened.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { areas, legacyHandles } from "@/lib/db/planetscale/schema";

const tx = {
  select: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};
const mockDb = { transaction: jest.fn() };

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => mockDb,
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  buildSubscriptionRegistry: jest.fn(),
}));
jest.mock("@/lib/point/point-manager", () => ({
  PointManager: { getInstance: jest.fn() },
}));
jest.mock("@/lib/integrity/relied-upon", () => ({ findDependents: jest.fn() }));

import { buildSubscriptionRegistry } from "@/lib/kv-cache-manager";
import { PointManager } from "@/lib/point/point-manager";
import { findDependents } from "@/lib/integrity/relied-upon";
import { AreaNotArchivedError, hardDeleteArea } from "../delete";

const AREA = "01a0a00a-1dcb-7c7b-8580-fd59501666f5";
const dialect = new PgDialect();

/** The real compiled SQL for a drizzle condition — no hand-rolled walker. */
const sqlOf = (cond: unknown) => {
  const q = dialect.sqlToQuery((cond as { getSQL(): never }).getSQL());
  return { sql: q.sql, params: q.params as unknown[] };
};

/** Which schema table a builder was handed, by IDENTITY rather than by name. */
const tableOf = (t: unknown) =>
  t === areas ? "areas" : t === legacyHandles ? "legacy_handles" : "OTHER";

interface Stmt {
  op: string;
  table: string;
  sql?: string;
  params?: unknown[];
  set?: Record<string, unknown>;
  forUpdate?: boolean;
}

let stmts: Stmt[];
let invalidate: jest.Mock;

function stubTx(opts: {
  handle?: number | null;
  deleted: unknown[];
  /** `null` = the area row is gone; otherwise the status the lock observes. */
  status?: string | null;
}) {
  let selects = 0;
  tx.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const n = selects++;
        const rec: Stmt = {
          op: n === 0 ? "select-lock" : "select-handle",
          table: tableOf(table),
          ...sqlOf(cond),
        };
        stmts.push(rec);
        const chain = {
          for: (mode: string) => {
            rec.forUpdate = mode === "update";
            return chain;
          },
          limit: async () => {
            if (n === 0) {
              const status =
                opts.status === undefined ? "archived" : opts.status;
              return status === null ? [] : [{ id: AREA, status }];
            }
            return opts.handle == null ? [] : [{ handle: opts.handle }];
          },
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
    where: (cond: unknown) => ({
      returning: async () => {
        stmts.push({ op: "delete", table: tableOf(table), ...sqlOf(cond) });
        return opts.deleted;
      },
    }),
  }));
  mockDb.transaction.mockImplementation(async (fn: unknown) =>
    (fn as (t: typeof tx) => Promise<unknown>)(tx),
  );
}

const ok = (r: Awaited<ReturnType<typeof hardDeleteArea>>) => {
  if (!r.ok) throw new Error("expected a deletion, got a refusal");
  return r.deleted;
};

beforeEach(() => {
  jest.clearAllMocks();
  stmts = [];
  invalidate = jest.fn();
  jest
    .mocked(PointManager.getInstance)
    .mockReturnValue({ invalidateSeriesCache: invalidate } as never);
  jest.mocked(buildSubscriptionRegistry).mockResolvedValue(undefined as never);
  jest.mocked(findDependents).mockResolvedValue([]);
});

describe("hardDeleteArea", () => {
  it("locks, scans, releases the handle, then deletes — in that order", async () => {
    stubTx({
      handle: 1,
      deleted: [{ id: AREA, name: "Daylesford Selectronic" }],
    });
    const out = ok(await hardDeleteArea(AREA));

    expect(stmts.map((s) => `${s.op}:${s.table}`)).toEqual([
      "select-lock:areas",
      "select-handle:legacy_handles",
      "update:legacy_handles",
      "delete:areas",
    ]);
    expect(out).toEqual({
      id: AREA,
      name: "Daylesford Selectronic",
      handle: 1,
    });
  });

  /** 🛑 The lock is what makes the dependency scan authoritative rather than advisory. */
  it("takes FOR UPDATE on the area row before scanning", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    await hardDeleteArea(AREA);

    const lock = stmts[0];
    expect(lock.forUpdate).toBe(true);
    expect(lock.table).toBe("areas");
    expect(lock.sql).toContain('"areas"."id" = $1');
    expect(lock.params).toEqual([AREA]);
  });

  /** 🛑 On the TRANSACTION. On the pool it is a committable gap — the bug this shape fixes. */
  it("scans dependents on the transaction, destructively", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    await hardDeleteArea(AREA);

    expect(findDependents).toHaveBeenCalledWith("area", AREA, {
      destructive: true,
      // The transaction object itself — not the pool. Compared by identity via the mock's own
      // recorded argument, so a switch back to `requirePlanetscaleDb()` fails here.
      exec: expect.anything(),
    });
    expect(jest.mocked(findDependents).mock.calls[0][2]!.exec).toBe(tx);
  });

  it("refuses — writing nothing — when anything depends on the area", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    jest
      .mocked(findDependents)
      .mockResolvedValue([{ kind: "calendar-feed" }] as never);

    const r = await hardDeleteArea(AREA);
    expect(r.ok).toBe(false);
    expect(stmts.some((s) => s.op === "update" || s.op === "delete")).toBe(
      false,
    );
    expect(invalidate).not.toHaveBeenCalled();
  });

  /**
   * 🛑 The single most important assertion in this file. `legacy_handles` rows are shared with
   * devices; DELETEing one takes a live device's `?systemId=N` with it.
   */
  it("NEVER deletes from legacy_handles — it nulls the column", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    await hardDeleteArea(AREA);

    const deletes = stmts.filter((s) => s.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe("areas"); // NOT legacy_handles

    const upd = stmts.find((s) => s.op === "update")!;
    expect(upd.table).toBe("legacy_handles");
    expect(upd.set).toEqual({ areaId: null });
    expect(upd.sql).toContain('"legacy_handles"."area_id" = $1');
    expect(upd.params).toEqual([AREA]);
  });

  /** 🛑 Drop this predicate and an ACTIVE area becomes deletable. Pinned on the compiled SQL. */
  it("restates status='archived' in the DELETE's own WHERE", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    await hardDeleteArea(AREA);

    const del = stmts.find((s) => s.op === "delete")!;
    expect(del.sql).toContain('"areas"."id" = $1');
    expect(del.sql).toContain('"areas"."status" = $2');
    expect(del.params).toEqual([AREA, "archived"]);
  });

  it("captures the handle BEFORE nulling it, and invalidates with that value", async () => {
    stubTx({ handle: 42, deleted: [{ id: AREA, name: "x" }] });
    await hardDeleteArea(AREA);

    const iSel = stmts.findIndex((s) => s.op === "select-handle");
    const iUpd = stmts.findIndex((s) => s.op === "update");
    expect(iSel).toBeGreaterThanOrEqual(0);
    expect(iSel).toBeLessThan(iUpd);
    expect(invalidate).toHaveBeenCalledWith(42);
  });

  it.each([["active"], [null]])(
    "throws AreaNotArchivedError when the lock observes %p",
    async (status) => {
      stubTx({ handle: 1, deleted: [], status: status as string | null });
      await expect(hardDeleteArea(AREA)).rejects.toBeInstanceOf(
        AreaNotArchivedError,
      );
      // And it gave up AT the lock — nothing was scanned or written.
      expect(findDependents).not.toHaveBeenCalled();
      expect(stmts.some((s) => s.op === "update" || s.op === "delete")).toBe(
        false,
      );
    },
  );

  it("throws when the DELETE matches nothing", async () => {
    stubTx({ handle: 1, deleted: [] });
    await expect(hardDeleteArea(AREA)).rejects.toBeInstanceOf(
      AreaNotArchivedError,
    );
  });

  /**
   * The throw must happen INSIDE the transaction callback so the handle UPDATE rolls back with it.
   * Throwing afterwards would commit a live area unhooked from its handle — invisible until someone
   * followed a `?systemId=N` link that had quietly stopped resolving.
   */
  it("throws from inside the transaction, so the handle update rolls back", async () => {
    stubTx({ handle: 1, deleted: [] });
    let threwInside = false;
    mockDb.transaction.mockImplementation(async (fn: unknown) => {
      try {
        return await (fn as (t: typeof tx) => Promise<unknown>)(tx);
      } catch {
        threwInside = true; // a real driver ROLLBACKs here
        throw new AreaNotArchivedError(AREA);
      }
    });
    await expect(hardDeleteArea(AREA)).rejects.toBeInstanceOf(
      AreaNotArchivedError,
    );
    expect(threwInside).toBe(true);
  });

  it("does not touch the caches when the delete failed", async () => {
    stubTx({ handle: 1, deleted: [] });
    await expect(hardDeleteArea(AREA)).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
    expect(buildSubscriptionRegistry).not.toHaveBeenCalled();
  });

  it("skips the series invalidation when the area held no handle", async () => {
    stubTx({ handle: null, deleted: [{ id: AREA, name: "x" }] });
    const out = ok(await hardDeleteArea(AREA));
    expect(out.handle).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    expect(buildSubscriptionRegistry).toHaveBeenCalled();
  });

  /**
   * Dev has no KV. A delete that has already committed in Postgres must not report failure because
   * the cache could not be told — the caller would retry a delete whose row is gone.
   */
  it("survives a KV failure after the commit", async () => {
    stubTx({ handle: 1, deleted: [{ id: AREA, name: "x" }] });
    jest
      .mocked(buildSubscriptionRegistry)
      .mockRejectedValue(new Error("no KV configured") as never);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const r = await hardDeleteArea(AREA);
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
