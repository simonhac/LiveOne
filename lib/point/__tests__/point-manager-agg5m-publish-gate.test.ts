/**
 * PR-13 — vendor-conditional 5m queue-publish gate in
 * `PointManager.insertPointReadingsAgg5m`.
 *
 * `insertPointReadingsAgg5m` is SHARED by raw-vendor adapters (which also write raw
 * `point_readings`, from which Postgres self-computes 5m when `AGG_COMPUTE_IN_PG` is on)
 * and by 5m-native adapters (Amber/Enphase — NO raw, so their 5m is the only copy and MUST
 * keep being published). PR-13 stops the redundant raw-vendor 5m queue publish ONLY when the
 * flag is on, leaving the Turso `agg_5m` upsert untouched. Gate:
 *
 *   skip publish  ⇔  AGG_COMPUTE_IN_PG && !isFiveMinuteNativeVendor(vendorType)
 *
 * The flag is read ONCE at module load from `lib/db/routing.ts`, so each case sets
 * `process.env.AGG_COMPUTE_IN_PG`, then `jest.resetModules()` + dynamic `import()` to pick up
 * a fresh routing snapshot. The heavy DB modules are mocked so importing the manager is cheap
 * and the Turso upsert is a no-op; a fake `collector` records whether a publish was attempted.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";

// --- Module mocks (hoisted by jest) -----------------------------------------------------

// Turso db: the agg_5m upsert chain must resolve without a real database. We don't assert on
// it here (a separate concern) — only that it never throws so the publish-gate path runs.
jest.mock("@/lib/db/turso", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
  },
}));

// PlanetScale is unused on this path (collector supplied, vendorType drives the gate).
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));
jest.mock("@/lib/db/planetscale/schema", () => ({ pointInfo: {} }));

// publishObservationBatch is the non-collector publish sink; mock it so we can detect a publish
// even if a future change drops the collector. (Tests below always pass a collector.)
const publishSpy = jest.fn((..._args: unknown[]): Promise<void> => {
  return Promise.resolve();
});
jest.mock("../../observations/publisher", () => ({
  publishObservationBatch: (...args: unknown[]) => publishSpy(...args),
}));

// SystemsManager.getSystem returns the vendorType under test.
let currentVendorType = "selectronic";
jest.mock("@/lib/systems-manager", () => ({
  SystemsManager: {
    getInstance: async () => ({
      getSystem: async () => ({ id: 1, vendorType: currentVendorType }),
    }),
  },
}));

// --- Helpers ----------------------------------------------------------------------------

type CollectorStub = {
  add: jest.Mock;
};

function makeCollector(): CollectorStub {
  return { add: jest.fn() };
}

const POINT_KEY = "mp/energyNowW";

/** A point_info-shaped row for the single point under test. */
const fakePoint = {
  systemId: 1,
  index: 1,
  physicalPathTail: POINT_KEY,
  metricType: "power",
  metricUnit: "W",
  transform: null,
  displayName: "Solar",
  defaultName: "Solar",
};

const reading = {
  pointMetadata: {
    physicalPathTail: POINT_KEY,
    logicalPathStem: null,
    metricType: "power",
    metricUnit: "W",
    defaultName: "Solar",
    transform: null,
  },
  rawValue: 1850,
  intervalEndMs: 1749081600000,
};

const session = { id: "s1", started: new Date(1749081600000) };

/**
 * Load a FRESH PointManager (so it sees the current AGG_COMPUTE_IN_PG), build a fresh
 * singleton, stub the point-info lookups, and run insertPointReadingsAgg5m for `vendorType`
 * with a collector. Returns the collector so the caller can assert whether a publish happened.
 */
async function runInsert5m(opts: {
  aggInPg: boolean;
  vendorType: string;
}): Promise<CollectorStub> {
  if (opts.aggInPg) process.env.AGG_COMPUTE_IN_PG = "true";
  else delete process.env.AGG_COMPUTE_IN_PG;
  currentVendorType = opts.vendorType;

  jest.resetModules();
  const { PointManager } = await import("../point-manager");
  const mgr = PointManager.getInstance();

  // Stub the point-info lookups so no DB is touched and ensurePointInfo returns our point.
  // (Both are public async methods on the instance.)
  jest
    .spyOn(
      mgr as unknown as { loadPointInfoMap: (id: number) => Promise<unknown> },
      "loadPointInfoMap",
    )
    .mockResolvedValue({ [POINT_KEY]: fakePoint } as never);
  jest
    .spyOn(
      mgr as unknown as {
        ensurePointInfo: (...a: unknown[]) => Promise<unknown>;
      },
      "ensurePointInfo",
    )
    .mockResolvedValue(fakePoint as never);

  const collector = makeCollector();
  await mgr.insertPointReadingsAgg5m(
    1,
    session as never,
    [reading as never],
    collector as never,
  );
  return collector;
}

// --- Tests ------------------------------------------------------------------------------

describe("PointManager.insertPointReadingsAgg5m — vendor-conditional 5m publish gate (PR-13)", () => {
  afterEach(() => {
    delete process.env.AGG_COMPUTE_IN_PG;
    publishSpy.mockClear();
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it("raw vendor + AGG_COMPUTE_IN_PG on → does NOT publish 5m (PG recomputes from raw)", async () => {
    const collector = await runInsert5m({
      aggInPg: true,
      vendorType: "selectronic",
    });
    expect(collector.add).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("5m-native vendor (Amber) + AGG_COMPUTE_IN_PG on → STILL publishes 5m", async () => {
    const collector = await runInsert5m({ aggInPg: true, vendorType: "amber" });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });

  it("5m-native vendor (Enphase) + AGG_COMPUTE_IN_PG on → STILL publishes 5m", async () => {
    const collector = await runInsert5m({
      aggInPg: true,
      vendorType: "enphase",
    });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });

  it("flag OFF → publishes 5m for a raw vendor (original behaviour)", async () => {
    const collector = await runInsert5m({
      aggInPg: false,
      vendorType: "selectronic",
    });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });

  it("flag OFF → publishes 5m for a 5m-native vendor too", async () => {
    const collector = await runInsert5m({
      aggInPg: false,
      vendorType: "amber",
    });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });
});
