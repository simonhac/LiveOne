import { describe, it, expect, beforeEach } from "@jest/globals";

// The registry reads the `planetscaleDb` singleton; expose a mutable fake (the readings-read-pg idiom).
let mockDb: unknown = null;
jest.mock("@/lib/db/planetscale", () => ({
  get planetscaleDb() {
    return mockDb;
  },
  requirePlanetscaleDb() {
    if (!mockDb) throw new Error("[PlanetScale] not configured (test)");
    return mockDb;
  },
}));

import { RegistryCache, UnknownIdError } from "../registry-cache";
import { Point, type PointId } from "@/lib/ids";

interface Row {
  uuid: string;
  rid: number;
  systemId: number;
}

/**
 * Fake the drizzle `select(cols).from(table).innerJoin(…).where(cond)` surface. Each `.where()` shifts
 * the next queued row-set and records a call, so tests can assert batch/caching (how many DB
 * round-trips).
 *
 * `innerJoin` arrived with slice 1b: the registry now fills from `points ⋈ devices` (it needs
 * `devices.rid` for the `systemId` the row used to carry directly on `point_info`).
 */
function makeFakeDb() {
  const queued: Row[][] = [];
  let calls = 0;
  const db = {
    select() {
      const from = {
        innerJoin() {
          return from;
        },
        where() {
          calls++;
          return Promise.resolve(queued.shift() ?? []);
        },
      };
      return { from: () => from };
    },
  };
  return {
    db,
    queue(rows: Row[]) {
      queued.push(rows);
    },
    calls: () => calls,
  };
}

/** Mint a PointId + the `points ⋈ devices` fill row a DB would return for it. */
function makePoint(rid: number, systemId: number) {
  const id = Point.generate();
  const uuid = Point.toUuid(id);
  const row: Row = { uuid, rid, systemId };
  return { id, uuid, row };
}

let fake: ReturnType<typeof makeFakeDb>;
beforeEach(() => {
  RegistryCache.invalidate(); // clear the global cache between tests
  fake = makeFakeDb();
  mockDb = fake.db;
});

describe("RegistryCache", () => {
  it("resolves a batch of PointIds in ONE DB round-trip and caches them", async () => {
    const a = makePoint(101, 1);
    const b = makePoint(102, 1);
    fake.queue([a.row, b.row]);

    const addrs = await RegistryCache.addrsForPoints([a.id, b.id]);
    expect(addrs.get(a.id)).toMatchObject({ rid: 101, systemId: 1 });
    expect(addrs.get(b.id)).toMatchObject({ rid: 102, systemId: 1 });
    expect(fake.calls()).toBe(1);

    // Second resolution is fully cached — no new query.
    await RegistryCache.addrsForPoints([a.id, b.id]);
    expect(fake.calls()).toBe(1);
  });

  it("derives rids and resolves rid→point/addr from the same cached fill (no extra query)", async () => {
    const a = makePoint(200, 2);
    fake.queue([a.row]);
    await RegistryCache.addrForPoint(a.id);
    expect(fake.calls()).toBe(1);

    const rids = await RegistryCache.ridsForPoints([a.id]);
    expect(rids.get(a.id)).toBe(200);
    expect(await RegistryCache.pointForRid(200 as never)).toBe(a.id);
    expect((await RegistryCache.addrForRid(200 as never)).systemId).toBe(2);
    expect(fake.calls()).toBe(1); // all served from the byUuid/byRid indexes
  });

  it("throws UnknownIdError for a genuinely absent point", async () => {
    const ghost = Point.generate();
    fake.queue([]); // DB returns no row
    await expect(RegistryCache.addrForPoint(ghost)).rejects.toBeInstanceOf(
      UnknownIdError,
    );
  });

  it("does NOT negatively cache — a point minted after a miss resolves immediately", async () => {
    const p = makePoint(300, 3);
    fake.queue([]); // first lookup: not yet committed
    await expect(RegistryCache.addrForPoint(p.id)).rejects.toBeInstanceOf(
      UnknownIdError,
    );

    fake.queue([p.row]); // now it exists
    const addr = await RegistryCache.addrForPoint(p.id);
    expect(addr.rid).toBe(300);
    expect(fake.calls()).toBe(2); // both lookups hit the DB (absence was never cached)
  });

  it("invalidate() clears the cache so the next lookup refetches", async () => {
    const a = makePoint(400, 4);
    fake.queue([a.row]);
    await RegistryCache.addrForPoint(a.id);
    expect(fake.calls()).toBe(1);

    RegistryCache.invalidate();
    fake.queue([a.row]);
    await RegistryCache.addrForPoint(a.id);
    expect(fake.calls()).toBe(2);
  });

  it("invalidate(id) evicts a single point from BOTH indexes", async () => {
    const a = makePoint(500, 5);
    fake.queue([a.row]);
    await RegistryCache.addrForPoint(a.id);

    RegistryCache.invalidate(a.id);
    fake.queue([a.row]);
    // The rid→uuid reverse index must have been evicted too, not just byUuid — so a rid lookup has to
    // go back to the DB. (This assertion USED to be made through `pointForAddr`/byAddr, which the
    // pre-terminal prep retired with the legacy address grammar; byRid is the remaining reverse index
    // and the only one still unenforced elsewhere.)
    await RegistryCache.pointForRid(500 as never);
    expect(fake.calls()).toBe(2);
  });
});
