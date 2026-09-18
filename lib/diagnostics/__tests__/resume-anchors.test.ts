import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { resumeAnchors } from "../store";

/**
 * One query PER LOG, each returning at most one row — the newest capture that already QUALIFIES
 * (complete, with an anchor). The filtering is the database's, which is the point: a fixed page of
 * recent captures filtered afterwards lets the last good anchor scroll off the end during an
 * outage, and losing an anchor silently downgrades the next walk to a full read that can no longer
 * report a gap.
 */
function stubDb(perQuery: unknown[][]) {
  const queue = [...perQuery];
  const queries: unknown[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "orderBy", "limit"])
    builder[m] = () => builder;
  builder.where = (w: unknown) => {
    queries.push(w);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve);
  return { db: builder, queries };
}

const anchor = (id: string) => ({ deviceSeconds: 1000, id });

const mockDb = jest.mocked(requirePlanetscaleDb);
beforeEach(() => {
  jest.clearAllMocks();
});

describe("resumeAnchors", () => {
  it("asks the database for each log's newest qualifying anchor", async () => {
    mockDb.mockReturnValue(
      stubDb([[{ anchor: anchor("a") }], [{ anchor: anchor("o") }]])
        .db as never,
    );
    await expect(resumeAnchors(1)).resolves.toEqual({
      alert: anchor("a"),
      operational: anchor("o"),
    });
  });

  it("asks once per log, and the qualification is in the query", async () => {
    const { db, queries } = stubDb([[], []]);
    mockDb.mockReturnValue(db as never);
    await resumeAnchors(1);
    // Two logs, two queries — not one page of captures filtered in JS afterwards.
    expect(queries).toHaveLength(2);
  });

  it("yields NO anchor for a log with no qualifying capture, so the next walk reads the whole ring", async () => {
    mockDb.mockReturnValue(stubDb([[], [{ anchor: anchor("o") }]]).db as never);
    await expect(resumeAnchors(1)).resolves.toEqual({
      operational: anchor("o"),
    });
  });

  it("ignores a malformed anchor rather than resuming from nonsense", async () => {
    mockDb.mockReturnValue(
      stubDb([
        [{ anchor: { id: "no-seconds" } }],
        [{ anchor: { deviceSeconds: 5 } }],
      ]).db as never,
    );
    await expect(resumeAnchors(1)).resolves.toEqual({});
  });

  it("survives a null coverage column", async () => {
    mockDb.mockReturnValue(stubDb([[{ anchor: null }], [{}]]).db as never);
    await expect(resumeAnchors(1)).resolves.toEqual({});
  });
});
