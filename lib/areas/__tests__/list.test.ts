import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * `listReadableAreas`' access set. The interesting half is the GRANTED leg: `devicesVisibleByUser`
 * also consults grants, but narrows the granted scope to rows in `devices`, so it can only ever
 * surface a handle that IS a device rid. An Area with no device behind its handle (a composite /
 * "Unified" area, or anything from the >=1,000,000 area-handle allocator) is dropped there, and
 * before this leg existed ownership was its only read path.
 *
 * The condition itself is a drizzle SQL object, so the observable contract is which handles reach
 * `inArray(legacyHandles.handle, ...)` — captured here by mocking that one operator.
 */
let visibleDevices: { id: number }[] = [];
let grantedScope = new Set<number>();
let capturedHandles: number[] | null = null;

jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    devicesVisibleByUser: () => Promise.resolve(visibleDevices),
  },
}));
jest.mock("@/lib/dashboard/grants", () => ({
  grantedDeviceScopeForUser: () => Promise.resolve(grantedScope),
}));
jest.mock("@/lib/capabilities/server", () => ({
  hasChartCapability: () => Promise.resolve(true),
}));
jest.mock("drizzle-orm", () => {
  const actual =
    jest.requireActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    inArray: (col: unknown, values: number[]) => {
      capturedHandles = values;
      return actual.inArray(col as never, values);
    },
  };
});
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.from = () => builder;
    builder.leftJoin = () => builder;
    builder.where = () => Promise.resolve([]);
    return builder;
  },
}));

import { listReadableAreas } from "../list";

const USER = "user_dev";

describe("listReadableAreas access set", () => {
  beforeEach(() => {
    visibleDevices = [];
    grantedScope = new Set();
    capturedHandles = null;
  });

  it("unions the RAW granted scope, so a non-device-backed Area handle survives", async () => {
    visibleDevices = [{ id: 13 }]; // a device-backed area (Kutis)
    // Handles a granted dashboard puts in scope: its own device (13) plus two Areas that have no
    // device row at all — an early composite (8) and an area-allocator handle (1_000_002).
    grantedScope = new Set([13, 8, 1_000_002]);

    await listReadableAreas(USER);

    expect(capturedHandles).not.toBeNull();
    expect(new Set(capturedHandles!)).toEqual(new Set([13, 8, 1_000_002]));
  });

  it("deduplicates a handle that is both a visible device and in the granted scope", async () => {
    visibleDevices = [{ id: 13 }];
    grantedScope = new Set([13]);

    await listReadableAreas(USER);

    expect(capturedHandles).toEqual([13]);
  });

  it("still covers visible devices when the user has no grants", async () => {
    visibleDevices = [{ id: 1 }, { id: 5 }];

    await listReadableAreas(USER);

    expect(new Set(capturedHandles!)).toEqual(new Set([1, 5]));
  });

  it("falls back to ownership alone when there is nothing to match on", async () => {
    // Neither leg contributes a handle -> no inArray at all (ownership is the whole condition).
    await listReadableAreas(USER);

    expect(capturedHandles).toBeNull();
  });
});
