/**
 * Contract guards for `DeviceWriter`, the writer that replaced the `systems` writers + mirror in
 * config-v4 Phase 12 slice 1a. Two things here are regression guards for defects that have already
 * reached production once each, and both are invisible to `tsc`.
 *
 * ## 1. `createDevice().id` must be the INTEGER handle
 *
 * Callers use the returned `.id` as a handle: `POST /api/devices` passes it to `deleteDevice` on the
 * rollback path, and both OAuth callbacks pass it to `storeTeslaTokens` / `storeEnphaseTokens` as the
 * device id credentials are filed under. The writer now INSERTS `devices`, whose own `id` column is a
 * uuid — so the natural "return the row I just inserted" refactor silently swaps an int for a uuid.
 * Several of those call sites forward `.id` into `number` parameters only by inference, so `tsc` does
 * not catch it: it compiles and fails at runtime. That is the same failure shape as the 2026-07-27
 * create-path FK defect, which is why this is pinned at runtime and not just in a docstring.
 *
 * ## 2. The two-step insert order
 *
 * `devices` → `legacy_handles`, the second required by the first's foreign key. The fake exec below
 * ENFORCES those FKs, which is what makes this a real test rather than a transcription of the
 * implementation: run it against the pre-fix ordering (handle mapping first) and it fails with
 * 23503, exactly as `POST /api/devices` and both connect callbacks did on production.
 *
 * Two of the original four steps are gone and the test asserts their ABSENCE, because in both cases
 * doing them again is silently wrong rather than loud. The `area_members` row went with Stage 4
 * (writing it would make it disagree with `devices.area_id` on the first re-home). The `areas`
 * insert — the eagerly-minted area-of-one — went with Stage 5, and with it the `legacy_handles` AREA
 * leg: a device is now placed in an area that ALREADY EXISTS and already owns a handle, so
 * re-asserting one would turn every second device in a site into a 23505 on
 * `legacy_handles_area_unique`.
 *
 * ## 3. Placement is decided by `resolveOnboardingArea`, and only for an OWNED device
 *
 * `devices.area_id` is membership, written inline with the device row. Two failure modes are pinned:
 *
 * - Leaving it NULL for an owned device. The insert still succeeds, the device still polls, nothing
 *   raises — it is simply in no area, and `ensureHelperDevice`, which dedupes on that column, misses
 *   every time and mints an unbounded run of helpers. That is what happened between the Stage-3
 *   resolver flip and Stage 4.
 * - Setting it for an OWNERLESS device. `assertDevicesRehomable` refuses to move one, so placing it
 *   at birth traps it in an area nothing — not even an admin — can free it from.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { areas, devices } from "@/lib/db/planetscale/schema";
import { Device, type DeviceId } from "@/lib/ids";

const ops: string[] = [];
const store = {
  areas: new Set<string>(),
  /** Areas in this set answer the status precheck with `archived` rather than `active`. */
  archivedAreas: new Set<string>(),
  /** Overrides the owner the precheck sees, for the transferred-area case. */
  areaOwners: new Map<string, string | null>(),
  devices: new Map<string, { rid: number; areaId: string | null }>(),
  handles: new Map<
    number,
    { deviceId: string | null; areaId: string | null }
  >(),
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
          Object.assign(Promise.resolve([]), {
            // 🛑 The area-status precheck reads `.limit(1).for("share")` and it MUST resolve to the
            // area the fake store holds, not to `[]` — a fake that answered "no such area" would
            // make the placement assertions below pass for the wrong reason (they would never reach
            // the insert). `ops` does not record it: it is a read, and the step-order assertion is
            // about writes.
            limit: () => {
              const rows = [...store.areas].map((id) => ({
                id,
                status: store.archivedAreas.has(id) ? "archived" : "active",
                // The fake's areas belong to whoever `CREATE` names, so the ownership leg of the
                // precheck passes unless a test says otherwise.
                ownerUserId:
                  store.areaOwners.get(id) ?? CREATE.ownerClerkUserId,
              }));
              return Object.assign(Promise.resolve(rows), {
                for: async () => rows,
              });
            },
          }),
      }),
  }),
  insert: (table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      // Table IDENTITY, not a name string: drizzle's internal shape is not part of its public API.
      const name =
        table === areas ? "areas" : table === devices ? "devices" : "?";
      const run = async () => {
        if (name === "areas") {
          ops.push("areas");
          store.areas.add(v.id as string);
        } else if (name === "devices") {
          ops.push("devices");
          // `devices.area_id` FKs `areas(id)`, so a device may only be placed in an area that
          // already exists — which since Stage 5 means one the writer did NOT create.
          if (v.areaId != null && !store.areas.has(v.areaId as string))
            throw fkViolation("devices_area_id_areas_id_fk");
          store.devices.set(v.id as string, {
            rid: v.rid as number,
            areaId: (v.areaId as string | null) ?? null,
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
    // Still stubbed even though the writer no longer calls it: the assertion that matters is that
    // `ops` never contains this, and a stub that throws would only prove the writer does not call a
    // throwing function.
    ensureAreaForHandle: async (handle: number, areaId: string) => {
      ops.push("legacy_handles.area_id");
      const cur = store.handles.get(handle) ?? { deviceId: null, areaId: null };
      store.handles.set(handle, { ...cur, areaId });
    },
  },
}));

// The area a new OWNED device is placed in. Stubbed rather than exercised — `resolveOnboardingArea`
// has its own tests — but it PRE-CREATES the area in the fake store, so the FK the writer's insert
// is subject to is real: a writer that placed a device in an area nobody created would 23503 here.
const ONBOARDING_AREA = "11111111-1111-7111-8111-111111111111";
const resolveOnboardingArea = jest.fn(
  async (): Promise<{
    areaId: string;
    createdAreaId: string | null;
    recordedAsDefault: boolean;
  }> => {
    ops.push("resolveOnboardingArea");
    store.areas.add(ONBOARDING_AREA);
    return {
      areaId: ONBOARDING_AREA,
      createdAreaId: ONBOARDING_AREA,
      recordedAsDefault: true,
    };
  },
);
jest.mock("@/lib/areas/onboarding", () => ({
  resolveOnboardingArea: (...args: unknown[]) =>
    (resolveOnboardingArea as (...a: unknown[]) => unknown)(...args),
}));

import { DeviceWriter } from "../device-writer";
import { specFromLegacyText } from "@/lib/capabilities/config";

beforeEach(() => {
  ops.length = 0;
  store.areas.clear();
  store.archivedAreas.clear();
  store.areaOwners.clear();
  store.devices.clear();
  store.handles.clear();
  resolveOnboardingArea.mockClear();
});

const CREATE = {
  ownerClerkUserId: "user_test",
  vendorType: "selectronic",
  vendorSiteId: "site-1",
  displayName: "Test device",
};

describe("DeviceWriter.createSystem — the returned handle", () => {
  it("returns `id` as the INTEGER rid, never the device uuid", async () => {
    const created = await DeviceWriter.createDevice(CREATE);

    // The load-bearing assertion. A `devices` row's own `id` is a uuid; `.id` here must not be it.
    expect(typeof created.id).toBe("number");
    expect(Number.isInteger(created.id)).toBe(true);
    expect(created.id).toBe(10000); // dev-id policy floor, from max(devices.rid) == null

    // ...and the uuid is still reachable, just under a name that cannot be mistaken for a handle.
    expect(created.deviceUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.id).not.toBe(created.deviceUuid as unknown);
    expect(store.devices.get(created.deviceUuid)?.rid).toBe(created.id);
  });

  it("files the device under the rid it returns", async () => {
    const created = await DeviceWriter.createDevice(CREATE);
    expect(store.handles.get(created.id)?.deviceId).toBe(created.deviceUuid);
  });
});

describe("DeviceWriter.createSystem — the two-step insert order", () => {
  it("resolves placement, then writes devices → legacy_handles.device_id, and nothing else", async () => {
    await DeviceWriter.createDevice(CREATE);
    expect(ops).toEqual([
      "resolveOnboardingArea",
      "devices",
      "legacy_handles.device_id",
    ]);
    // 🛑 `area_members` is frozen. A write here would make it disagree with `devices.area_id` — the
    // column every reader moved to — on the very first re-home.
    expect(ops).not.toContain("area_members");
    // 🛑 The writer does not create areas. Re-introducing the mint would give every new device its
    // own shell again — the 14-of-17 proliferation this change exists to end — and nothing would
    // fail: the device would work, in an area nobody asked for.
    expect(ops).not.toContain("areas");
    // 🛑 And it does not claim the handle's AREA leg. The area it places into already owns a handle,
    // so this would be a 23505 on `legacy_handles_area_unique` for the second device in any site.
    expect(ops).not.toContain("legacy_handles.area_id");
  });

  it("🛑 PLACES an owned device in the area onboarding resolved", async () => {
    const created = await DeviceWriter.createDevice(CREATE);
    expect(created.areaId).toBe(ONBOARDING_AREA);
    // The regression this pins: with `area_id` left NULL the insert still succeeds, the device still
    // polls, and nothing raises — it is simply in no area, and the helper dedupe that reads this
    // column mints a fresh helper on every call for ever.
    expect(store.devices.get(created.deviceUuid)?.areaId).toBe(ONBOARDING_AREA);
  });

  it("🛑 leaves an OWNERLESS device ambient, and never asks for an area", async () => {
    const created = await DeviceWriter.createDevice({
      ...CREATE,
      ownerClerkUserId: null,
      vendorType: "openelectricity",
    });
    expect(created.areaId).toBeNull();
    expect(store.devices.get(created.deviceUuid)?.areaId).toBeNull();
    // Not merely "ends up null": onboarding is not consulted at all. There is no owner to have a
    // default, and an area minted here would trap a device `assertDevicesRehomable` refuses to move.
    expect(resolveOnboardingArea).not.toHaveBeenCalled();
    expect(ops).toEqual(["devices", "legacy_handles.device_id"]);
  });

  it("🛑 REFUSES to create a device in an area that has been archived", async () => {
    // The race the in-transaction `FOR SHARE` precheck closes: `resolveOnboardingArea` validated
    // the owner's default in its OWN transaction, and the FK on `devices.area_id` checks existence,
    // not status. Without this the device is created active, in an archived site, invisible — and
    // with `primary_area_id` gone there is nothing left recording where it should have gone.
    resolveOnboardingArea.mockImplementationOnce(async () => {
      ops.push("resolveOnboardingArea");
      store.areas.add(ONBOARDING_AREA);
      store.archivedAreas.add(ONBOARDING_AREA);
      return {
        areaId: ONBOARDING_AREA,
        createdAreaId: null,
        recordedAsDefault: false,
      };
    });
    await expect(DeviceWriter.createDevice(CREATE)).rejects.toThrow(/archived/);
    expect(store.devices.size).toBe(0);
  });

  it("🛑 REFUSES to create a device in an area that now belongs to someone else", async () => {
    // Status alone was the first cut of the precheck and it misses this entirely: a bulk ownership
    // transfer (`lib/ownership/transfer.ts`) re-owns an area without touching its status, so an
    // area validated as the caller's default moments earlier can be somebody else's by the time
    // the insert runs — and the FK checks existence, not ownership.
    resolveOnboardingArea.mockImplementationOnce(async () => {
      ops.push("resolveOnboardingArea");
      store.areas.add(ONBOARDING_AREA);
      store.areaOwners.set(ONBOARDING_AREA, "user_someone_else");
      return {
        areaId: ONBOARDING_AREA,
        createdAreaId: null,
        recordedAsDefault: false,
      };
    });
    await expect(DeviceWriter.createDevice(CREATE)).rejects.toThrow(
      /another user/,
    );
    expect(store.devices.size).toBe(0);
  });

  it("a HELPER opts out of the active-area precheck — its area may be archived", async () => {
    // `recomputeAreaProvenance` on an archived area must not start failing because the area's own
    // derived-output device does not exist yet.
    store.areas.add(ONBOARDING_AREA);
    store.archivedAreas.add(ONBOARDING_AREA);
    const created = await DeviceWriter.createHelperDevice({
      ownerClerkUserId: "user_test",
      areaId: ONBOARDING_AREA,
      vendorSiteId: "helper:area:ar_archived",
      displayName: "Archived · derived",
      timezoneOffsetMin: 600,
    });
    expect(created.areaId).toBe(ONBOARDING_AREA);
  });

  it("places a HELPER directly in the area it serves, without consulting onboarding", async () => {
    store.areas.add(ONBOARDING_AREA);
    const created = await DeviceWriter.createHelperDevice({
      ownerClerkUserId: "user_test",
      areaId: ONBOARDING_AREA,
      vendorSiteId: "helper:area:ar_x",
      displayName: "Somewhere · derived",
      timezoneOffsetMin: 600,
    });
    expect(created.areaId).toBe(ONBOARDING_AREA);
    expect(store.devices.get(created.deviceUuid)?.areaId).toBe(ONBOARDING_AREA);
    // One insert, one area. The helper used to be minted into an area-of-one and MOVED here
    // afterwards, and the window between the two is where the duplicate-helper bug lived.
    expect(resolveOnboardingArea).not.toHaveBeenCalled();
    expect(ops).toEqual(["devices", "legacy_handles.device_id"]);
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
