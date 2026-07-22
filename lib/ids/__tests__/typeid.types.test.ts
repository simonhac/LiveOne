import { describe, it, expect } from "@jest/globals";
import { Device, Point, type DeviceId, type PointId } from "@/lib/ids";

/**
 * Compile-time guarantees. ts-jest type-checks this file, so a `@ts-expect-error` that does NOT error
 * fails the build — i.e. these tests fail exactly when the brands stop being nominally distinct. That
 * distinctness is the whole reason for TypeIDs: a device id can never be silently used as a point id.
 */
describe("branded id types (compile-time)", () => {
  it("accepts a same-entity id and yields a plain uuid string", () => {
    const dv: DeviceId = Device.generate();
    const uuid: string = Device.toUuid(dv);
    expect(typeof uuid).toBe("string");
  });

  it("rejects a DeviceId where a PointId is expected", () => {
    const dv = Device.generate();
    expect(() =>
      // @ts-expect-error a DeviceId is not assignable to Point.toUuid's PointId parameter
      Point.toUuid(dv),
    ).toThrow();
  });

  it("rejects assigning a DeviceId to a PointId binding", () => {
    const dv = Device.generate();
    // @ts-expect-error a DeviceId cannot be assigned to a PointId
    const pt: PointId = dv;
    expect(typeof pt).toBe("string");
  });

  it("rejects a raw string where a branded id is expected", () => {
    const uuid =
      // @ts-expect-error a plain string is not a DeviceId
      Device.toUuid("dv_01h455vb4pex5vsknk084sn02q");
    expect(uuid).toBe("01890a5d-ac96-774b-bcce-b302099a8057");
  });
});
