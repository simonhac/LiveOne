import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { enqueueDiagnosticJob } from "../store";

/**
 * Records what was inserted, so a test can decide what the RETURNING clause answers.
 *
 * `enqueueDiagnosticJob` mints the row id itself and infers "did I create this?" from whether that
 * id comes back — so the stub either echoes the candidate id (an insert) or returns a different one
 * (the conflict branch, which preserves the existing row's id).
 */
function stubDb(existingId: string | null) {
  let conflict: Record<string, unknown> | null = null;
  let candidate: string | undefined;
  const builder: Record<string, unknown> = {};
  builder.insert = () => builder;
  builder.values = (v: Record<string, unknown>) => {
    candidate = v.id as string;
    return builder;
  };
  builder.onConflictDoUpdate = (c: Record<string, unknown>) => {
    conflict = c;
    return builder;
  };
  builder.returning = () => Promise.resolve([{ id: existingId ?? candidate }]);
  return { db: builder, conflict: () => conflict, candidate: () => candidate };
}

/**
 * Walk a drizzle `sql` template, collecting its literal fragments and its bound parameters.
 *
 * Recursive because a nested `sql` fragment (a helper interpolated into a bigger statement) is
 * itself a chunk with its own `queryChunks` — a flat read finds neither its text nor its binds.
 */
function walk(value: unknown): { text: string; params: unknown[] } {
  const chunks = (value as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return { text: String(value), params: [] };
  const text: string[] = [];
  const params: unknown[] = [];
  for (const chunk of chunks) {
    const literal = (chunk as { value?: unknown }).value;
    if (Array.isArray(literal)) text.push(literal.join(" "));
    else if ((chunk as { queryChunks?: unknown }).queryChunks) {
      const inner = walk(chunk);
      text.push(inner.text);
      params.push(...inner.params);
    } else params.push(chunk);
  }
  return { text: text.join(" "), params };
}
const fragments = (value: unknown) => walk(value).text;

const mockDb = jest.mocked(requirePlanetscaleDb);
beforeEach(() => {
  jest.clearAllMocks();
});

const reason = {
  kind: "portal-event-new" as const,
  detail: "50 low DC",
  observedAt: "2026-09-18T02:00:00Z",
};

describe("enqueueDiagnosticJob", () => {
  it("refuses a job with no reason — 'why did we go and look' is the unreconstructible part", async () => {
    mockDb.mockReturnValue(stubDb(null).db as never);
    await expect(enqueueDiagnosticJob(1, [], "cli")).rejects.toThrow(
      /must state a reason/,
    );
  });

  it("coalesces onto whatever is already open for the device", async () => {
    const { db, conflict } = stubDb("existing-job");
    mockDb.mockReturnValue(db as never);
    const result = await enqueueDiagnosticJob(1, [reason], "trigger");
    expect(result).toEqual({ jobId: "existing-job", coalesced: true });
    // The conflict target is the PARTIAL index — one open job per device, enforced by the
    // database rather than by checking first, because overlapping cron runs make that a race.
    expect(fragments(conflict()!.targetWhere)).toContain("pending");
  });

  it("🛑 decides insert-vs-coalesce from the RETURNED ID, not a counter or a clock", async () => {
    // Two wrong answers preceded this. `attempts > 0` broke once a coalesce onto a pending job
    // started resetting the counter — it reported a fresh insert for exactly the case the flag
    // exists to surface. Comparing created_at to updated_at then broke on a millisecond tie,
    // because the conflict branch writes a JavaScript Date that can equal the existing row's
    // creation time.
    const { db, candidate } = stubDb(null);
    mockDb.mockReturnValue(db as never);
    const result = await enqueueDiagnosticJob(1, [reason], "trigger");
    expect(result).toEqual({ jobId: candidate(), coalesced: false });
    expect(candidate()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("APPENDS reasons rather than replacing them", async () => {
    const { db, conflict } = stubDb("existing-job");
    mockDb.mockReturnValue(db as never);
    await enqueueDiagnosticJob(1, [reason], "trigger");
    const set = conflict()!.set as Record<string, unknown>;
    expect(fragments(set.reasons)).toContain("||");
  });

  it("🛑 gives new work a fresh ladder when it lands on a job in BACKOFF", async () => {
    // The window that matters is the wait BETWEEN attempts, not the 40 seconds of one. A device
    // unreachable for a day sits pending with 27 failures behind it; a brand-new fault appended to
    // that job must not inherit them and get one attempt before being abandoned.
    const { db, conflict } = stubDb("existing-job");
    mockDb.mockReturnValue(db as never);
    await enqueueDiagnosticJob(1, [reason], "trigger");
    const set = conflict()!.set as Record<string, unknown>;
    const attempts = fragments(set.attempts);
    expect(attempts).toContain("CASE WHEN");
    // …and only for a pending job: resetting a RUNNING one would leave the in-flight worker
    // holding a stale count.
    expect(attempts).toContain("'pending'");
    // The schedule is pulled forward too, never pushed back.
    expect(fragments(set.nextAttemptAt)).toContain("LEAST");
  });
});

describe("timestamps in raw SQL", () => {
  it("🛑 binds a naive-UTC literal, never a JS Date", async () => {
    // Handing node-pg a `Date` inside a raw fragment serialises it with the machine's LOCAL offset,
    // and `timestamp without time zone` reads that as literal wall clock. It is not a parse error
    // and nothing warns — the comparison just comes out wrong. Caught against the real database:
    // `lease_expires_at <= now` was TRUE for a lease with a minute still to run, so a second worker
    // re-claimed a job that was already running. Correct on Vercel (UTC), ten hours out here.
    const { db, conflict } = stubDb("existing-job");
    mockDb.mockReturnValue(db as never);
    await enqueueDiagnosticJob(1, [reason], "trigger");
    const set = conflict()!.set as Record<string, unknown>;
    const { text, params } = walk(set.nextAttemptAt);
    // The bound value must be an ISO STRING with an explicit cast, not a Date object.
    expect(text).toContain("::timestamp");
    expect(params.some((p) => p instanceof Date)).toBe(false);
    expect(params.some((p) => typeof p === "string" && p.endsWith("Z"))).toBe(
      true,
    );
  });
});
