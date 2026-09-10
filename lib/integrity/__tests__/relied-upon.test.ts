import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { findDependents } from "../relied-upon";

/**
 * The finders, driven against a stub that returns what the DRIVER returns rather than what the
 * type annotation claims.
 *
 * That distinction is the whole point of this file. `sql<Date>` is a compile-time annotation on a
 * raw fragment — drizzle attaches no runtime decoder — so an aggregated `timestamp` arrives as
 * whatever node-postgres produced. The first version of `derivationDependents` called
 * `.toISOString()` on it directly and would have thrown the first time a derivation with any
 * history was examined. It typechecked, and no test saw it, because nothing drove the finder.
 */

/** A stub whose every builder method returns itself, resolving to the next queued result set. */
function stubDb(results: unknown[][]) {
  const queue = [...results];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "groupBy"])
    builder[m] = () => builder;
  // Drizzle's builders are thenables; awaiting one runs the query.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve);
  return builder;
}

const mockDb = jest.mocked(requirePlanetscaleDb);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("derivation dependents", () => {
  const intervals = (first: unknown, last: unknown) => [
    [{ n: 3, first, last }], // the interval span
    [{ outputPointId: null }], // the derivation row
    [], // automations naming it
  ];

  it("reports the interval window when the driver returns STRINGS", async () => {
    // 🛑 The regression, twice over. Postgres hands back `2025-10-04 03:15:00` for min/max of a
    // timestamp while the annotation says Date, so `.toISOString()` on it throws — and once that is
    // fixed by casting, `new Date()` of a zoneless string parses it as LOCAL time, which on an AEST
    // machine reports the 3rd. Every timestamp in this database is naive UTC.
    mockDb.mockReturnValue(
      stubDb(intervals("2025-10-04 03:15:00", "2026-09-08 21:00:00")) as never,
    );
    const [dep] = await findDependents("derivation", "dx-uuid");
    expect(dep.kind).toBe("intervals");
    expect(dep.id).toBe("3");
    expect(dep.name).toBe("2025-10-04 … 2026-09-08");
    expect(dep.effect).toBe("cascade-deleted");
  });

  it("reports the same window when the driver returns Dates", async () => {
    mockDb.mockReturnValue(
      stubDb(
        intervals(
          new Date("2025-10-04T03:15:00Z"),
          new Date("2026-09-08T21:00:00Z"),
        ),
      ) as never,
    );
    const [dep] = await findDependents("derivation", "dx-uuid");
    expect(dep.name).toBe("2025-10-04 … 2026-09-08");
  });

  it("degrades to an unnamed window rather than throwing on rubbish", async () => {
    mockDb.mockReturnValue(stubDb(intervals("not a date", null)) as never);
    const [dep] = await findDependents("derivation", "dx-uuid");
    // A refusal message must never be the thing that 500s the request.
    expect(dep.id).toBe("3");
    expect(dep.name).toBeNull();
  });

  it("says nothing about intervals when there are none", async () => {
    mockDb.mockReturnValue(
      stubDb([
        [{ n: 0, first: null, last: null }],
        [{ outputPointId: null }],
        [],
      ]) as never,
    );
    expect(await findDependents("derivation", "dx-uuid")).toEqual([]);
  });
});

describe("automation dependents", () => {
  it("finds nothing today — and is called anyway, so the next reference has to be declared", async () => {
    mockDb.mockReturnValue(stubDb([]) as never);
    expect(await findDependents("automation", "au-uuid")).toEqual([]);
  });
});
