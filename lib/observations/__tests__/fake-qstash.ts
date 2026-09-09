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

export interface FakeQstash {
  /** Every publish, in order, whichever transport was used. */
  published: RecordedPublish[];
  /** Make the next `n` publishes reject, to exercise the failure paths. */
  failNext(n: number, error?: Error): void;
  /** Stands in for the `qstash` export of `@/lib/qstash`. */
  client: {
    queue(args: { queueName: string }): {
      enqueueJSON(
        request: Record<string, unknown>,
      ): Promise<{ messageId: string }>;
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

export function createFakeQstash(): FakeQstash {
  const published: RecordedPublish[] = [];
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
    failNext(n: number, error?: Error): void {
      failures = n;
      if (error) failureError = error;
    },
    client: {
      queue({ queueName }) {
        return {
          enqueueJSON: (request) =>
            record({ via: "queue", queueName, request }),
        };
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
