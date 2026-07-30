/**
 * Vendor-conditional 5m queue-publish gate in `PointManager.insertPointReadingsAgg5m`.
 *
 * `insertPointReadingsAgg5m` is SHARED by raw-vendor adapters (which also write raw
 * `point_readings`, from which Postgres self-computes 5m) and by 5m-native adapters
 * (Amber/Enphase — NO raw, so their 5m is the only copy and MUST be published). The gate is now
 * UNCONDITIONAL (Phase 5 retired the `AGG_COMPUTE_IN_PG` flag that used to guard it):
 *
 *   skip publish  ⇔  !isFiveMinuteNativeVendor(vendorType)
 *
 * i.e. a raw vendor's 5m is never published (PG recomputes it from raw); a 5m-native vendor's
 * 5m is always published. The heavy DB modules are mocked so importing the manager is cheap; a
 * fake `collector` records whether a publish was attempted.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";

// --- Module mocks (hoisted by jest) -----------------------------------------------------

// PlanetScale is unused on this path (collector supplied, vendorType drives the gate).
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));
// config-v4 slice 1b: served points come from `points ⋈ devices`, so the schema mock carries those
// two tables as well as `point_info` (still the write-behind copy). Named columns rather than `{}`
// because the query now references `devices.rid` / `points.deviceId` by identity.
jest.mock("@/lib/db/planetscale/schema", () => ({
  pointInfo: { systemId: "pi.system_id", rid: "pi.rid" },
  points: {
    id: "p.id",
    rid: "p.rid",
    deviceId: "p.device_id",
    physicalPath: "p.physical_path",
    logicalPath: "p.logical_path",
    metricType: "p.metric_type",
    unit: "p.unit",
    name: "p.name",
    defaultName: "p.default_name",
    subsystem: "p.subsystem",
    transform: "p.transform",
    active: "p.active",
    createdAt: "p.created_at",
    updatedAt: "p.updated_at",
  },
  devices: { id: "d.id", rid: "d.rid" },
}));

// publishObservationBatch is the non-collector publish sink; mock it so we can detect a publish
// even if a future change drops the collector. (Tests below always pass a collector.)
const publishSpy = jest.fn((..._args: unknown[]): Promise<void> => {
  return Promise.resolve();
});
jest.mock("../../observations/publisher", () => ({
  publishObservationBatch: (...args: unknown[]) => publishSpy(...args),
}));

// The device config registry returns the vendorType under test (config-v4 slice K2 — was
// `SystemsManager.getDevice`, deleted in K3).
let currentVendorType = "selectronic";
// config-v4 Phase 13 PR 2 deleted `isAreaHandle`; the dispatch now consults `areaByHandle` only when
// `deviceByHandle` came back empty. This stub always resolves a device, so the area leg is never
// reached — `areaByHandle` is present and null purely so the mock keeps a faithful shape.
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: async () => ({ id: 1, vendorType: currentVendorType }),
    areaByHandle: async () => null,
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
 * Build a fresh PointManager singleton, stub the point-info lookups, and run
 * insertPointReadingsAgg5m for `vendorType` with a collector. Returns the collector so the
 * caller can assert whether a publish happened.
 */
async function runInsert5m(opts: {
  vendorType: string;
}): Promise<CollectorStub> {
  currentVendorType = opts.vendorType;

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

describe("PointManager.insertPointReadingsAgg5m — vendor-conditional 5m publish gate", () => {
  afterEach(() => {
    publishSpy.mockClear();
    jest.restoreAllMocks();
  });

  it("raw vendor → does NOT publish 5m (PG recomputes from raw)", async () => {
    const collector = await runInsert5m({ vendorType: "selectronic" });
    expect(collector.add).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("5m-native vendor (Amber) → publishes 5m", async () => {
    const collector = await runInsert5m({ vendorType: "amber" });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });

  it("5m-native vendor (Enphase) → publishes 5m", async () => {
    const collector = await runInsert5m({ vendorType: "enphase" });
    expect(collector.add).toHaveBeenCalledTimes(1);
  });
});
