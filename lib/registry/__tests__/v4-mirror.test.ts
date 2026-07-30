/**
 * Regression guard for the write ORDER inside `ensureDeviceRow`.
 *
 * `legacy_handles.device_id` FKs `devices(id)` (migration 0036), so the handle mapping may only be
 * written once the `devices` row exists. The fake exec below enforces that FK, which is what makes this
 * a real test: against the pre-fix ordering (`ensureDeviceForHandle` first) it fails with 23503, exactly
 * as `POST /api/systems` did on production.
 */
import { describe, expect, it } from "@jest/globals";
import {
  areaMembers,
  areas,
  devices,
  legacyHandles,
  systems,
} from "@/lib/db/planetscale/schema";
import { ensureDeviceRow } from "../v4-mirror";

const SYSTEM_ID = 4242;

/** Minimal in-memory stand-in for the three tables `ensureDeviceRow` touches, WITH the FK enforced. */
function fakeExec() {
  const store = {
    devices: new Map<string, { id: string; rid: number }>(),
    legacyHandles: new Map<
      number,
      { handle: number; deviceId: string | null; areaId: string | null }
    >(),
    areas: [] as { id: string; legacySystemId: number }[],
    areaMembers: [] as { areaId: string; deviceId: string }[],
  };
  const ops: string[] = [];

  function rowsFor(table: unknown): unknown[] {
    if (table === devices) return [...store.devices.values()];
    if (table === legacyHandles) return [...store.legacyHandles.values()];
    if (table === areas) return store.areas;
    if (table === systems)
      return [
        {
          owner: "user_test",
          name: "Test device",
          tzOffset: 600,
          tz: "Australia/Melbourne",
          location: null,
        },
      ];
    return [];
  }

  const exec: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const all = rowsFor(table);
          return Object.assign(Promise.resolve(all), {
            limit: async (n: number) => all.slice(0, n),
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: any) => {
        const apply = async () => {
          if (table === legacyHandles) {
            if (value.deviceId != null) {
              ops.push("legacy_handles.device_id");
              if (!store.devices.has(value.deviceId)) {
                const err: any = new Error(
                  'insert or update on table "legacy_handles" violates foreign key constraint "legacy_handles_device_id_devices_id_fk"',
                );
                err.code = "23503";
                throw err;
              }
            }
            const current = store.legacyHandles.get(value.handle) ?? {
              handle: value.handle,
              deviceId: null,
              areaId: null,
            };
            store.legacyHandles.set(value.handle, {
              ...current,
              deviceId: current.deviceId ?? value.deviceId ?? null,
              areaId: current.areaId ?? value.areaId ?? null,
            });
          } else if (table === areas) {
            ops.push("areas");
            store.areas.push({ id: value.id, legacySystemId: SYSTEM_ID });
          } else if (table === areaMembers) {
            ops.push("area_members");
            if (!store.devices.has(value.deviceId))
              throw Object.assign(
                new Error("area_members.device_id violates FK"),
                { code: "23503" },
              );
            store.areaMembers.push({
              areaId: value.areaId,
              deviceId: value.deviceId,
            });
          }
        };
        return { onConflictDoNothing: apply, onConflictDoUpdate: apply };
      },
    }),
    // The `devices` upsert is raw SQL; pull the uuid out of the bound parameters.
    execute: async (query: any) => {
      const text = (query.queryChunks ?? [])
        .map((c: any) => (Array.isArray(c?.value) ? c.value.join("") : ""))
        .join(" ");
      if (!text.includes("INSERT INTO devices"))
        throw new Error(`unexpected raw SQL: ${text.slice(0, 80)}`);
      // Interpolated values sit in `queryChunks` as bare strings (SQL literals are `StringChunk`s).
      // The device uuid is the FIRST interpolated value in the statement (`primary_area_id` follows).
      const uuid = (query.queryChunks ?? []).find(
        (c: any) => typeof c === "string" && /^[0-9a-f-]{36}$/.test(c),
      ) as string | undefined;
      if (!uuid) throw new Error("no device uuid bound in the devices INSERT");
      ops.push("devices");
      store.devices.set(uuid, { id: uuid, rid: SYSTEM_ID });
      return { rows: [] };
    },
  };
  return { exec, store, ops };
}

describe("ensureDeviceRow", () => {
  it("inserts `devices` BEFORE filling legacy_handles.device_id (FK 0036)", async () => {
    const { exec, store, ops } = fakeExec();

    const uuid = await ensureDeviceRow(SYSTEM_ID, exec);

    expect(ops.indexOf("devices")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("devices")).toBeLessThan(
      ops.indexOf("legacy_handles.device_id"),
    );
    expect(store.devices.has(uuid)).toBe(true);
    expect(store.legacyHandles.get(SYSTEM_ID)?.deviceId).toBe(uuid);
    // The area-of-one and its membership edge both land, and the edge comes last.
    expect(store.areas).toHaveLength(1);
    expect(store.areaMembers).toEqual([
      { areaId: store.areas[0].id, deviceId: uuid },
    ]);
  });

  it("re-adopts the recorded uuid instead of minting a second identity", async () => {
    const { exec, store } = fakeExec();
    const first = await ensureDeviceRow(SYSTEM_ID, exec);
    const second = await ensureDeviceRow(SYSTEM_ID, exec);
    expect(second).toBe(first);
    expect(store.devices.size).toBe(1);
  });

  it("re-adopts by rid when the handle mapping is missing (devices_rid_unique)", async () => {
    const { exec, store } = fakeExec();
    const uuid = await ensureDeviceRow(SYSTEM_ID, exec);
    store.legacyHandles.delete(SYSTEM_ID);
    expect(await ensureDeviceRow(SYSTEM_ID, exec)).toBe(uuid);
    expect(store.devices.size).toBe(1);
  });
});
