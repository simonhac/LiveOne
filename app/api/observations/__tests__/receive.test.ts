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
import { describe, it, expect } from "@jest/globals";
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
 *   db.transaction(fn) → fn(tx)
 *   tx.insert(table).values(...).onConflictDoNothing()/onConflictDoUpdate().returning()
 * Every insert pushes the resolved table name onto `order` so we can assert sequencing.
 */
function makeFakeDb() {
  const order: string[] = [];

  const chainAfterValues = {
    onConflictDoNothing: () => ({ returning: async () => [] }),
    onConflictDoUpdate: () => ({ returning: async () => [] }),
  };

  const tx = {
    insert(table: unknown) {
      order.push(tableName(table));
      return { values: () => chainAfterValues };
    },
  };

  const db = {
    async transaction<T>(fn: (txArg: typeof tx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  };

  // The helpers are typed against the real Db/Tx; the fake satisfies the runtime
  // contract used in processQueueMessage, so cast through unknown for the call.
  return { db, order };
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
