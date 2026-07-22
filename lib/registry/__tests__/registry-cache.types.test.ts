import { describe, it, expect } from "@jest/globals";
import type { PointRid, DeviceRid } from "../registry-cache";

// ts-jest type-checks this file, so an `@ts-expect-error` that FAILS to error breaks the build —
// that is how the PointRid ≠ DeviceRid brand distinctness is enforced as a test.
function takesPointRid(_r: PointRid): number {
  return _r;
}

describe("rid brand distinctness", () => {
  it("rejects a DeviceRid (or a bare number) where a PointRid is expected", () => {
    const dv = 5 as DeviceRid;
    // @ts-expect-error a DeviceRid is not assignable to a PointRid
    takesPointRid(dv);
    // @ts-expect-error a bare number is not a branded PointRid
    takesPointRid(7);
    expect(true).toBe(true);
  });
});
