/**
 * Equivalence gate for buildAreaStrategy vs the vendor-keyed buildDefaultDashboardV3.
 *
 * Proves the capability-driven strategy reproduces the current default-dashboard builder byte-for-byte
 * across the representative contexts — so the P4 cutover (repoint callers at buildAreaStrategy) doesn't
 * change what a fresh dashboard / the /device viewer produces. Matched pairs: the OLD opts and the NEW
 * capability context that should yield the identical descriptor.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildDefaultDashboardV3,
  type BuildDefaultV3Opts,
} from "@/lib/dashboard/v3";
import { getLayout } from "@/lib/dashboard/cards";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import type { CapabilityId } from "@/lib/capabilities/registry";

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);
const A = "area-uuid";

// Each case: the OLD opts, and the NEW context that must produce the identical descriptor.
const CASES: {
  name: string;
  old: BuildDefaultV3Opts;
  ctx: AreaStrategyContext;
}[] = [
  {
    name: "sidebar device + generator (device viewer)",
    old: {
      areaId: A,
      vendorType: "selectronic",
      availableViews: ["solar", "load", "battery", "house-to-grid"],
      hasGenerator: true,
      leadWithDeviceMetrics: true,
    },
    ctx: {
      areaId: A,
      capabilities: caps(
        "solar/power",
        "load/power",
        "battery/soc",
        "battery/power",
        "grid/power",
        "generator-running",
      ),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
  },
  {
    name: "site multi-device + oe-grid tile",
    old: {
      areaId: A,
      vendorType: "area",
      availableViews: [
        "solar",
        "load",
        "hotWater",
        "battery",
        "house-to-grid",
        "amber",
        "ev",
      ],
      gridDeviceSystemId: 12,
      hasGenerator: false,
      leadWithDeviceMetrics: true,
    },
    ctx: {
      areaId: A,
      capabilities: caps(
        "solar/power",
        "load/power",
        "load.hws/temperature",
        "battery/soc",
        "battery/power",
        "grid/power",
        "grid/rate",
        "ev/soc",
      ),
      aggregate: true,
      gridDeviceSystemId: 12,
      leadWithDeviceMetrics: true,
    },
  },
  {
    name: "amber pricing-only",
    old: { areaId: A, vendorType: "amber", leadWithDeviceMetrics: true },
    ctx: {
      areaId: A,
      capabilities: caps("grid/rate"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
  },
  {
    name: "instrumentation-only device (generator/sensor pack)",
    old: {
      areaId: A,
      vendorType: "deepsea",
      availableViews: [],
      hasGenerator: false,
      leadWithDeviceMetrics: true,
    },
    ctx: {
      areaId: A,
      capabilities: caps("instrumentation"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
  },
  {
    name: "seed with full caps == old no-availableViews (all tiles, lines)",
    old: { areaId: A, vendorType: "selectronic" },
    ctx: {
      areaId: A,
      capabilities: caps(
        "solar/power",
        "load/power",
        "load.hws/temperature",
        "battery/soc",
        "grid/power",
        "grid/rate",
        "ev/soc",
      ),
      aggregate: false,
    },
  },
];

describe("buildAreaStrategy reproduces buildDefaultDashboardV3", () => {
  for (const c of CASES) {
    it(c.name, () => {
      // Sanity: the aggregate flag must correspond to the old vendor→layout for the matched pair.
      if (c.old.vendorType !== "amber") {
        expect(c.ctx.aggregate).toBe(getLayout(c.old.vendorType) === "site");
      }
      expect(buildAreaStrategy(c.ctx)).toEqual(buildDefaultDashboardV3(c.old));
    });
  }
});
