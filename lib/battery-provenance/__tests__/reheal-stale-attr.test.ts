import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { parseDate } from "@internationalized/date";

// rehealStaleAttrDays fans out to the PG db + the prod-driver recompute + (unused here) the learn /
// logical-system enumeration. Mock all the heavy collaborators so we can drive the grouping/windowing/cap
// deterministically. The WHERE predicate (day < ceiling; finalized_at IS NULL OR version < V) is a SQL
// concern verified in the dev integration step — the fake db returns the rows the WHERE would produce.
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: jest.fn(),
}));
jest.mock("@/lib/db/planetscale/battery-provenance-daily-pg", () => ({
  learnAllForHandle: jest.fn(),
}));
jest.mock("@/lib/aggregation/logical-system", () => ({
  listCompleteLogicalSystems: jest.fn(),
}));
jest.mock("@/lib/db/planetscale/battery-provenance-pg", () => ({
  FLOW_ATTR_VERSION: 1,
  SETTLEMENT_WINDOW_MS: 72 * 60 * 60 * 1000,
  recomputeBatteryProvenanceForWindowBestEffort: jest.fn(),
  reconcileFromCheckpointBestEffort: jest.fn(),
}));

import { rehealStaleAttrDays } from "../recompute";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { recomputeBatteryProvenanceForWindowBestEffort } from "@/lib/db/planetscale/battery-provenance-pg";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";

const TZ = 600; // +10:00

type Row = { handle: number | null; tz: number; day: string };

/**
 * Fake drizzle db issuing the two reads the reheal makes:
 *   (1) select({tz}).from(areas).where().limit(1)             → representative tz for the ceiling
 *   (2) selectDistinct({handle,tz,day})...orderBy().limit(n)  → the ordered, pre-filtered backlog
 * `.limit(n)` slices, so we can exercise the per-run cap.
 */
function makeDb(backlog: Row[]) {
  const chain = (result: unknown[]): any => {
    const p: any = {
      from: () => p,
      innerJoin: () => p,
      where: () => p,
      orderBy: () => p,
      limit: (n: number) => Promise.resolve(result.slice(0, n)),
    };
    return p;
  };
  return {
    select: () => chain([{ tz: TZ }]),
    selectDistinct: () => chain(backlog),
  };
}

const requireDb = requirePlanetscaleDb as unknown as jest.MockedFunction<
  (...a: any[]) => any
>;
const recomputeMock =
  recomputeBatteryProvenanceForWindowBestEffort as unknown as jest.MockedFunction<
    (...a: any[]) => Promise<void>
  >;

const winStart = (day: string) =>
  dayToUnixRangeForAggregation(parseDate(day), TZ)[0] * 1000;
const winEnd = (day: string) =>
  dayToUnixRangeForAggregation(parseDate(day), TZ)[1] * 1000;

beforeEach(() => {
  recomputeMock.mockReset();
  recomputeMock.mockResolvedValue(undefined);
});

describe("rehealStaleAttrDays", () => {
  it("groups the backlog by handle into ONE [oldest,newest] window per handle", async () => {
    const backlog: Row[] = [
      { handle: 13, tz: TZ, day: "2025-11-20" },
      { handle: 8, tz: TZ, day: "2025-12-01" },
      { handle: 8, tz: TZ, day: "2025-12-02" },
      { handle: 8, tz: TZ, day: "2025-12-03" },
    ];
    requireDb.mockReturnValue(makeDb(backlog));

    const now = Date.parse("2026-01-15T00:05:00Z");
    const res = await rehealStaleAttrDays(now, { limit: 20 });

    expect(res).toMatchObject({
      days: 4,
      handles: 2,
      selected: 4,
      remaining: 0,
      timedOut: false,
    });
    expect(recomputeMock).toHaveBeenCalledTimes(2);
    // handle 8 → one window spanning its oldest..newest stale day
    expect(recomputeMock).toHaveBeenCalledWith(
      8,
      winStart("2025-12-01"),
      winEnd("2025-12-03"),
      { writeRollup: true, writeCheckpoints: true, nowMs: now },
    );
    // handle 13 → single-day window
    expect(recomputeMock).toHaveBeenCalledWith(
      13,
      winStart("2025-11-20"),
      winEnd("2025-11-20"),
      { writeRollup: true, writeCheckpoints: true, nowMs: now },
    );
  });

  it("never sets updateLatest (no clobbering the live KV) but DOES write checkpoints", async () => {
    // 🛑 The two flags have different justifications and used to share one. `updateLatest` must stay
    // off — rehealing an old day must not touch the live latest. `writeCheckpoints` must be ON: the
    // READ path (`tryLoadSeededProvenanceInputs`) seeds as of the REQUESTED WINDOW's start day, not
    // as of today, so a historical day with no checkpoint costs every later chart of that period an
    // extra 7-day warm-up read — and a model-version bump distrusts every stored checkpoint at once,
    // leaving this sweep the only thing that would ever rewrite them.
    requireDb.mockReturnValue(
      makeDb([{ handle: 8, tz: TZ, day: "2025-12-01" }]),
    );
    await rehealStaleAttrDays(Date.parse("2026-01-15T00:05:00Z"));
    const opts = recomputeMock.mock.calls[0][3];
    expect(opts.updateLatest).toBeUndefined();
    expect(opts.writeCheckpoints).toBe(true);
    expect(opts.writeRollup).toBe(true);
  });

  it("stops at the wall-clock budget, and says how far it got", async () => {
    const backlog: Row[] = [
      { handle: 8, tz: TZ, day: "2025-12-01" },
      { handle: 13, tz: TZ, day: "2025-12-02" },
      { handle: 21, tz: TZ, day: "2025-12-03" },
    ];
    requireDb.mockReturnValue(makeDb(backlog));
    // A clock that jumps a minute per read: the first handle runs, then the budget is spent.
    let t = 0;
    const now = () => (t += 60_000);
    const res = await rehealStaleAttrDays(Date.now(), {
      budgetMs: 30_000,
      now,
    });
    expect(res.handles).toBe(1);
    expect(res.days).toBe(1);
    expect(res.selected).toBe(3);
    expect(res.remaining).toBe(2);
    expect(res.timedOut).toBe(true);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });

  it("always does one handle, even when the budget is already spent", async () => {
    // Otherwise an over-subscribed run stalls the backlog forever while logging that it was busy.
    requireDb.mockReturnValue(
      makeDb([
        { handle: 8, tz: TZ, day: "2025-12-01" },
        { handle: 13, tz: TZ, day: "2025-12-02" },
      ]),
    );
    const res = await rehealStaleAttrDays(Date.now(), {
      budgetMs: -1,
      now: () => 1_000_000,
    });
    expect(res.handles).toBe(1);
    expect(res.timedOut).toBe(true);
  });

  it("caps the backlog at the per-run limit (oldest-first)", async () => {
    const backlog: Row[] = [
      { handle: 8, tz: TZ, day: "2025-12-01" },
      { handle: 8, tz: TZ, day: "2025-12-02" },
      { handle: 8, tz: TZ, day: "2025-12-03" },
    ];
    requireDb.mockReturnValue(makeDb(backlog));

    const res = await rehealStaleAttrDays(Date.now(), { limit: 2 });

    expect(res.days).toBe(2);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    // window collapses to the 2 oldest selected days
    expect(recomputeMock.mock.calls[0][1]).toBe(winStart("2025-12-01"));
    expect(recomputeMock.mock.calls[0][2]).toBe(winEnd("2025-12-02"));
  });

  it("no-ops on an empty backlog", async () => {
    requireDb.mockReturnValue(makeDb([]));
    const res = await rehealStaleAttrDays(Date.now());
    expect(res).toMatchObject({ days: 0, handles: 0, selected: 0 });
    expect(recomputeMock).not.toHaveBeenCalled();
  });
});
