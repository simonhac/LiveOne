/**
 * Phase 4 outbox — unit tests.
 *
 * Covers the pure message→row mapping (`buildOutboxRows`) and the best-effort
 * guard contracts: `persistOutbox` / `drainOutbox` must never throw and must
 * cleanly no-op when Postgres / QStash aren't configured (so a poll or the relay
 * cron is never broken by the outbox). The end-to-end claim→publish→mark drain
 * loop is exercised against live Postgres in the soak (see the migration doc's
 * Phase 4 verification), not mocked here.
 *
 * The flag/clients are read at module load, so the heavy DB + queue modules are
 * mocked to the "unconfigured" shape before importing the unit under test.
 */
import { describe, it, expect, jest } from "@jest/globals";
import type { QueueMessage } from "../types";

// Unconfigured Postgres + QStash → persist/drain take their early-return paths.
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));
jest.mock("@/lib/db/planetscale/schema", () => ({ observationsOutbox: {} }));
jest.mock("@/lib/qstash", () => ({
  qstash: null,
  OBSERVATIONS_QUEUE_NAME: "observations-test",
  getObservationsReceiverUrl: () =>
    "https://example.test/api/observations/receive",
}));

import { buildOutboxRows, persistOutbox, drainOutbox } from "../outbox";

function msg(systemId: number, sessionId: string | null): QueueMessage {
  return {
    env: "dev",
    systemId,
    systemName: `System ${systemId}`,
    batchTime: "2025-01-15T20:30:00.000+10:00",
    observations: [],
    ...(sessionId
      ? {
          session: {
            sessionId,
            sessionLabel: null,
            cause: "CRON",
            started: "2025-01-15T20:30:00+10:00",
            durationMs: 1,
            successful: true,
            errorCode: null,
            error: null,
            response: null,
            numRows: 0,
            startTime: "2025-01-15T20:30:00+10:00",
          },
        }
      : {}),
  } as QueueMessage;
}

describe("buildOutboxRows", () => {
  it("maps systemId, session id, seq and the full payload per chunk", () => {
    const messages = [msg(7, "sess-a"), msg(7, "sess-a")];
    const rows = buildOutboxRows(messages);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ systemId: 7, sessionId: "sess-a", seq: 0 });
    expect(rows[1]).toMatchObject({ systemId: 7, sessionId: "sess-a", seq: 1 });
    // Payload is the message verbatim (republished by the relay).
    expect(rows[0].payload).toBe(messages[0]);
    expect(rows[1].payload).toBe(messages[1]);
  });

  it("records a null session_id for the no-session (publishObservationBatch) path", () => {
    const [row] = buildOutboxRows([msg(3, null)]);
    expect(row.sessionId).toBeNull();
    expect(row.seq).toBe(0);
  });

  it("returns nothing for an empty message list", () => {
    expect(buildOutboxRows([])).toEqual([]);
  });
});

describe("persistOutbox (best-effort)", () => {
  it("no-ops on an empty list", async () => {
    await expect(persistOutbox([])).resolves.toBeUndefined();
  });

  it("no-ops (never throws) when Postgres is not configured", async () => {
    await expect(persistOutbox([msg(1, "s")])).resolves.toBeUndefined();
  });
});

describe("drainOutbox (best-effort)", () => {
  it("returns an empty result (never throws) when Postgres/QStash are unconfigured", async () => {
    await expect(drainOutbox()).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      backlog: 0,
      gced: 0,
    });
  });
});
