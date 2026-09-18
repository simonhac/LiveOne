import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { finishJob, MAX_ATTEMPTS } from "../store";

/**
 * A stub that answers each UPDATE in turn. `finishJob` issues at most two: the guarded settle, and
 * — only if that matched nothing — the fenced follow-up.
 */
function stubDb(results: unknown[][]) {
  const queue = [...results];
  const sets: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {};
  builder.update = () => builder;
  builder.set = (v: Record<string, unknown>) => {
    sets.push(v);
    return builder;
  };
  builder.where = () => builder;
  builder.returning = () => Promise.resolve(queue.shift() ?? []);
  return { db: builder, sets };
}

const mockDb = jest.mocked(requirePlanetscaleDb);
beforeEach(() => {
  jest.clearAllMocks();
});

const TOKEN = "lease-1";
const base = { leaseToken: TOKEN, reasonsAtClaim: 2 };

describe("finishJob", () => {
  it("marks a capture done when nothing arrived while we worked", async () => {
    const { db, sets } = stubDb([[{ id: "job" }]]);
    mockDb.mockReturnValue(db as never);
    await expect(
      finishJob("job", { status: "done", ...base }),
    ).resolves.toEqual({ written: true, followUp: false });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ status: "done", leaseToken: null });
  });

  it("schedules a FOLLOW-UP when a reason arrived after we claimed", async () => {
    // The guarded update matches nothing (the count moved), so the job goes back to pending.
    const { db, sets } = stubDb([[], [{ id: "job" }]]);
    mockDb.mockReturnValue(db as never);
    await expect(
      finishJob("job", { status: "done", ...base }),
    ).resolves.toEqual({ written: true, followUp: true });
    expect(sets[1]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("gives a follow-up a FRESH retry budget", async () => {
    // The ladder measures how long THIS request has been failing. Inheriting 27 prior failures
    // would give a just-arrived fault one attempt and then silence.
    const { db, sets } = stubDb([[], [{ id: "job" }]]);
    mockDb.mockReturnValue(db as never);
    await finishJob("job", {
      status: "failed",
      error: "x",
      attempts: MAX_ATTEMPTS,
      ...base,
    });
    expect(sets[1]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("🛑 does NOT abandon a job whose ladder is exhausted if a new reason arrived", async () => {
    // Abandoning consumes the trigger. A brand-new fault must not be thrown away because the
    // previous one had been failing for a day.
    const { db, sets } = stubDb([[], [{ id: "job" }]]);
    mockDb.mockReturnValue(db as never);
    const result = await finishJob("job", {
      status: "failed",
      error: "unreachable",
      attempts: MAX_ATTEMPTS,
      ...base,
    });
    expect(sets[0]).toMatchObject({ status: "abandoned" });
    expect(result.followUp).toBe(true);
    expect(sets[1]).toMatchObject({ status: "pending" });
  });

  it("retries on the ladder when an attempt fails and nothing new arrived", async () => {
    const { db, sets } = stubDb([[{ id: "job" }]]);
    mockDb.mockReturnValue(db as never);
    await finishJob("job", {
      status: "failed",
      error: "offline",
      attempts: 1,
      ...base,
    });
    expect(sets[0]).toMatchObject({ status: "pending", lastError: "offline" });
    // First rung is one minute, not five.
    const at = (sets[0] as { nextAttemptAt: Date }).nextAttemptAt;
    expect(at.getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(at.getTime() - Date.now()).toBeLessThan(70_000);
  });

  it("reports writing NOTHING when the lease was reclaimed", async () => {
    // Both updates are fenced on the token, so a superseded worker affects zero rows rather than
    // clearing its successor's lease.
    const { db } = stubDb([[], []]);
    mockDb.mockReturnValue(db as never);
    await expect(
      finishJob("job", { status: "done", ...base }),
    ).resolves.toEqual({ written: false, followUp: false });
  });
});
