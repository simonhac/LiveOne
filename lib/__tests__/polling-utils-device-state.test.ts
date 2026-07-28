import { describe, it, expect, beforeEach } from "@jest/globals";

// polling-utils reads the planetscaleDb singleton; expose a mutable fake (the registry-cache idiom).
let mockDb: unknown = null;
jest.mock("@/lib/db/planetscale", () => ({
  get planetscaleDb() {
    return mockDb;
  },
  requirePlanetscaleDb() {
    if (!mockDb) throw new Error("[PlanetScale] not configured (test)");
    return mockDb;
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
} from "../polling-utils";

const dialect = new PgDialect();

interface Capture {
  /** Rendered `device_state` statements: the raw sql passed to db.execute(). */
  deviceState: { sql: string; params: unknown[] }[];
  /** Any drizzle-builder insert. Must stay EMPTY — `polling_status` is frozen. */
  builderInserts: unknown[];
}

/**
 * Fake the two write surfaces: `execute(sql)`, which is how the `device_state` upsert goes out, and
 * the drizzle `insert()` builder chain, which is how the retired `polling_status` upsert went out.
 * The builder is still faked so the "nothing writes polling_status" assertion can actually observe a
 * regression rather than crashing on an undefined method.
 */
function makeFakeDb(fail: { deviceState?: boolean } = {}) {
  const capture: Capture = { deviceState: [], builderInserts: [] };
  const db = {
    insert(table: unknown) {
      capture.builderInserts.push(table);
      const chain: any = {
        values: () => chain,
        onConflictDoUpdate: () => Promise.resolve(),
        then: (r: any) => Promise.resolve().then(r),
      };
      return chain;
    },
    execute(query: SQL) {
      if (fail.deviceState)
        return Promise.reject(new Error("device_state boom"));
      capture.deviceState.push(dialect.sqlToQuery(query));
      return Promise.resolve({ rows: [] });
    },
  };
  return { db, capture };
}

/** Collapse whitespace so assertions read like the SQL, not like the template literal. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

describe("device_state polling writer (config-v4 Phase 12 slice C)", () => {
  beforeEach(() => {
    mockDb = null;
  });

  it("upserts device_state, and writes polling_status not at all", async () => {
    const { db, capture } = makeFakeDb();
    mockDb = db;

    await updatePollingStatusSuccess(7, { soc: 55 });

    expect(capture.deviceState).toHaveLength(1);
    // polling_status is frozen as the rollback snapshot — resurrecting the write costs a full
    // vendor-payload jsonb insert per poll for a table nothing reads.
    expect(capture.builderInserts).toHaveLength(0);

    const q = flat(capture.deviceState[0].sql);
    expect(q).toContain("INSERT INTO device_state");
    // The device is resolved in the SAME statement, by the verbatim rid, and a system with no device
    // row inserts zero rows instead of throwing.
    expect(q).toContain("FROM devices d WHERE d.rid = $");
    // Conflict target is device_state's PK, not polling_status's unique index.
    expect(q).toContain("ON CONFLICT (device_id) DO UPDATE SET");
    expect(capture.deviceState[0].params).toContain(7);
  });

  it("anchors the atomic counters to device_state's OWN columns", async () => {
    // The bug this slice is most likely to ship: copying the polling_status `sql` templates verbatim
    // emits `polling_status.total_polls + 1` inside an INSERT INTO device_state, which either errors
    // or (worse) silently reads the wrong row.
    const { db, capture } = makeFakeDb();
    mockDb = db;

    await updatePollingStatusSuccess(7, null);
    await updatePollingStatusError(7, new Error("nope"));

    const [success, failure] = capture.deviceState.map((c) => flat(c.sql));

    expect(success).toContain("total_polls = device_state.total_polls + 1");
    expect(success).toContain(
      "successful_polls = device_state.successful_polls + 1",
    );
    expect(success).toContain("consecutive_errors = 0");

    expect(failure).toContain("total_polls = device_state.total_polls + 1");
    expect(failure).toContain(
      "consecutive_errors = device_state.consecutive_errors + 1",
    );
    // successful_polls is left untouched on the error path, exactly as in polling_status.
    expect(failure).not.toContain("successful_polls =");

    for (const q of [success, failure])
      expect(q).not.toContain("polling_status");
  });

  it("passes timestamps as UTC ISO strings with an explicit ::timestamp cast", async () => {
    // Handing node-pg a Date serialises it with the LOCAL utc offset; a `timestamp without time
    // zone` column then stores that wall clock verbatim — correct on Vercel (UTC), 10 hours out on
    // a Sydney laptop. Regression guard for exactly that.
    const { db, capture } = makeFakeDb();
    mockDb = db;

    const before = Date.now();
    await updatePollingStatusSuccess(7, null);
    const after = Date.now();

    const { sql: text, params } = capture.deviceState[0];
    expect(flat(text)).toContain("::timestamp");

    const stamps = params.filter(
      (p): p is string =>
        typeof p === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(p),
    );
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) {
      const t = Date.parse(s);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
    // No raw Date survives into the params — that is the failure mode being guarded.
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it('binds a null response as SQL NULL, not the string "null"', async () => {
    const { db, capture } = makeFakeDb();
    mockDb = db;

    await updatePollingStatusSuccess(7);

    const { sql: text, params } = capture.deviceState[0];
    expect(flat(text)).toContain("NULL::jsonb");
    expect(params).not.toContain("null");
  });

  it("serialises the response to jsonb exactly once", async () => {
    const { db, capture } = makeFakeDb();
    mockDb = db;

    await updatePollingStatusSuccess(7, { soc: 55 });

    const { params } = capture.deviceState[0];
    const json = params.filter(
      (p) => typeof p === "string" && p.startsWith("{"),
    );
    expect(json).toEqual([
      JSON.stringify({ soc: 55 }),
      JSON.stringify({ soc: 55 }),
    ]);
  });

  it("swallows a write failure instead of failing the poll", async () => {
    // LOG-BUT-DON'T-THROW: a throw here would make the caller treat the poll as failed and re-poll,
    // minting a duplicate session. Both entry points must hold that line.
    const { db } = makeFakeDb({ deviceState: true });
    mockDb = db;
    await expect(updatePollingStatusSuccess(7, null)).resolves.toBeUndefined();
    await expect(updatePollingStatusError(7, "boom")).resolves.toBeUndefined();
  });
});
