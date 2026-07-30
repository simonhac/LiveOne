/**
 * Contract guards for `DeviceWriter`, the writer that replaced the `systems` writers + mirror in
 * config-v4 Phase 12 slice 1a. Two things here are regression guards for defects that have already
 * reached production once each, and both are invisible to `tsc`.
 *
 * ## 1. `createSystem().id` must be the INTEGER handle
 *
 * Callers use the returned `.id` as a handle: `POST /api/systems` passes it to `deleteSystem` on the
 * rollback path, and both OAuth callbacks pass it to `storeTeslaTokens` / `storeEnphaseTokens` as the
 * system id credentials are filed under. The writer now INSERTS `devices`, whose own `id` column is a
 * uuid — so the natural "return the row I just inserted" refactor silently swaps an int for a uuid.
 * Several of those call sites forward `.id` into `number` parameters only by inference, so `tsc` does
 * not catch it: it compiles and fails at runtime. That is the same failure shape as the 2026-07-27
 * create-path FK defect, which is why this is pinned at runtime and not just in a docstring.
 *
 * ## 2. The four-step insert order
 *
 * `areas` → `devices` → `legacy_handles` → `area_members`, each required by the NEXT one's foreign key.
 * The fake exec below ENFORCES those FKs, which is what makes this a real test rather than a
 * transcription of the implementation: run it against the pre-fix ordering (handle mapping first) and it
 * fails with 23503, exactly as `POST /api/systems` and both connect callbacks did on production.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { areaMembers, areas, devices } from "@/lib/db/planetscale/schema";
import { Device, type DeviceId } from "@/lib/ids";

const ops: string[] = [];
const store = {
  areas: new Set<string>(),
  devices: new Map<string, number>(), // uuid -> rid
  handles: new Map<
    number,
    { deviceId: string | null; areaId: string | null }
  >(),
  members: [] as { areaId: string; deviceId: string }[],
};

function fkViolation(constraint: string): Error {
  const err = new Error(
    `insert or update violates foreign key constraint "${constraint}"`,
  ) as Error & { code?: string };
  err.code = "23503";
  return err;
}

/** Minimal in-memory stand-in for the four tables a create touches, WITH every FK enforced. */
const exec = {
  select: () => ({
    from: () =>
      Object.assign(Promise.resolve([{ maxRid: null }]), {
        where: () =>
          Object.assign(Promise.resolve([]), { limit: async () => [] }),
      }),
  }),
  insert: (table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      // Table IDENTITY, not a name string: drizzle's internal shape is not part of its public API.
      const name =
        table === areas
          ? "areas"
          : table === devices
            ? "devices"
            : table === areaMembers
              ? "area_members"
              : "?";
      const run = async () => {
        if (name === "areas") {
          ops.push("areas");
          store.areas.add(v.id as string);
        } else if (name === "devices") {
          ops.push("devices");
          if (!store.areas.has(v.primaryAreaId as string))
            throw fkViolation("devices_primary_area_id_areas_id_fk");
          store.devices.set(v.id as string, v.rid as number);
        } else if (name === "area_members") {
          ops.push("area_members");
          if (!store.devices.has(v.deviceId as string))
            throw fkViolation("area_members_device_id_devices_id_fk");
          if (!store.areas.has(v.areaId as string))
            throw fkViolation("area_members_area_id_areas_id_fk");
          store.members.push({
            areaId: v.areaId as string,
            deviceId: v.deviceId as string,
          });
        }
      };
      // ONE execution, whether or not the caller chains a conflict clause: `run()` is started here and
      // both chain methods hand back that same promise. Returning `run` itself would insert twice for
      // any `.onConflictDoNothing()` caller and silently duplicate the op log.
      const started = run();
      return Object.assign(started, {
        onConflictDoNothing: () => started,
        onConflictDoUpdate: () => started,
      });
    },
  }),
  execute: async () => ({ rows: [] }),
} as unknown as never;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(exec),
  }),
}));

// Dev path, so the rid comes from `max(devices.rid)` and the test needs no sequence.
jest.mock("@/lib/env", () => ({ isProduction: () => false }));

// The handle mapping is DeviceRegistry's, but its FK on `devices(id)` is the edge that broke prod, so it
// is enforced here rather than stubbed away.
jest.mock("@/lib/registry/device-registry", () => ({
  DeviceRegistry: {
    ensureDeviceForHandle: async (
      handle: number,
      _tx: unknown,
      cand: DeviceId,
    ) => {
      ops.push("legacy_handles.device_id");
      // `cand` is a TypeID, whose payload is base32 — decode it rather than string-stripping `dv_`.
      const uuid = Device.toUuid(cand);
      if (!store.devices.has(uuid))
        throw fkViolation("legacy_handles_device_id_devices_id_fk");
      const cur = store.handles.get(handle) ?? { deviceId: null, areaId: null };
      store.handles.set(handle, { ...cur, deviceId: uuid });
    },
    ensureAreaForHandle: async (handle: number, areaId: string) => {
      ops.push("legacy_handles.area_id");
      if (!store.areas.has(areaId))
        throw fkViolation("legacy_handles_area_id_areas_id_fk");
      const cur = store.handles.get(handle) ?? { deviceId: null, areaId: null };
      store.handles.set(handle, { ...cur, areaId });
    },
  },
}));

import { DeviceWriter } from "../device-writer";
import { specFromLegacyText } from "@/lib/capabilities/config";

beforeEach(() => {
  ops.length = 0;
  store.areas.clear();
  store.devices.clear();
  store.handles.clear();
  store.members.length = 0;
});

const CREATE = {
  ownerClerkUserId: "user_test",
  vendorType: "selectronic",
  vendorSiteId: "site-1",
  displayName: "Test device",
};

describe("DeviceWriter.createSystem — the returned handle", () => {
  it("returns `id` as the INTEGER rid, never the device uuid", async () => {
    const created = await DeviceWriter.createSystem(CREATE);

    // The load-bearing assertion. A `devices` row's own `id` is a uuid; `.id` here must not be it.
    expect(typeof created.id).toBe("number");
    expect(Number.isInteger(created.id)).toBe(true);
    expect(created.id).toBe(10000); // dev-id policy floor, from max(devices.rid) == null

    // ...and the uuid is still reachable, just under a name that cannot be mistaken for a handle.
    expect(created.deviceUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.id).not.toBe(created.deviceUuid as unknown);
    expect(store.devices.get(created.deviceUuid)).toBe(created.id);
  });

  it("files the device under the rid it returns", async () => {
    const created = await DeviceWriter.createSystem(CREATE);
    expect(store.handles.get(created.id)?.deviceId).toBe(created.deviceUuid);
  });
});

describe("DeviceWriter.createSystem — the four-step insert order", () => {
  it("writes areas → devices → legacy_handles → area_members", async () => {
    await DeviceWriter.createSystem(CREATE);
    expect(ops).toEqual([
      "areas",
      "devices",
      "legacy_handles.device_id",
      "legacy_handles.area_id",
      "area_members",
    ]);
  });

  it("mints the area-of-one and joins the device to it", async () => {
    const created = await DeviceWriter.createSystem(CREATE);
    expect(store.areas.has(created.areaId)).toBe(true);
    expect(store.members).toEqual([
      { areaId: created.areaId, deviceId: created.deviceUuid },
    ]);
  });
});

describe("specFromLegacyText", () => {
  it("parses the three legacy free-text columns the way the retired SQL did", () => {
    expect(
      specFromLegacyText({
        ratings: "7.5kW, 48V",
        solarSize: "9 kW",
        batterySize: "63.6 kWh",
      }),
    ).toEqual({
      solarSizeKw: 9,
      batterySizeKwh: 63.6,
      inverterSizeKw: 7.5,
      batteryVoltageV: 48,
    });
  });

  it("rejects non-positive values rather than storing 0 (system 3's '-0.0 kW')", () => {
    expect(specFromLegacyText({ solarSize: "-0.0 kW" })).toBeUndefined();
  });

  it("returns undefined when nothing parses, so no empty `spec` is written", () => {
    expect(specFromLegacyText({})).toBeUndefined();
    expect(specFromLegacyText({ ratings: "unknown" })).toBeUndefined();
  });

  it("does not let the `kw` pattern match the 'kw' inside 'kwh'", () => {
    expect(specFromLegacyText({ ratings: "63.6 kWh" })).toBeUndefined();
  });
});
