import { describe, expect, it } from "@jest/globals";
import { Device } from "@/lib/ids";
import { DeviceRegistry } from "../device-registry";

function fakeExec() {
  const rows = new Map<
    number,
    { handle: number; deviceId: string | null; areaId: string | null }
  >();
  const exec: any = {
    insert() {
      return {
        values(value: { handle: number; deviceId?: string; areaId?: string }) {
          return {
            async onConflictDoUpdate() {
              const current = rows.get(value.handle) ?? {
                handle: value.handle,
                deviceId: null,
                areaId: null,
              };
              rows.set(value.handle, {
                ...current,
                deviceId: current.deviceId ?? value.deviceId ?? null,
                areaId: current.areaId ?? value.areaId ?? null,
              });
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            // The predicate is honoured, not ignored: drizzle's `eq(col, v)` carries its operands in
            // `queryChunks`, so the fake can pull the handle out and filter. Without this, a resolver
            // that dropped its WHERE (or matched the wrong handle) would still pass every test — the
            // fake would hand back the single stored row regardless.
            where: (cond: unknown) => {
              const wanted = handleFromCondition(cond);
              const all = [...rows.values()].filter(
                (r) => wanted === undefined || r.handle === wanted,
              );
              // Awaitable directly (addrsForHandles) or chained with .limit (resolveHandle).
              return Object.assign(Promise.resolve(all), {
                limit: async (n: number) => all.slice(0, n),
              });
            },
          };
        },
      };
    },
  };
  return { exec, rows };
}

/** Dig the numeric handle out of a drizzle `eq(...)`/`inArray(...)` condition. */
function handleFromCondition(cond: unknown): number | undefined {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const c of chunks) {
    const v = (c as { value?: unknown })?.value;
    if (typeof v === "number") return v;
    if (Array.isArray(v) && typeof v[0] === "number") return v[0] as number;
  }
  return undefined;
}

describe("DeviceRegistry", () => {
  it("preserves a stable device id across repeated writer retries", async () => {
    const { exec } = fakeExec();
    const first = Device.generate();
    const second = Device.generate();
    expect(
      (await DeviceRegistry.ensureDeviceForHandle(7, exec, first)).deviceId,
    ).toBe(first);
    expect(
      (await DeviceRegistry.ensureDeviceForHandle(7, exec, second)).deviceId,
    ).toBe(first);
  });

  it("merges colliding area/device handles without overwriting either identity", async () => {
    const { exec, rows } = fakeExec();
    const device = Device.generate();
    const areaId = "018f1f2e-7a3b-7000-8000-000000000001";
    await DeviceRegistry.ensureAreaForHandle(8, areaId, exec);
    await DeviceRegistry.ensureDeviceForHandle(8, exec, device);
    expect(rows.get(8)).toEqual({
      handle: 8,
      deviceId: Device.toUuid(device),
      areaId,
    });
  });

  describe("resolveHandle", () => {
    const areaId = "018f1f2e-7a3b-7000-8000-000000000002";

    it("returns only the column that is filled", async () => {
      const { exec } = fakeExec();
      const device = Device.generate();
      await DeviceRegistry.ensureDeviceForHandle(9, exec, device);
      expect(await DeviceRegistry.resolveHandle(9, exec)).toEqual({
        deviceId: device,
      });
    });

    it("reports BOTH targets for a handle that names an area and a device", async () => {
      const { exec } = fakeExec();
      const device = Device.generate();
      await DeviceRegistry.ensureAreaForHandle(10, areaId, exec);
      await DeviceRegistry.ensureDeviceForHandle(10, exec, device);
      // Area-first is the caller's contract, but both must be visible: resolving such a handle as the
      // bare device would narrow a `?systemId=N` request from the area's bindings to one device.
      expect(await DeviceRegistry.resolveHandle(10, exec)).toEqual({
        areaId,
        deviceId: device,
      });
    });

    it("returns null for an unmapped handle", async () => {
      const { exec } = fakeExec();
      expect(await DeviceRegistry.resolveHandle(11, exec)).toBeNull();
    });

    it("resolves the REQUESTED handle when several are mapped", async () => {
      // The non-vacuity case: with only one row stored, a resolver that ignored its WHERE would still
      // look correct. Store three and demand the right one.
      const { exec } = fakeExec();
      const d9 = Device.generate();
      const d11 = Device.generate();
      await DeviceRegistry.ensureDeviceForHandle(9, exec, d9);
      await DeviceRegistry.ensureAreaForHandle(10, areaId, exec);
      await DeviceRegistry.ensureDeviceForHandle(11, exec, d11);
      expect(await DeviceRegistry.resolveHandle(9, exec)).toEqual({
        deviceId: d9,
      });
      expect(await DeviceRegistry.resolveHandle(10, exec)).toEqual({ areaId });
      expect(await DeviceRegistry.resolveHandle(11, exec)).toEqual({
        deviceId: d11,
      });
    });
  });
});
