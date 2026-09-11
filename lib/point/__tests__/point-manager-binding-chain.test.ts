/**
 * The serving path honours the binding CHAIN, not the whole binding set.
 *
 * `_resolvePointsForHandle` is where an Area's bindings become its points, and that set becomes both
 * its series list and the flow builder's inputs. The series id is
 * `{handle}/{logical_path}/{metric}.{agg}` (`getSeriesPath`) — it does not mention the source device
 * — so two bindings on one serving key produced two series under ONE id, and
 * `site-data-processor`'s `seriesMap.set(s.id, s)` kept whichever arrived last. That is how Kinkora's
 * `bidi.battery/soc` answered "304/304 days" and "81/304 days" to the same request on consecutive
 * calls. Pinned here at the point the set is chosen.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/** Every `inArray(col, values)` the resolution issued, in order. */
const inArrayCalls: string[][] = [];
jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
  inArray: jest.fn((_col: unknown, values: string[]) => {
    inArrayCalls.push(values);
    return { kind: "inArray", values };
  }),
}));

jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: async () => [] }) }),
    }),
  }),
}));
jest.mock("@/lib/db/planetscale/schema", () => ({
  pointInfo: {},
  points: { id: "p.id", deviceId: "p.device_id" },
  devices: { id: "d.id", rid: "d.rid" },
}));

const areaByHandle = jest.fn<(id: number) => Promise<{ id: string } | null>>();
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: {
    deviceByHandle: jest.fn(async () => null),
    areaByHandle: (id: number) => areaByHandle(id),
  },
}));

const getAreaBindingRefs = jest.fn<(id: number) => Promise<unknown[]>>();
jest.mock("@/lib/areas/bindings", () => ({
  getAreaBindingRefs: (id: number) => getAreaBindingRefs(id),
}));
jest.mock("@/lib/areas/members", () => ({
  getAreaMemberDeviceIds: jest.fn(async () => []),
}));
jest.mock("@/lib/registry", () => ({
  DeviceRegistry: { ridsForDevices: async () => new Map() },
}));

import { PointManager } from "../point-manager";
import { rankBindingChains } from "@/lib/areas/binding-chain";

const HANDLE = 8;

/** A binding row exactly as `getAreaBindingRefs` selects it, before ranking. */
const binding = (
  pointUid: string,
  logicalPath: string | null,
  metricType: string,
  priority: number,
  active = true,
) => ({
  pointUid,
  role: "battery",
  metricType,
  ordinal: 0,
  priority,
  logicalPath,
  active,
});

describe("_resolvePointsForHandle takes the chain WINNERS", () => {
  let pm: PointManager;

  beforeEach(() => {
    jest.clearAllMocks();
    inArrayCalls.length = 0;
    pm = PointManager.getInstance();
    areaByHandle.mockResolvedValue({ id: "area-a" });
  });

  const resolve = () =>
    (
      pm as unknown as {
        _resolvePointsForHandle: (h: number) => Promise<unknown[]>;
      }
    )._resolvePointsForHandle(HANDLE);

  it("selects one point per serving key, by priority", async () => {
    getAreaBindingRefs.mockResolvedValue(
      rankBindingChains([
        binding("uid-fronius", "bidi.battery", "soc", 1),
        binding("uid-mondo", "bidi.battery", "soc", 0),
      ]),
    );

    await resolve();

    expect(inArrayCalls).toEqual([["uid-mondo"]]);
  });

  it("keeps every binding whose serving key is its own", async () => {
    // Kinkora's load circuits. A "one winner per slot" rule would delete three of these.
    getAreaBindingRefs.mockResolvedValue(
      rankBindingChains([
        binding("uid-hvac", "load.hvac", "power", 0),
        binding("uid-pool", "load.pool", "power", 1),
        binding("uid-ev", "load.ev", "power", 2),
      ]),
    );

    await resolve();

    expect(inArrayCalls[0].sort()).toEqual(["uid-ev", "uid-hvac", "uid-pool"]);
  });

  it("does not let an inactive preferred binding cost the area the path", async () => {
    getAreaBindingRefs.mockResolvedValue(
      rankBindingChains([
        binding("uid-dead", "bidi.battery", "soc", 0, false),
        binding("uid-live", "bidi.battery", "soc", 1),
      ]),
    );

    await resolve();

    expect(inArrayCalls).toEqual([["uid-live"]]);
  });

  it("falls through to the member union only when there are no bindings at all", async () => {
    getAreaBindingRefs.mockResolvedValue([]);

    const points = await resolve();

    expect(inArrayCalls).toEqual([]);
    expect(points).toEqual([]);
  });
});
