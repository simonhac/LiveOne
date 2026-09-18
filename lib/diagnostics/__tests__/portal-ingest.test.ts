import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { ingestPortalEvents } from "../store";
import type { PortalEvent } from "@/lib/vendors/selectronic/portal-events";

/**
 * A stub that answers the one SELECT (what we already store) and records every INSERT, so the
 * TRANSITIONS can be asserted without a database. Transitions are the whole point of this function:
 * the portal returns its entire retained page on every poll, so "what changed" has to be computed
 * against what we hold, not against what the page says.
 */
function stubDb(
  existing: { dedupeKey: string; clearedTimeText: string | null }[],
) {
  const inserted: Record<string, unknown>[] = [];
  /** How many INSERT statements were issued — the page is upserted in one, not one per row. */
  let statements = 0;
  const insertBuilder: Record<string, unknown> = {};
  insertBuilder.values = (
    v: Record<string, unknown> | Record<string, unknown>[],
  ) => {
    statements++;
    inserted.push(...(Array.isArray(v) ? v : [v]));
    return insertBuilder;
  };
  insertBuilder.onConflictDoUpdate = () => insertBuilder;
  insertBuilder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve([]).then(resolve);

  const selectBuilder: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"])
    selectBuilder[m] = () => selectBuilder;
  selectBuilder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(existing).then(resolve);

  return {
    db: {
      select: () => selectBuilder,
      insert: () => insertBuilder,
    },
    inserted,
    statementCount: () => statements,
  };
}

const TZ = "Australia/Melbourne";
const OBSERVED = new Date("2026-09-18T02:00:00Z");

const event = (over: Partial<PortalEvent> = {}): PortalEvent => ({
  code: 50,
  description: "Unit - Instant Low DC Voltage Fault",
  createdText: "2026-09-18 11:53:00",
  clearedText: "",
  createdAt: new Date("2026-09-18T01:53:00Z"),
  clearedAt: null,
  active: true,
  statusClass: "",
  statusInconsistent: false,
  dedupeKey: "p:50:2026-09-18 11:53:00",
  ...over,
});

const mockDb = jest.mocked(requirePlanetscaleDb);
beforeEach(() => {
  jest.clearAllMocks();
});

describe("ingestPortalEvents", () => {
  it("baselines a device's existing history WITHOUT triggering on old cleared faults", async () => {
    // First ever ingest. The page retains months of history; firing an acquisition for each of them
    // would open a dozen inverter sessions to learn nothing.
    const { db, inserted } = stubDb([]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(
      1,
      [
        event({
          dedupeKey: "p:12:2026-06-13 20:07:00",
          code: 12,
          createdText: "2026-06-13 20:07:00",
          clearedText: "2026-06-14 06:24:24",
          active: false,
        }),
        event({
          dedupeKey: "p:50:2026-09-17 19:53:00",
          createdText: "2026-09-17 19:53:00",
          clearedText: "2026-09-17 21:14:02",
          active: false,
        }),
      ],
      TZ,
      OBSERVED,
    );
    expect(result.baseline).toBe(true);
    expect(result.inserted).toBe(2);
    expect(result.reasons).toEqual([]);
    // …but every row is still STORED. Baselining suppresses the trigger, not the retention.
    expect(inserted).toHaveLength(2);
  });

  it("upserts the whole page in ONE statement", async () => {
    // The page returns its entire retained list every minute and is almost always unchanged. One
    // round trip per row spent the minutely poll's budget writing nothing.
    const { db, inserted, statementCount } = stubDb([]);
    mockDb.mockReturnValue(db as never);
    await ingestPortalEvents(
      1,
      [
        event(),
        event({ dedupeKey: "p:12:a", code: 12, createdText: "a" }),
        event({ dedupeKey: "p:13:b", code: 13, createdText: "b" }),
      ],
      TZ,
      OBSERVED,
    );
    expect(inserted).toHaveLength(3);
    expect(statementCount()).toBe(1);
  });

  it("writes through a supplied transaction rather than the pool", async () => {
    // Retention and enqueue are one unit: storing the row CONSUMES the transition, so a failure
    // between them would lose the acquisition request silently and for ever.
    const { db: pool } = stubDb([]);
    const { db: tx, inserted: txRows } = stubDb([]);
    mockDb.mockReturnValue(pool as never);
    await ingestPortalEvents(1, [event()], TZ, OBSERVED, tx as never);
    expect(txRows).toHaveLength(1);
  });

  it("captures a fault that is ACTIVE on the first run", async () => {
    const { db } = stubDb([]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(1, [event()], TZ, OBSERVED);
    expect(result.baseline).toBe(true);
    expect(result.reasons.map((r) => r.kind)).toEqual(["portal-event-new"]);
  });

  it("triggers on a newly observed fault", async () => {
    const { db } = stubDb([
      {
        dedupeKey: "p:12:2026-06-13 20:07:00",
        clearedTimeText: "2026-06-14 06:24:24",
      },
    ]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(1, [event()], TZ, OBSERVED);
    expect(result.inserted).toBe(1);
    expect(result.reasons[0].kind).toBe("portal-event-new");
    expect(result.reasons[0].detail).toContain("active");
  });

  it("triggers on one discovered ALREADY cleared — we never saw it live", async () => {
    // The inverter's own log is then the only remaining account of it.
    const { db } = stubDb([
      { dedupeKey: "p:12:2026-06-13 20:07:00", clearedTimeText: "" },
    ]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(
      1,
      [event({ clearedText: "2026-09-18 12:12:59", active: false })],
      TZ,
      OBSERVED,
    );
    expect(result.reasons[0].detail).toContain("already cleared");
  });

  it("triggers when a fault we held as ACTIVE acquires a clearance", async () => {
    const { db } = stubDb([
      { dedupeKey: "p:50:2026-09-18 11:53:00", clearedTimeText: "" },
    ]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(
      1,
      [event({ clearedText: "2026-09-18 12:12:59", active: false })],
      TZ,
      OBSERVED,
    );
    expect(result.cleared).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.reasons.map((r) => r.kind)).toEqual(["portal-event-cleared"]);
  });

  it("is idempotent: re-reading an unchanged page triggers nothing", async () => {
    // The page returns its whole retained list every minute. Without this the worker would open an
    // inverter session once a minute, for ever.
    const { db } = stubDb([
      {
        dedupeKey: "p:50:2026-09-18 11:53:00",
        clearedTimeText: "2026-09-18 12:12:59",
      },
    ]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(
      1,
      [event({ clearedText: "2026-09-18 12:12:59", active: false })],
      TZ,
      OBSERVED,
    );
    expect(result).toMatchObject({ inserted: 0, cleared: 0, reasons: [] });
  });

  it("stores the portal's own comms event but never triggers on it", async () => {
    // Code 1001 describes OUR link to the portal, not the plant.
    const { db, inserted } = stubDb([
      { dedupeKey: "p:50:x", clearedTimeText: "" },
    ]);
    mockDb.mockReturnValue(db as never);
    const result = await ingestPortalEvents(
      1,
      [
        event({
          code: 1001,
          description:
            "Lost Communication - no updates for more than 24 hours.",
          dedupeKey: "p:1001:2025-09-16 16:45:02",
          createdText: "2025-09-16 16:45:02",
        }),
      ],
      TZ,
      OBSERVED,
    );
    expect(inserted).toHaveLength(1);
    expect(result.reasons).toEqual([]);
    expect(result.inserted).toBe(0);
  });

  it("writes Created as the occurrence and keeps the source text verbatim", async () => {
    const { db, inserted } = stubDb([]);
    mockDb.mockReturnValue(db as never);
    await ingestPortalEvents(1, [event()], TZ, OBSERVED);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      source: "portal",
      logType: null,
      sourceTimeText: "2026-09-18 11:53:00",
      sourceTimezone: TZ,
      occurredAt: new Date("2026-09-18T01:53:00Z"),
      observedAt: OBSERVED,
      dedupeKey: "p:50:2026-09-18 11:53:00",
    });
  });
});
