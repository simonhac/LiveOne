/**
 * Unit tests for the QStash observations receiver's message processor.
 *
 * PR-7b: a poll's session + readings are co-enqueued in ONE message and a Postgres
 * FK point_readings.session_id → sessions.id is coming, so the receiver must insert
 * the SESSION FIRST and the readings AFTER, all in a SINGLE transaction. These tests
 * pin that ordering and confirm dual-shape tolerance (session-only / observations-only
 * / combined) during the rollout where old and new message shapes coexist.
 *
 * `processQueueMessage` is internal to a Next.js route file (route modules may only
 * export the recognised route fields), so it is exposed for tests as a non-enumerable
 * `__processQueueMessage` property on the POST export — see route.ts.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";
import {
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
  sessions,
} from "@/lib/db/planetscale/schema";
import type {
  QueueMessage,
  Observation,
  Session,
} from "@/lib/observations/types";
import type { WithProcessQueueMessage } from "../receive/route";

// The route's POST export calls verifySignatureAppRouter() at module-load time,
// which throws unless a QStash signing key is present. Provide dummy keys BEFORE the
// route module is evaluated, then load it via require() (ES imports would hoist above
// these assignments). We never exercise the signed HTTP path — only the internal
// processQueueMessage attached to POST — so the dummy keys are inert.
process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY ??= "test-current-key";
process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY ??= "test-next-key";

const { POST } = require("../receive/route") as {
  POST: WithProcessQueueMessage;
};

// Pull the internal processor off the POST export (attached by route.ts for tests).
const processQueueMessage = POST.__processQueueMessage;

/** Map an imported schema table back to a stable label for the order log. */
function tableName(table: unknown): string {
  if (table === sessions) return "sessions";
  if (table === pointReadings) return "point_readings";
  if (table === pointReadingsAgg5m) return "point_readings_agg_5m";
  if (table === pointReadingsAgg1d) return "point_readings_agg_1d";
  return "unknown";
}

/**
 * Build a fake `db` matching the slice of the drizzle node-postgres surface that
 * processQueueMessage touches:
 *   db.select({...}).from(systems).where(...).limit(1) → [{ vendorType }]   (5m-native lookup)
 *   db.transaction(fn) → fn(tx)
 *   tx.insert(table).values(...).onConflictDoNothing()/onConflictDoUpdate().returning()
 * Every insert pushes the resolved table name onto `order` (sequencing) and records which
 * conflict mode was used per table in `inserts` (so we can assert upsert-vs-do-nothing).
 *
 * `opts.vendorType` drives the 5m-native classification (defaults to a raw vendor so existing
 * tests keep first-write-wins 5m behavior).
 */
function makeFakeDb(opts?: { vendorType?: string }) {
  const order: string[] = [];
  const inserts: { table: string; conflict: "nothing" | "update" | null }[] =
    [];

  const tx = {
    insert(table: unknown) {
      const name = tableName(table);
      order.push(name);
      const rec: { table: string; conflict: "nothing" | "update" | null } = {
        table: name,
        conflict: null,
      };
      inserts.push(rec);
      return {
        values: () => ({
          onConflictDoNothing: () => {
            rec.conflict = "nothing";
            return { returning: async () => [] };
          },
          onConflictDoUpdate: () => {
            rec.conflict = "update";
            return { returning: async () => [] };
          },
        }),
      };
    },
  };

  const db = {
    // 5m-native vendor lookup (isSystemFiveMinuteNative): resolves to one row.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { vendorType: opts?.vendorType ?? "selectronic" },
          ],
        }),
      }),
    }),
    async transaction<T>(fn: (txArg: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  };

  // The helpers are typed against the real Db/Tx; the fake satisfies the runtime
  // contract used in processQueueMessage, so cast through unknown for the call.
  return { db, order, inserts };
}

/** The conflict mode recorded for the first insert into the given table, or undefined. */
function conflictFor(
  inserts: { table: string; conflict: "nothing" | "update" | null }[],
  table: string,
): "nothing" | "update" | null | undefined {
  return inserts.find((i) => i.table === table)?.conflict;
}

const SESSION: Session = {
  sessionId: "0192f000-0000-7000-8000-000000000001",
  sessionLabel: "test-label",
  cause: "CRON",
  started: "2025-01-15T20:30:00+10:00",
  durationMs: 1234,
  successful: true,
  errorCode: null,
  error: null,
  response: null,
  numRows: 1,
  startTime: "2025-01-15T20:30:00+10:00",
};

/** A raw observation with a resolvable pointId via debug.reference "1.0". */
function rawObs(): Observation {
  return {
    sessionId: SESSION.sessionId,
    topic: "liveone/select.live/SITE/power",
    measurementTime: "2025-01-15T20:30:00+10:00",
    receivedTime: "2025-01-15T20:30:01+10:00",
    value: 42,
    interval: "raw",
    debug: {
      type: "power",
      unit: "W",
      pointName: "Power",
      reference: "1.0",
    },
  };
}

function makeMessage(over: Partial<QueueMessage>): QueueMessage {
  return {
    env: "dev",
    systemId: 1,
    systemName: "Test System",
    batchTime: "2025-01-15T20:30:00+10:00",
    ...over,
  };
}

const run = (db: { transaction: unknown }, msg: QueueMessage) =>
  processQueueMessage(
    db as unknown as Parameters<typeof processQueueMessage>[0],
    msg,
  );

describe("processQueueMessage (receiver transaction + dual-shape)", () => {
  it("inserts the session BEFORE the readings for a combined message", async () => {
    const { db, order } = makeFakeDb();

    const stats = await run(
      db,
      makeMessage({ session: SESSION, observations: [rawObs()] }),
    );

    // Session must be written first so readings can reference it (future FK).
    const sessionIdx = order.indexOf("sessions");
    const readingsIdx = order.indexOf("point_readings");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(readingsIdx).toBeGreaterThanOrEqual(0);
    expect(sessionIdx).toBeLessThan(readingsIdx);

    expect(stats.sessionInserted).toBe(1);
  });

  it("handles a session-only message without error", async () => {
    const { db, order } = makeFakeDb();

    const stats = await run(db, makeMessage({ session: SESSION }));

    expect(order).toEqual(["sessions"]);
    expect(stats.sessionInserted).toBe(1);
    expect(stats.rawInserted).toBeUndefined();
  });

  it("handles an observations-only message without error", async () => {
    const { db, order } = makeFakeDb();

    const stats = await run(db, makeMessage({ observations: [rawObs()] }));

    expect(order).toEqual(["point_readings"]);
    expect(stats.sessionInserted).toBeUndefined();
    expect(stats.rawInserted).toBe(0); // fake returning() yields []
  });

  it("routes raw / 5m / 1d observations to their tables, session first", async () => {
    const { db, order } = makeFakeDb();

    const agg = {
      avg: 1,
      min: 0,
      max: 2,
      last: 1,
      delta: null,
      valueStr: null,
      sampleCount: 3,
      errorCount: 0,
      dataQuality: "good",
    };
    const obs5m: Observation = { ...rawObs(), interval: "5m", agg };
    const obs1d: Observation = { ...rawObs(), interval: "1d", agg };

    await run(
      db,
      makeMessage({
        session: SESSION,
        observations: [rawObs(), obs5m, obs1d],
      }),
    );

    expect(order[0]).toBe("sessions");
    expect(order).toContain("point_readings");
    expect(order).toContain("point_readings_agg_5m");
    expect(order).toContain("point_readings_agg_1d");
    // Every reading table comes after the session insert.
    expect(order.indexOf("sessions")).toBeLessThan(
      order.indexOf("point_readings"),
    );
    expect(order.indexOf("sessions")).toBeLessThan(
      order.indexOf("point_readings_agg_5m"),
    );
    expect(order.indexOf("sessions")).toBeLessThan(
      order.indexOf("point_readings_agg_1d"),
    );
  });
});

describe("processQueueMessage (5m conflict mode depends on vendor)", () => {
  const agg = {
    avg: 1,
    min: 0,
    max: 2,
    last: 1,
    delta: null,
    valueStr: null,
    sampleCount: 3,
    errorCount: 0,
    dataQuality: "good",
  };
  const obs5m = (systemId: number): Observation => ({
    ...rawObs(),
    interval: "5m",
    agg,
    debug: { ...rawObs().debug!, reference: `${systemId}.0` },
  });

  // Distinct systemIds per case: isSystemFiveMinuteNative caches by systemId across the module,
  // so each case uses its own id to stay hermetic from the other describe block (systemId=1).

  it("UPSERTS 5m for a 5m-native vendor (Amber) so late refinements heal", async () => {
    const { db, inserts } = makeFakeDb({ vendorType: "amber" });

    await run(db, makeMessage({ systemId: 9, observations: [obs5m(9)] }));

    // 5m-native: the queue copy is authoritative; a re-published refinement must overwrite.
    expect(conflictFor(inserts, "point_readings_agg_5m")).toBe("update");
  });

  it("keeps 5m first-write-wins for a raw vendor (PG recompute owns it)", async () => {
    const { db, inserts } = makeFakeDb({ vendorType: "selectronic" });

    await run(db, makeMessage({ systemId: 2, observations: [obs5m(2)] }));

    expect(conflictFor(inserts, "point_readings_agg_5m")).toBe("nothing");
    // Raw readings always first-write-wins; 1d always upserts (re-computable as late data lands).
  });

  it("raw point_readings stay do-nothing and 1d stays upsert regardless of vendor", async () => {
    const { db, inserts } = makeFakeDb({ vendorType: "amber" });

    const obs1d: Observation = { ...rawObs(), interval: "1d", agg };
    await run(
      db,
      makeMessage({ systemId: 9, observations: [rawObs(), obs1d] }),
    );

    expect(conflictFor(inserts, "point_readings")).toBe("nothing");
    expect(conflictFor(inserts, "point_readings_agg_1d")).toBe("update");
  });
});

/**
 * PR-13: with AGG_COMPUTE_IN_PG on, PG self-computes raw-vendor 5m + 1d from its own data, so the
 * receiver must STOP intaking raw-vendor 5m and any 1d (stragglers logged + dropped, never erroring)
 * while KEEPING raw, sessions, and 5m-native 5m flowing.
 *
 * The flag is read ONCE at module load from lib/db/routing.ts, so we load a FRESH copy of the route
 * (and the schema it inserts into) inside a `jest.isolateModules` registry with the env var set, then
 * compare insert targets against THAT registry's schema objects (the top-level imports belong to the
 * default registry and would never `===` the isolated ones).
 */
describe("processQueueMessage (AGG_COMPUTE_IN_PG on: trims raw-vendor 5m + 1d intake)", () => {
  const agg = {
    avg: 1,
    min: 0,
    max: 2,
    last: 1,
    delta: null,
    valueStr: null,
    sampleCount: 3,
    errorCount: 0,
    dataQuality: "good",
  };

  afterEach(() => {
    delete process.env.AGG_COMPUTE_IN_PG;
    jest.resetModules();
  });

  /**
   * Load the route + schema fresh with AGG_COMPUTE_IN_PG=true, build a fake db whose table labels are
   * resolved against the isolated registry's schema, run one message, and return the order/inserts log.
   */
  function runWithAggInPg(
    over: Partial<QueueMessage>,
    opts?: { vendorType?: string },
  ) {
    process.env.AGG_COMPUTE_IN_PG = "true";
    process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY ??= "test-current-key";
    process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY ??= "test-next-key";

    let result!: {
      order: string[];
      inserts: { table: string; conflict: "nothing" | "update" | null }[];
      stats: Record<string, number>;
    };

    jest.isolateModules(() => {
      const schema = require("@/lib/db/planetscale/schema");
      const route = require("../receive/route") as {
        POST: WithProcessQueueMessage;
      };
      const proc = route.POST.__processQueueMessage;

      const localTableName = (table: unknown): string => {
        if (table === schema.sessions) return "sessions";
        if (table === schema.pointReadings) return "point_readings";
        if (table === schema.pointReadingsAgg5m) return "point_readings_agg_5m";
        if (table === schema.pointReadingsAgg1d) return "point_readings_agg_1d";
        return "unknown";
      };

      const order: string[] = [];
      const inserts: {
        table: string;
        conflict: "nothing" | "update" | null;
      }[] = [];
      const tx = {
        insert(table: unknown) {
          const name = localTableName(table);
          order.push(name);
          const rec: {
            table: string;
            conflict: "nothing" | "update" | null;
          } = { table: name, conflict: null };
          inserts.push(rec);
          return {
            values: () => ({
              onConflictDoNothing: () => {
                rec.conflict = "nothing";
                return { returning: async () => [] };
              },
              onConflictDoUpdate: () => {
                rec.conflict = "update";
                return { returning: async () => [] };
              },
            }),
          };
        },
      };
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                { vendorType: opts?.vendorType ?? "selectronic" },
              ],
            }),
          }),
        }),
        async transaction<T>(fn: (txArg: typeof tx) => Promise<T>): Promise<T> {
          return fn(tx);
        },
      };

      const msg = makeMessage(over);
      // proc returns a promise; resolve it synchronously within isolateModules by capturing it.
      result = { order, inserts, stats: {} };
      // Kick off the async work and stash the promise for the caller to await.
      (result as { promise?: Promise<void> }).promise = (async () => {
        result.stats = await proc(
          db as unknown as Parameters<typeof proc>[0],
          msg,
        );
      })();
    });

    return (async () => {
      await (result as { promise?: Promise<void> }).promise;
      return result;
    })();
  }

  it("skips raw-vendor 5m insert (logging no-op), still inserts raw + session", async () => {
    const obs5m: Observation = { ...rawObs(), interval: "5m", agg };
    const { order, inserts, stats } = await runWithAggInPg(
      { systemId: 2, session: SESSION, observations: [rawObs(), obs5m] },
      { vendorType: "selectronic" },
    );

    // Raw + session still land.
    expect(order).toContain("point_readings");
    expect(order).toContain("sessions");
    expect(conflictFor(inserts, "point_readings")).toBe("nothing");
    // Raw-vendor 5m was a no-op: no agg_5m insert attempted.
    expect(order).not.toContain("point_readings_agg_5m");
    expect(stats.agg5mInserted).toBe(0);
  });

  it("skips 1d insert (logging no-op) without erroring on a straggler", async () => {
    const obs1d: Observation = { ...rawObs(), interval: "1d", agg };
    const { order, stats } = await runWithAggInPg(
      { systemId: 3, observations: [rawObs(), obs1d] },
      { vendorType: "selectronic" },
    );

    expect(order).toContain("point_readings"); // raw still flows
    expect(order).not.toContain("point_readings_agg_1d");
    expect(stats.agg1dUpserted).toBe(0);
  });

  it("STILL upserts 5m-native (Amber) 5m even with the flag on", async () => {
    const obs5m: Observation = {
      ...rawObs(),
      interval: "5m",
      agg,
      debug: { ...rawObs().debug!, reference: "9.0" },
    };
    const { order, inserts, stats } = await runWithAggInPg(
      { systemId: 9, observations: [obs5m] },
      { vendorType: "amber" },
    );

    // 5m-native has no raw + no recompute → the queue copy IS the value; must upsert.
    expect(order).toContain("point_readings_agg_5m");
    expect(conflictFor(inserts, "point_readings_agg_5m")).toBe("update");
    expect(stats.agg5mInserted).toBe(0); // fake returning() yields []
  });
});
