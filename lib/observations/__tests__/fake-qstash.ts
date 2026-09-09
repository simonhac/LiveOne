/**
 * A fake QStash client that records publishes instead of making them.
 *
 * Not a suite — jest's `testMatch` is `**​/__tests__/**​/*.test.ts`, so this file is a helper the
 * suites next to it import.
 *
 * Why it exists: before this, NOTHING in the repo mocked a *working* QStash client.
 * `outbox.test.ts` mocked `@/lib/qstash` to `{ qstash: null }` precisely so `drainOutbox` would take
 * its early return, which meant the drain loop's publish path had never been executed by a test.
 * The 2026-09-09 ingest outage was caused by the delivery options that path does (not) pass, so the
 * option set now needs a guard that fails loudly.
 */

export interface RecordedPublish {
  /** `queue` when published via `qstash.queue(...).enqueueJSON`, `flow` via `qstash.publishJSON`. */
  via: "queue" | "flow";
  /** The queue name, when `via === "queue"`. */
  queueName?: string;
  /** The full request object as the caller passed it — options included. */
  request: Record<string, unknown>;
}

/** What the fake's flow-control plane reports for one key, and what the tests assert against. */
export interface FakeFlowState {
  waitListSize: number;
  parallelismMax: number;
  parallelismCount: number;
  isPaused: boolean;
  isPinnedParallelism: boolean;
}

/** Every flow-control WRITE, in order. `pin`/`unpin` are the trap-guard assertions. */
export interface RecordedFlowCall {
  op: "pin" | "unpin" | "pause" | "resume";
  key: string;
  options?: unknown;
}

export interface FakeQstash {
  /** Every publish, in order, whichever transport was used. */
  published: RecordedPublish[];
  /** Every flow-control write, in order. */
  flowCalls: RecordedFlowCall[];
  /** Every legacy-queue `upsert`, in order. */
  queueUpserts: Record<string, unknown>[];
  /** Seed (or clear) the flow-control state a key reports. Absent ⇒ `get` throws a 404. */
  setFlow(key: string, state: FakeFlowState | null): void;
  /** Make `flowControl.get(key)` reject with something OTHER than a 404. */
  failFlowGet(key: string, error: Error | null): void;
  /** Seed (or clear) the legacy queue. Absent ⇒ `get` throws a 404. */
  setQueue(
    state: { paused: boolean; lag: number; parallelism: number } | null,
  ): void;
  /** Make the next `n` publishes reject, to exercise the failure paths. */
  failNext(n: number, error?: Error): void;
  /** Stands in for the `qstash` export of `@/lib/qstash`. */
  client: {
    queue(args: { queueName: string }): {
      enqueueJSON(
        request: Record<string, unknown>,
      ): Promise<{ messageId: string }>;
      get(): Promise<{ paused: boolean; lag: number; parallelism: number }>;
      upsert(patch: Record<string, unknown>): Promise<void>;
    };
    flowControl: {
      get(key: string): Promise<FakeFlowState & { flowControlKey: string }>;
      getGlobalParallelism(): Promise<{
        parallelismMax: number;
        parallelismCount: number;
      }>;
      pin(key: string, options: unknown): Promise<void>;
      unpin(key: string, options: unknown): Promise<void>;
      pause(key: string): Promise<void>;
      resume(key: string): Promise<void>;
    };
    publishJSON(
      request: Record<string, unknown>,
    ): Promise<{ messageId: string }>;
    http: { request: (args: unknown) => Promise<unknown> };
    dlq: {
      listMessages: (args?: unknown) => Promise<{ messages: unknown[] }>;
      delete: (id: unknown) => Promise<{ deleted: number }>;
    };
  };
}

/** The 404 the real SDK throws — `QstashError` carries `status`, which is what we branch on. */
function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { status: 404 });
}

export function createFakeQstash(): FakeQstash {
  const published: RecordedPublish[] = [];
  const flowCalls: RecordedFlowCall[] = [];
  const queueUpserts: Record<string, unknown>[] = [];
  const flow = new Map<string, FakeFlowState>();
  const flowGetErrors = new Map<string, Error>();
  let queueState: { paused: boolean; lag: number; parallelism: number } | null =
    null;
  let failures = 0;
  let failureError = new Error("fake qstash publish failure");

  const record = async (
    entry: RecordedPublish,
  ): Promise<{ messageId: string }> => {
    if (failures > 0) {
      failures--;
      throw failureError;
    }
    published.push(entry);
    return { messageId: `fake-${published.length}` };
  };

  return {
    published,
    flowCalls,
    queueUpserts,
    setFlow(key, state): void {
      if (state) flow.set(key, state);
      else flow.delete(key);
    },
    failFlowGet(key, error): void {
      if (error) flowGetErrors.set(key, error);
      else flowGetErrors.delete(key);
    },
    setQueue(state): void {
      queueState = state;
    },
    failNext(n: number, error?: Error): void {
      failures = n;
      if (error) failureError = error;
    },
    client: {
      queue({ queueName }) {
        return {
          enqueueJSON: (request) =>
            record({ via: "queue", queueName, request }),
          get: async () => {
            if (!queueState) throw notFound(`queue ${queueName}`);
            return queueState;
          },
          upsert: async (patch) => {
            queueUpserts.push(patch);
            queueState = {
              ...(queueState ?? { paused: false, lag: 0, parallelism: 1 }),
              ...(patch as object),
            };
          },
        };
      },
      flowControl: {
        get: async (key) => {
          const boom = flowGetErrors.get(key);
          if (boom) throw boom;
          const state = flow.get(key);
          // 🛑 A key with nothing waiting, nothing in flight and no pin may not exist AT ALL — the
          // property the aggregate must not read as "0 lanes, healthy".
          if (!state) throw notFound(`flow control key ${key}`);
          return { flowControlKey: key, ...state };
        },
        getGlobalParallelism: async () => ({
          parallelismMax: 100,
          parallelismCount: [...flow.values()].reduce(
            (n, s) => n + s.parallelismCount,
            0,
          ),
        }),
        pin: async (key, options) => {
          flowCalls.push({ op: "pin", key, options });
          const state = flow.get(key);
          if (state)
            flow.set(key, {
              ...state,
              isPinnedParallelism: true,
              parallelismMax:
                (options as { parallelism?: number }).parallelism ??
                state.parallelismMax,
            });
        },
        unpin: async (key, options) => {
          flowCalls.push({ op: "unpin", key, options });
          const state = flow.get(key);
          if (state) flow.set(key, { ...state, isPinnedParallelism: false });
        },
        pause: async (key) => {
          flowCalls.push({ op: "pause", key });
          const state = flow.get(key);
          if (state) flow.set(key, { ...state, isPaused: true });
        },
        resume: async (key) => {
          flowCalls.push({ op: "resume", key });
          const state = flow.get(key);
          if (state) flow.set(key, { ...state, isPaused: false });
        },
      },
      publishJSON: (request) => record({ via: "flow", request }),
      http: { request: async () => [] },
      dlq: {
        listMessages: async () => ({ messages: [] }),
        delete: async () => ({ deleted: 0 }),
      },
    },
  };
}
