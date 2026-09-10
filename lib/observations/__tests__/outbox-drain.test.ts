/**
 * The relay drain loop — `drainOutbox`, the MAIN publish path.
 *
 * Until now nothing exercised it: `outbox.test.ts` mocks `@/lib/qstash` to `{ qstash: null }`
 * precisely so the drain takes its early return, and its own header says the claim→publish→mark
 * loop is "exercised against live Postgres in the soak, not mocked here". So the loop that
 * republishes every message the direct enqueue dropped had no test at all.
 *
 * What matters here is the LANE: the relay reads it out of the stored payload, so a replayed
 * backfill row must land back on the backfill lane and never on the live one.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { FakeQstash } from "./fake-qstash";
import type { QueueMessage } from "../types";

jest.mock("@/lib/db/planetscale/schema", () => ({ observationsOutbox: {} }));

/** Rows the fake transaction will hand out, one claim at a time. */
type Row = { id: number; payload: QueueMessage };
const state: {
  rows: Row[];
  updates: { id: number; set: Record<string, unknown> }[];
} = { rows: [], updates: [] };

jest.mock("@/lib/db/planetscale", () => {
  /** A builder whose every method returns itself, and which resolves to `value` when awaited. */
  const chain = (value: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(value).then(resolve),
    };
    for (const method of [
      "from",
      "where",
      "orderBy",
      "limit",
      "for",
      "set",
      "values",
      "onConflictDoNothing",
      "returning",
    ]) {
      self[method] = () => self;
    }
    return self;
  };

  const claimed = new Set<number>();
  let lastClaimedId = -1;
  let pendingSet: Record<string, unknown> = {};

  const tx = {
    // Hands back the oldest not-yet-claimed row, mirroring FOR UPDATE SKIP LOCKED.
    select: () => {
      const row = state.rows.find((r) => !claimed.has(r.id));
      if (row) {
        claimed.add(row.id);
        lastClaimedId = row.id;
      }
      return chain(row ? [row] : []);
    },
    update: () => {
      const self: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve([]).then(resolve),
        set: (values: Record<string, unknown>) => {
          pendingSet = values;
          return self;
        },
        where: () => {
          state.updates.push({ id: lastClaimedId, set: pendingSet });
          return self;
        },
      };
      return self;
    },
  };

  return {
    planetscaleDb: {
      transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> =>
        fn(tx),
      select: () => chain([{ backlog: 0 }]),
      delete: () => chain([]),
      __reset: () => {
        claimed.clear();
        lastClaimedId = -1;
        pendingSet = {};
      },
    },
  };
});

jest.mock("@/lib/qstash", () => {
  const actual = jest.requireActual("@/lib/qstash") as Record<string, unknown>;
  const { createFakeQstash } = jest.requireActual(
    "./fake-qstash",
  ) as typeof import("./fake-qstash");
  const instance = createFakeQstash();
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash =
    instance;
  return {
    ...actual,
    getObservationsReceiverUrl: () =>
      "https://example.test/api/observations/receive",
    qstash: instance.client,
  };
});

import { drainOutbox } from "../outbox";
import { planetscaleDb } from "@/lib/db/planetscale";

const fake = (): FakeQstash =>
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash;

function message(over: Partial<QueueMessage>): QueueMessage {
  return {
    env: "dev",
    systemId: 7,
    systemName: "Test System",
    batchTime: "2025-01-15T20:30:00+10:00",
    ...over,
  } as QueueMessage;
}

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  fake().published.length = 0;
  fake().failNext(0);
  (planetscaleDb as unknown as { __reset: () => void }).__reset();
});

describe("drainOutbox", () => {
  it("publishes each unpublished row and marks it published", async () => {
    state.rows = [
      { id: 1, payload: message({ lane: "live" }) },
      { id: 2, payload: message({ lane: "live" }) },
    ];

    const result = await drainOutbox(10);

    expect(result.claimed).toBe(2);
    expect(result.published).toBe(2);
    expect(result.failed).toBe(0);
    expect(fake().published).toHaveLength(2);
    for (const update of state.updates) {
      expect(update.set).toHaveProperty("publishedAt");
    }
  });

  it("replays a backfill row on the BACKFILL lane, from the stored payload", async () => {
    state.rows = [{ id: 1, payload: message({ lane: "backfill" }) }];
    await drainOutbox(10);

    expect(fake().published[0].request.flowControl).toMatchObject({
      key: "obs-dev.backfill",
    });
  });

  it("replays a PRE-LANE row on the live lane — the 30-day outbox tail needs no backfill", async () => {
    // A row written before `lane` existed: no field at all.
    state.rows = [{ id: 1, payload: message({}) }];
    await drainOutbox(10);

    expect(fake().published[0].request.flowControl).toMatchObject({
      key: "obs-dev.live",
    });
  });

  it("leaves a row unpublished, with the error recorded, when the publish rejects", async () => {
    state.rows = [{ id: 1, payload: message({ lane: "live" }) }];
    fake().failNext(1, new Error("qstash is down"));

    const result = await drainOutbox(10);

    expect(result.claimed).toBe(1);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(1);
    expect(state.updates[0].set).not.toHaveProperty("publishedAt");
    expect(String(state.updates[0].set.lastError)).toContain("qstash is down");
  });

  it("does not re-pick a row it already attempted this run", async () => {
    // The `seen` set is what stops a failing row spinning in a tight loop for the whole batch.
    state.rows = [{ id: 1, payload: message({ lane: "live" }) }];
    fake().failNext(1);

    const result = await drainOutbox(100);

    expect(result.claimed).toBe(1);
  });

  it("stops at the batch limit", async () => {
    state.rows = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      payload: message({ lane: "live" }),
    }));

    const result = await drainOutbox(3);

    expect(result.claimed).toBe(3);
    expect(fake().published).toHaveLength(3);
  });
});
