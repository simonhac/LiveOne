/**
 * ONE-SHOT equivalence: the v4-native `buildAreaStrategy` produces exactly what the v3 builder +
 * `rewriteV3ToV4` produced. **This file is deleted in the very next commit of this PR**, together with
 * the v3 goldens it compares against — after the change there is no second producer left to disagree
 * with, so this check can only ever run once. It runs.
 *
 * `want3` is the verbatim v3 golden the pre-Phase-14 `buildAreaStrategy` emitted for each context
 * (previously pinned by this file), with the placeholder `"area-uuid"` swapped for a real uuid so the
 * rewriter's strict area-ref decode accepts it. `ctx` is the same context expressed in v4 terms.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import type { CapabilityId } from "@/lib/capabilities/registry";
import type { DashboardV3 } from "@/lib/dashboard/v3";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import { rewriteV3ToV4, pureAreaRef } from "@/lib/dashboard/v3-to-v4";
import { normalizeDocV4 } from "@/lib/dashboard/v4-validate";
import { Area, Device } from "@/lib/ids";

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);

const AREA_UUID = "01980000-0000-7000-8000-000000000001";
const GRID_DEVICE_UUID = "01980000-0000-7000-8000-00000000000c";
const A = Area.encode(AREA_UUID);
const GRID_DEVICE = Device.encode(GRID_DEVICE_UUID);
/** The strategy's only device pin is the OE region device (legacy handle 12 in these goldens). */
const resolver = {
  areaRef: pureAreaRef,
  deviceRef: (handle: number) => {
    if (handle !== 12) throw new Error(`unexpected device pin: ${handle}`);
    return GRID_DEVICE;
  },
};

const golden = (json: string): DashboardV3 => JSON.parse(json) as DashboardV3;

/** The seed path's wrapping: one strategy group under a column root, then id assignment. */
const docOf = (ctx: AreaStrategyContext): DashboardV4 =>
  normalizeDocV4({
    version: 4,
    root: {
      kind: "group",
      direction: "column",
      children: [buildAreaStrategy(ctx)],
    },
  });

const CASES: { name: string; ctx: AreaStrategyContext; want3: DashboardV3 }[] = [
  {
    name: "sidebar device + generator (device viewer)",
    ctx: {
      area: A,
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
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics","variant":"table"},{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"battery"},{"view":"house-to-grid"},{"view":"renewables"}]},{"type":"chart","id":"chart:lines","chart":{"variant":"lines"}},{"type":"generator-runs"}]}]}',
    ),
  },
  {
    name: "site multi-device + oe-grid tile",
    ctx: {
      area: A,
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
      gridDevice: GRID_DEVICE,
      leadWithDeviceMetrics: true,
    },
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics","variant":"table"},{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"hotWater"},{"view":"battery"},{"view":"house-to-grid"},{"view":"amber"},{"view":"ev"},{"view":"renewables"},{"view":"oe-grid","deviceSystemId":12}]},{"type":"chart","id":"chart:load","chart":{"variant":"stacked-areas","split":"load"}},{"type":"chart","id":"chart:generation","chart":{"variant":"stacked-areas","split":"generation"}}]}]}',
    ),
  },
  {
    name: "amber pricing-only",
    ctx: {
      area: A,
      capabilities: caps("grid/rate"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics","variant":"table"},{"type":"amber-now"},{"type":"amber-timeline"}]}]}',
    ),
  },
  {
    name: "instrumentation-only device (generator/sensor pack)",
    ctx: {
      area: A,
      capabilities: caps("instrumentation"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics","variant":"table"}]}]}',
    ),
  },
  {
    name: "instrumentation-only helper WITH battery/provenance — history card appended",
    ctx: {
      area: A,
      capabilities: caps("instrumentation", "battery/provenance"),
      aggregate: false,
      leadWithDeviceMetrics: true,
    },
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics","variant":"table"},{"type":"battery-provenance-history"}]}]}',
    ),
  },
  {
    name: "instrumentation-only device WITHOUT battery/provenance — no history card (no lead)",
    ctx: {
      area: A,
      capabilities: caps("instrumentation", "generator-running"),
      aggregate: false,
    },
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"device-metrics"},{"type":"generator-runs"}]}]}',
    ),
  },
  {
    name: "seed, full caps (all tiles, lines, no lead)",
    ctx: {
      area: A,
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
    want3: golden(
      '{"version":3,"sections":[{"areaId":"01980000-0000-7000-8000-000000000001","cards":[{"type":"tiles","tiles":[{"view":"solar"},{"view":"load"},{"view":"hotWater"},{"view":"battery"},{"view":"house-to-grid"},{"view":"amber"},{"view":"ev"},{"view":"renewables"}]},{"type":"chart","id":"chart:lines","chart":{"variant":"lines"}}]}]}',
    ),
  },
];

describe("v4-native buildAreaStrategy === rewriteV3ToV4(old v3 strategy)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(docOf(c.ctx)).toEqual(rewriteV3ToV4(c.want3, resolver));
    });
  }
});
