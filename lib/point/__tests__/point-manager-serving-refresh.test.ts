/**
 * The ingest path must rebuild the KV area-serving registry when — and only when — a batch mints a
 * point.
 *
 * Why this exists: a reading always reaches its own device hash, but it reaches an AREA hash only via
 * the KV subscription registry, and the registry is a snapshot. Until this hook, the snapshot was
 * rebuilt only by area/membership/binding mutations, so a point minted on an already-member device
 * joined nothing — silently, forever. On 2026-08-04 that shipped an EV charge control to the live
 * dashboard with Start and Stop permanently disabled, because `ev.charge/active` was in the device's
 * latest map and not the area's.
 *
 * Three properties are pinned here, and each one is load-bearing:
 *   1. exactly ONE rebuild per batch (not per minted point — this is the hot ingest path);
 *   2. the rebuild happens BEFORE the batch's own KV fan-out, so the new point's FIRST reading is
 *      already served rather than the second;
 *   3. a rebuild failure never breaks reading insertion.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Keep the manager's import chain DB-inert (same treatment as the other point-manager suites).
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({}),
}));
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
    control: "p.control",
    active: "p.active",
    createdAt: "p.created_at",
    updatedAt: "p.updated_at",
  },
  devices: { id: "d.id", rid: "d.rid" },
}));

jest.mock("@/lib/point/mint-point", () => ({ mintPoint: jest.fn() }));

// The real module owns a module-level retry flag; drive it explicitly from the test instead.
let mockPending = false;
jest.mock("@/lib/kv-cache-manager", () => ({
  updateLatestPointValue: jest.fn(async () => {}),
  refreshServingForMintedPoints: jest.fn(async () => {}),
  isServingRebuildPending: jest.fn(() => mockPending),
}));

// No device row → the observation-publish block is skipped entirely.
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn(async () => null) },
}));

import { mintPoint } from "@/lib/point/mint-point";
import {
  refreshServingForMintedPoints,
  isServingRebuildPending,
} from "@/lib/kv-cache-manager";
import { PointManager } from "../point-manager";
import type { PointInfoMap, PointMetadata } from "../point-manager";

const mockMint = jest.mocked(mintPoint);
const mockRefresh = jest.mocked(refreshServingForMintedPoints);
const mockIsPending = jest.mocked(isServingRebuildPending);

const SYSTEM = 10;

function metadata(tail: string, stem: string, metric: string): PointMetadata {
  return {
    physicalPathTail: tail,
    logicalPathStem: stem,
    metricType: metric,
    metricUnit: "W",
    defaultName: tail,
    subsystem: null,
    transform: null,
  };
}

function entry(tail: string, index: number) {
  return {
    systemId: SYSTEM,
    index,
    pointUid: `019f0000-0000-7000-8000-0000000000${String(index).padStart(2, "0")}`,
    physicalPathTail: tail,
    logicalPathStem: "ev.charge",
    metricType: "active",
    metricUnit: "W",
    defaultName: tail,
    displayName: tail,
    subsystem: null,
    transform: null,
    control: null,
    active: true,
    createdAtMs: 0,
    updatedAtMs: null,
  };
}

function mintedRow(tail: string, index: number) {
  return {
    ...entry(tail, index),
    rid: index,
    createdAt: new Date(0),
    updatedAt: null,
  };
}

let manager: PointManager;
/** Every ordering-relevant call, in the order it happened. */
let order: string[];
let pointMap: PointInfoMap;

beforeEach(() => {
  jest.clearAllMocks();
  mockPending = false;
  order = [];
  pointMap = {};
  manager = PointManager.getInstance();

  // `loadPointInfoMap` and the KV fan-out are the two DB/KV seams of the methods under test.
  // `updateLatestReadingsCache` is private, hence the untyped view of the instance.
  const seams = manager as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  jest
    .spyOn(seams, "loadPointInfoMap")
    .mockImplementation(async () => pointMap);
  jest
    .spyOn(seams, "updateLatestReadingsCache")
    .mockImplementation(async () => {
      order.push("fanout");
    });

  mockRefresh.mockImplementation(async () => {
    order.push("refresh");
  });
  mockIsPending.mockImplementation(() => mockPending);
});

const rawReading = (tail: string, stem = "ev.charge", metric = "active") => ({
  pointMetadata: metadata(tail, stem, metric),
  rawValue: 1,
  measurementTime: 1731627600000,
});

const session = {
  id: "sess-1",
  started: new Date(1731627605000),
  label: null as string | null,
};

describe("insertPointReadingsRaw — serving refresh", () => {
  it("🛑 rebuilds serving when a point is minted, BEFORE the batch's own fan-out", async () => {
    mockMint.mockResolvedValue(mintedRow("charging_active", 78) as never);

    await manager.insertPointReadingsRaw(SYSTEM, session, [
      rawReading("charging_active"),
    ]);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // Ordering, not just presence. Fan out first and the new point's very first reading lands in the
    // device hash only — the area map stays a reading behind. Invert the two calls in
    // `insertPointReadingsRaw` and this assertion is what reddens.
    expect(order).toEqual(["refresh", "fanout"]);
  });

  it("rebuilds ONCE for a batch that mints several points", async () => {
    mockMint
      .mockResolvedValueOnce(mintedRow("charging_active", 78) as never)
      .mockResolvedValueOnce(mintedRow("charge_added", 79) as never);

    await manager.insertPointReadingsRaw(SYSTEM, session, [
      rawReading("charging_active"),
      rawReading("charge_added"),
    ]);

    // Per batch, not per point: this runs on every poll of every vendor.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild for a batch of only known points (the steady state)", async () => {
    pointMap = { charging_active: entry("charging_active", 78) };

    await manager.insertPointReadingsRaw(SYSTEM, session, [
      rawReading("charging_active"),
    ]);

    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(order).toEqual(["fanout"]);
  });

  it("does not rebuild for a control-drift heal (the point already exists)", async () => {
    // The heal re-mints an EXISTING key, which must not read as a new point.
    pointMap = {
      charging_active: { ...entry("charging_active", 78), control: null },
    };
    mockMint.mockResolvedValue({
      ...mintedRow("charging_active", 78),
      control: { kind: "switch" },
    } as never);

    await manager.insertPointReadingsRaw(SYSTEM, session, [
      {
        ...rawReading("charging_active"),
        pointMetadata: {
          ...metadata("charging_active", "ev.charge", "active"),
          control: { kind: "switch" as const },
        },
      },
    ]);

    expect(mockMint).toHaveBeenCalledTimes(1); // the heal fired…
    expect(mockRefresh).not.toHaveBeenCalled(); // …but no rebuild storm
  });

  it("retries on the next batch when the previous rebuild failed, even with no new mint", async () => {
    pointMap = { charging_active: entry("charging_active", 78) };
    mockPending = true;

    await manager.insertPointReadingsRaw(SYSTEM, session, [
      rawReading("charging_active"),
    ]);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("still ingests when the rebuild throws", async () => {
    // `refreshServingForMintedPoints` swallows its own errors, but ingestion must not DEPEND on that
    // politeness — the call site guards too. This mock deliberately breaks the callee's contract to
    // prove the guard is real: a serving refresh that throws must cost a stale area-hash entry, never
    // a lost reading. (Before the call-site try/catch this test asserted `.rejects.toThrow` — i.e. it
    // documented the fragility while its name claimed the opposite.)
    mockMint.mockResolvedValue(mintedRow("charging_active", 78) as never);
    mockRefresh.mockImplementation(async () => {
      throw new Error("kv down");
    });

    await expect(
      manager.insertPointReadingsRaw(SYSTEM, session, [
        rawReading("charging_active"),
      ]),
    ).resolves.not.toThrow();
  });
});

describe("insertPointReadingsAgg5m — serving refresh", () => {
  const aggReading = (tail: string) => ({
    pointMetadata: metadata(tail, "ev.charge", "active"),
    rawValue: 1,
    intervalEndMs: 1731627600000,
  });

  it("rebuilds serving when a 5m-native batch mints a point", async () => {
    mockMint.mockResolvedValue(mintedRow("price", 90) as never);

    await manager.insertPointReadingsAgg5m(SYSTEM, session, [
      aggReading("price"),
    ]);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild for a 5m batch of only known points", async () => {
    pointMap = { price: entry("price", 90) };

    await manager.insertPointReadingsAgg5m(SYSTEM, session, [
      aggReading("price"),
    ]);

    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
