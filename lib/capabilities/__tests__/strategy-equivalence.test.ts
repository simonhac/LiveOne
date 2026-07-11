/**
 * Golden test for buildAreaStrategy — the capability-driven default-dashboard builder.
 *
 * The golden descriptors were captured from the previous vendor-keyed builder (buildDefaultDashboardV3)
 * at the P4 cutover, where buildAreaStrategy was proven byte-identical to it across these contexts. That
 * builder is now deleted, so this pins the capability strategy's output directly: each case pairs a
 * capability context with the exact descriptor it must produce.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import type { CapabilityId } from "@/lib/capabilities/registry";
import type { DashboardV3 } from "@/lib/dashboard/v3";

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);
const A = "area-uuid";
const golden = (json: string): DashboardV3 => JSON.parse(json) as DashboardV3;

const CASES: { name: string; ctx: AreaStrategyContext; want: DashboardV3 }[] = [
  {
    name: "sidebar device + generator (device viewer)",
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
    want: golden(
      '{"version":3,"sections":[{"areaId":"area-uuid","cards":[{"type":"device-metrics","variant":"table"},{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"battery"},{"view":"house-to-grid"}]},{"type":"chart","id":"chart:lines","chart":{"variant":"lines"}},{"type":"generator-runs"}]}]}',
    ),
  },
  {
    name: "site multi-device + oe-grid tile",
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
    want: golden(
      '{"version":3,"sections":[{"areaId":"area-uuid","cards":[{"type":"device-metrics","variant":"table"},{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"hotWater"},{"view":"battery"},{"view":"house-to-grid"},{"view":"amber"},{"view":"ev"},{"view":"oe-grid","deviceSystemId":12}]},{"type":"chart","id":"chart:load","chart":{"variant":"stacked-areas","split":"load"}},{"type":"chart","id":"chart:generation","chart":{"variant":"stacked-areas","split":"generation"}}]}]}',
    ),
  },
  {
    name: "amber pricing-only",
    ctx: {
      areaId: A,
      capabilities: caps("grid/rate"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
    want: golden(
      '{"version":3,"sections":[{"areaId":"area-uuid","cards":[{"type":"device-metrics","variant":"table"},{"type":"amber-now"},{"type":"amber-timeline"}]}]}',
    ),
  },
  {
    name: "instrumentation-only device (generator/sensor pack)",
    ctx: {
      areaId: A,
      capabilities: caps("instrumentation"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
    want: golden(
      '{"version":3,"sections":[{"areaId":"area-uuid","cards":[{"type":"device-metrics","variant":"table"}]}]}',
    ),
  },
  {
    name: "seed, full caps (all tiles, lines, no lead)",
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
    want: golden(
      '{"version":3,"sections":[{"areaId":"area-uuid","cards":[{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"hotWater"},{"view":"battery"},{"view":"house-to-grid"},{"view":"amber"},{"view":"ev"}]},{"type":"chart","id":"chart:lines","chart":{"variant":"lines"}}]}]}',
    ),
  },
];

describe("buildAreaStrategy golden output", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(buildAreaStrategy(c.ctx)).toEqual(c.want);
    });
  }
});
