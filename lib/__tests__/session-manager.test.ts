import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Mock the Turso client: createSession does `db.insert(sessions).values(record)`.
jest.mock("@/lib/db/turso", () => {
  const values = jest.fn(async () => undefined);
  return { db: { insert: jest.fn(() => ({ values })) } };
});

// Reads are served from Postgres; null client exercises the graceful-degrade path
// and keeps this a pure unit test (no DB connection).
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));

// Session publishing is out of scope here.
jest.mock("@/lib/observations/session-publisher", () => ({
  buildSessionPayload: jest.fn(() => ({})),
}));

import { sessionManager } from "@/lib/session-manager";
import { db } from "@/lib/db/turso";

// Canonical UUIDv7: version nibble 7, variant nibble in [8..b].
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lastInsertedRecord(): any {
  const insertMock = db.insert as unknown as jest.Mock;
  const call = insertMock.mock.results[insertMock.mock.results.length - 1];
  const valuesFn = (call.value as { values: jest.Mock }).values;
  return valuesFn.mock.calls[valuesFn.mock.calls.length - 1][0];
}

describe("SessionManager.createSession (UUIDv7 / text id)", () => {
  beforeEach(() => {
    (db.insert as unknown as jest.Mock).mockClear();
  });

  it("mints a UUIDv7 text id and persists it explicitly (no autoincrement)", async () => {
    const result = await sessionManager.createSession({
      systemId: 1,
      cause: "CRON",
      started: new Date(),
    });

    expect(typeof result.id).toBe("string");
    expect(result.id).toMatch(UUIDV7_RE);

    // The exact same id is written to the row — proves we no longer depend on a
    // Turso autoincrement / .returning() round-trip.
    const inserted = lastInsertedRecord();
    expect(inserted.id).toBe(result.id);
    expect(inserted.systemId).toBe(1);
  });

  it("mints distinct, lexicographically time-ordered ids", async () => {
    const a = await sessionManager.createSession({
      systemId: 1,
      cause: "CRON",
      started: new Date(),
    });
    const b = await sessionManager.createSession({
      systemId: 1,
      cause: "CRON",
      started: new Date(),
    });
    expect(a.id).not.toBe(b.id);
    // UUIDv7 is time-ordered as text — later id sorts after the earlier one.
    expect(a.id < b.id).toBe(true);
  });
});

describe("SessionManager reads (Postgres) — graceful degrade", () => {
  it("returns empty/null when Postgres is unconfigured", async () => {
    expect(await sessionManager.getSessionById("anything")).toBeNull();
    expect(await sessionManager.getLastSessions(10)).toEqual({
      sessions: [],
      count: 0,
    });
  });
});
