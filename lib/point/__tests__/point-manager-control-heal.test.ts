/**
 * 🛑 THE MINT OBLIGATION — half two of two (see `mint-point-control.test.ts` for half one).
 *
 * Adding `control` to `mintPoint`'s SET clause is necessary but NOT sufficient, because
 * `mintPoint` was never re-invoked for an existing point: `ensurePointInfo` short-circuited
 * unconditionally on a `pointMap` hit, and `pointMap` is reloaded from the DB every poll. So a
 * point minted before `points.control` existed — which is all three Tesla control points —
 * would never revisit the upsert and would stay NULL forever.
 *
 * These cases pin the drift heal: re-mint when the loaded row's control differs from the
 * vendor metadata's, and do NOTHING (no DB call at all) when it doesn't. The second half of
 * that matters as much as the first: this runs once per reading per poll per vendor.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { PointControl } from "@/lib/db/planetscale/schema";

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

jest.mock("@/lib/point/mint-point", () => ({
  mintPoint: jest.fn(),
}));

import { mintPoint } from "@/lib/point/mint-point";
import { PointManager } from "../point-manager";
import type { PointInfoMap, PointMetadata } from "../point-manager";

const mockMint = jest.mocked(mintPoint);

const SWITCH: PointControl = { kind: "switch" };

/** The vendor metadata for Tesla's charging switch. */
function metadata(control?: PointControl | null): PointMetadata {
  return {
    physicalPathTail: "charging_active",
    logicalPathStem: "ev.charge",
    metricType: "active",
    metricUnit: "boolean",
    defaultName: "Charging",
    subsystem: "ev",
    transform: null,
    ...(control !== undefined ? { control } : {}),
  };
}

/** A `pointMap` entry as `loadPointInfoMap` would produce it. */
function existingEntry(control: PointControl | null) {
  return {
    systemId: 10,
    index: 78,
    pointUid: "019f0000-0000-7000-8000-00000000pt78",
    physicalPathTail: "charging_active",
    logicalPathStem: "ev.charge",
    metricType: "active",
    metricUnit: "boolean",
    defaultName: "Charging",
    displayName: "Charging",
    subsystem: "ev",
    transform: null,
    control,
    active: true,
    createdAtMs: 0,
    updatedAtMs: null,
  };
}

/** What the (mocked) mint returns after healing. */
function mintedRow(control: PointControl | null) {
  return {
    systemId: 10,
    index: 78,
    rid: 78,
    pointUid: "019f0000-0000-7000-8000-00000000pt78",
    physicalPathTail: "charging_active",
    logicalPathStem: "ev.charge",
    metricType: "active",
    metricUnit: "boolean",
    defaultName: "Charging",
    displayName: "Charging",
    subsystem: "ev",
    transform: null,
    control,
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(1),
  };
}

let manager: PointManager;

beforeEach(() => {
  mockMint.mockReset();
  manager = PointManager.getInstance();
});

describe("ensurePointInfo — control drift heal", () => {
  it("🛑 re-mints an ALREADY-MINTED point whose control is still NULL", async () => {
    const pointMap: PointInfoMap = {
      charging_active: existingEntry(null),
    };
    mockMint.mockResolvedValue(mintedRow(SWITCH));

    const result = await manager.ensurePointInfo(10, pointMap, metadata(SWITCH));

    // Against the old unconditional short-circuit this call never happened — which is exactly
    // why points 77/80/charging_active would have sat at control = NULL on prod forever.
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint.mock.calls[0][1]).toMatchObject({
      physicalPathTail: "charging_active",
      control: SWITCH,
    });
    expect(result.control).toEqual(SWITCH);
    // The map is updated in place so the rest of THIS poll sees the healed row.
    expect(pointMap.charging_active.control).toEqual(SWITCH);
  });

  it("does NOTHING when the control already matches — the hot ingest path", async () => {
    const pointMap: PointInfoMap = {
      charging_active: existingEntry(SWITCH),
    };

    const result = await manager.ensurePointInfo(10, pointMap, metadata(SWITCH));

    expect(mockMint).not.toHaveBeenCalled();
    expect(result).toBe(pointMap.charging_active);
  });

  it("does NOTHING when neither side has a control (every other vendor's points)", async () => {
    const pointMap: PointInfoMap = { charging_active: existingEntry(null) };

    await manager.ensurePointInfo(10, pointMap, metadata());

    expect(mockMint).not.toHaveBeenCalled();
  });

  it("is insensitive to jsonb key order (no re-upsert storm)", async () => {
    const fromPg = JSON.parse(
      '{"max":100,"min":50,"kind":"number","step":1}',
    ) as PointControl;
    const pointMap: PointInfoMap = { charging_active: existingEntry(fromPg) };

    await manager.ensurePointInfo(
      10,
      pointMap,
      metadata({ kind: "number", min: 50, max: 100, step: 1 }),
    );

    expect(mockMint).not.toHaveBeenCalled();
  });

  it("heals symmetrically — a removed control is cleared, not preserved", async () => {
    const pointMap: PointInfoMap = { charging_active: existingEntry(SWITCH) };
    mockMint.mockResolvedValue(mintedRow(null));

    const result = await manager.ensurePointInfo(10, pointMap, metadata(null));

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint.mock.calls[0][1]).toMatchObject({ control: null });
    expect(result.control).toBeNull();
  });

  it("passes control through on a first mint", async () => {
    const pointMap: PointInfoMap = {};
    mockMint.mockResolvedValue(mintedRow(SWITCH));

    const result = await manager.ensurePointInfo(10, pointMap, metadata(SWITCH));

    expect(mockMint.mock.calls[0][1]).toMatchObject({ control: SWITCH });
    expect(result.control).toEqual(SWITCH);
    expect(pointMap.charging_active).toBe(result);
  });
});
