/**
 * `mintPoint`'s derived-uid collision fallback (config-v4 Phase 14 stage 2b) — the LIVE INGEST PATH.
 *
 * `points.id` is derived deterministically from (vendor_type, vendor_site_id, physical_path_tail) so a
 * re-onboarded physical point reproduces its uid. Two distinct devices sharing a vendor site id therefore
 * collide on `points_pkey`, and the documented behaviour is to retry once with a random uuid.
 *
 * That fallback was DEAD. `isPointUidCollision` opened with `err.code !== "23505" → false`, and drizzle
 * ≥0.44 leaves the wrapper's own `code` undefined, so the mint threw instead of retrying — and the
 * `message.includes("points_pkey")` line written as a hedge against an unreliable `err.constraint` sat
 * below that early return and could never run.
 *
 * These cases inject the MEASURED wrapped error rather than a `{code:"23505"}` stand-in: a bare-code
 * fixture satisfies the old predicate too and would have gone green against the broken code.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/** Every uid the mint has attempted to INSERT, in order. */
let attemptedUids: string[] = [];
/** Uids that the fake `points` table already holds — an insert naming one raises `points_pkey`. */
let taken = new Set<string>();

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      insert() {
        let pending: Record<string, unknown> = {};
        const chain = {
          values(row: Record<string, unknown>) {
            pending = row;
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          async returning() {
            const id = String(pending.id);
            attemptedUids.push(id);
            if (taken.has(id)) throw wrappedPointsPkeyCollision(id);
            return [
              {
                id,
                rid: 4242,
                deviceId: pending.deviceId,
                physicalPath: pending.physicalPath,
                logicalPath: pending.logicalPath ?? null,
                metricType: pending.metricType,
                unit: pending.unit,
                name: pending.name,
                defaultName: pending.defaultName,
                subsystem: null,
                transform: null,
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
      return "019f0000-0000-7000-8000-0000000dev01";
    },
  },
}));

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    async deviceByHandle() {
      return { vendorType: "selectronic", vendorSiteId: "p14-pgerr-site" };
    },
  },
}));

import { mintPoint, isPointUidCollision } from "../mint-point";
import { derivePointUid } from "@/lib/identifiers/point-uid";

/** A `points_pkey` violation exactly as `liveone-dev` raises it, inside drizzle's wrapper. */
function wrappedPointsPkeyCollision(id: string): Error {
  const pgError = Object.assign(
    new Error('duplicate key value violates unique constraint "points_pkey"'),
    {
      code: "23505",
      severity: "ERROR",
      detail: `Key (id)=(${id}) already exists.`,
      constraint: undefined,
      table: undefined,
      schema: undefined,
      routine: "_bt_check_unique",
    },
  );
  return Object.assign(new Error("Failed query: insert into points …"), {
    cause: pgError,
  });
}

const SPEC = {
  physicalPathTail: "p14-pgerr/battery/soc",
  logicalPathStem: "battery",
  metricType: "soc",
  metricUnit: "%",
  defaultName: "p14-pgerr SOC",
};

describe("mintPoint — derived-uid collision", () => {
  beforeEach(() => {
    attemptedUids = [];
    taken = new Set<string>();
  });

  it("uses the DERIVED uid when it is free (no retry)", async () => {
    const row = await mintPoint(7, SPEC);
    const derived = derivePointUid(
      "selectronic",
      "p14-pgerr-site",
      SPEC.physicalPathTail,
    );
    expect(attemptedUids).toEqual([derived]);
    expect(row.pointUid).toBe(derived);
  });

  it("falls back to a random uid when the derived uid is taken", async () => {
    const derived = derivePointUid(
      "selectronic",
      "p14-pgerr-site",
      SPEC.physicalPathTail,
    );
    taken.add(derived);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const row = await mintPoint(7, SPEC);
      expect(attemptedUids).toHaveLength(2); // the retry actually happened
      expect(attemptedUids[0]).toBe(derived);
      expect(attemptedUids[1]).not.toBe(derived); // …with a fresh uid
      expect(row.pointUid).toBe(attemptedUids[1]);
      expect(row.rid).toBe(4242); // and the caller gets a real row, not a throw
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("uid collision for system 7"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rethrows a unique violation on a DIFFERENT points index (no random-uid retry)", async () => {
    // A `points_device_logical_metric_unique` clash means the caller is minting a semantically
    // duplicate point; re-rolling the uid would paper over it with a second bad row.
    const other = Object.assign(
      new Error("Failed query: insert into points …"),
      {
        cause: Object.assign(
          new Error(
            'duplicate key value violates unique constraint "points_device_logical_metric_unique"',
          ),
          { code: "23505", constraint: undefined },
        ),
      },
    );
    expect(isPointUidCollision(other)).toBe(false);
  });

  it("isPointUidCollision matches the wrapped shape and nothing else", async () => {
    expect(isPointUidCollision(wrappedPointsPkeyCollision("x"))).toBe(true);
    // The pre-drizzle-0.44 bare shape must keep working.
    expect(
      isPointUidCollision(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "points_pkey"',
          ),
          { code: "23505" },
        ),
      ),
    ).toBe(true);
    expect(isPointUidCollision(new Error("boom"))).toBe(false);
    expect(isPointUidCollision(null)).toBe(false);
  });
});
