/**
 * 🛑 THE MINT OBLIGATION — half one of two.
 *
 * `points.control` is what makes a point writable, and it is written from vendor metadata at
 * mint time. The trap: every point that needs one (Tesla's charge limit, charge amps, and the
 * charging switch) was ALREADY MINTED before the column existed. So putting `control` only in
 * the insert's `values` would leave those rows at NULL forever and the action route would
 * reject every command against them.
 *
 * The fix has two halves, each with its own test:
 *   1. HERE — `control` must be in the upsert's `onConflictDoUpdate.set` clause, not just in
 *      `values`, so a re-mint of an existing row REFRESHES it.
 *   2. `point-manager-control-heal.test.ts` — `ensurePointInfo` must actually re-invoke
 *      `mintPoint` on drift, or the SET clause above never executes at all.
 *
 * The assertions below are written to go RED if either `values.control` or `set.control` is
 * dropped — deliberately both, because only the second one heals an existing point.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { PointControl } from "@/lib/db/planetscale/schema";

/** The `values(...)` payload of the last insert. */
let capturedValues: Record<string, unknown> | null = null;
/** The `onConflictDoUpdate(...)` config of the last insert. */
let capturedConflict: { set?: Record<string, unknown> } | null = null;
/** What the fake `points` table hands back from `.returning()`. */
let returnedControl: PointControl | null = null;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      insert() {
        const chain = {
          values(row: Record<string, unknown>) {
            capturedValues = row;
            return chain;
          },
          onConflictDoUpdate(cfg: { set?: Record<string, unknown> }) {
            capturedConflict = cfg;
            return chain;
          },
          async returning() {
            return [
              {
                id: capturedValues!.id,
                rid: 77,
                deviceId: capturedValues!.deviceId,
                physicalPath: capturedValues!.physicalPath,
                logicalPath: capturedValues!.logicalPath ?? null,
                metricType: capturedValues!.metricType,
                unit: capturedValues!.unit,
                name: capturedValues!.name,
                defaultName: capturedValues!.defaultName,
                subsystem: null,
                transform: null,
                // Deliberately NOT echoed from `values`: on a conflict the DB returns the
                // POST-UPDATE row, which is the case that matters here.
                control: returnedControl,
                active: true,
                createdAt: new Date(0),
                updatedAt: null,
              },
            ];
          },
        };
        return chain;
      },
    };
  },
}));

jest.mock("@/lib/registry/device-registry", () => ({
  DeviceRegistry: {
    async uuidForRid() {
      return "019f0000-0000-7000-8000-0000000dev10";
    },
  },
}));

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    async deviceByHandle() {
      return { vendorType: "tesla", vendorSiteId: "1492931718143539" };
    },
  },
}));

import { mintPoint } from "../mint-point";

const BASE = {
  physicalPathTail: "charge_limit_soc",
  logicalPathStem: "ev.charge.limit",
  metricType: "soc",
  metricUnit: "%",
  defaultName: "Charge Limit SoC",
} as const;

const LIMIT_CONTROL: PointControl = {
  kind: "number",
  min: 50,
  max: 100,
  step: 1,
};

beforeEach(() => {
  capturedValues = null;
  capturedConflict = null;
  returnedControl = null;
});

describe("mintPoint carries `control` through the upsert", () => {
  it("writes control on INSERT", async () => {
    await mintPoint(10, { ...BASE, control: LIMIT_CONTROL });
    expect(capturedValues!.control).toEqual(LIMIT_CONTROL);
  });

  it("🛑 REFRESHES control on CONFLICT — the already-minted-point case", async () => {
    await mintPoint(10, { ...BASE, control: LIMIT_CONTROL });
    // Without `control` in the SET clause, rid 77 (minted long before points.control existed)
    // stays NULL forever and every charge-limit command is rejected as "not controllable".
    expect(capturedConflict!.set).toBeDefined();
    expect(capturedConflict!.set!.control).toEqual(LIMIT_CONTROL);
  });

  it("still refreshes only the non-identity columns", async () => {
    await mintPoint(10, { ...BASE, control: LIMIT_CONTROL });
    // `name` / `rid` / `deviceId` / `id` remain untouched on conflict — control JOINS the
    // refreshed set (defaultName, transform), it does not widen it.
    expect(Object.keys(capturedConflict!.set!).sort()).toEqual([
      "control",
      "defaultName",
      "transform",
      "updatedAt",
    ]);
  });

  it("clears a stale control when the vendor metadata no longer declares one", async () => {
    await mintPoint(10, BASE);
    // Symmetric on purpose (§ mint-point header): vendor metadata is the single source of
    // truth, so removing a control there must heal the row back to a read-only sensor rather
    // than stranding a writable surface that nothing can service.
    expect(capturedValues!.control).toBeNull();
    expect(capturedConflict!.set!.control).toBeNull();
  });

  it("maps the returned row's control onto MintedPointRow", async () => {
    returnedControl = { kind: "switch" };
    const row = await mintPoint(10, { ...BASE, control: { kind: "switch" } });
    expect(row.control).toEqual({ kind: "switch" });

    returnedControl = null;
    const plain = await mintPoint(10, BASE);
    expect(plain.control).toBeNull();
  });
});
