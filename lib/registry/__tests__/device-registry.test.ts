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
            where: async () => [...rows.values()],
          };
        },
      };
    },
  };
  return { exec, rows };
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
});
