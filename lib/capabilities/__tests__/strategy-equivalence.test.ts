/**
 * Golden test for buildAreaStrategy — the capability-driven default-dashboard builder.
 *
 * The goldens are v4 `GroupNode`s (config-v4 Phase 14 stage 8: the strategy emits v4 natively). They
 * descend, unbroken, from the descriptors captured off the vendor-keyed `buildDefaultDashboardV3` at
 * the P4 cutover: stage 8 landed a one-shot assertion that the v4 builder reproduced
 * `rewriteV3ToV4(<that v3 golden>)` for every case below, ran it, and deleted it with the v3 goldens
 * in the same PR — there is only one producer now, so a second address to disagree with no longer
 * exists. Each case pairs a capability context with the exact group it must produce.
 *
 * Node ids are absent by design: `normalizeDocV4` mints the `n_…` ids when the seed path wraps this
 * group into a document (lib/dashboard/v4-seed.ts).
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import type { CapabilityId } from "@/lib/capabilities/registry";
import type { GroupNode } from "@/lib/dashboard/v4";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { Area, Device } from "@/lib/ids";

const caps = (...ids: CapabilityId[]) => new Set<CapabilityId>(ids);
const A = Area.encode("01980000-0000-7000-8000-000000000001");
const GRID_DEVICE = Device.encode("01980000-0000-7000-8000-00000000000c");
const golden = (json: string): GroupNode => JSON.parse(json) as GroupNode;

const CASES: { name: string; ctx: AreaStrategyContext; want: GroupNode }[] = [
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}},{"kind":"group","direction":"row","wrap":true,"children":[{"kind":"card","type":"solar"},{"kind":"card","type":"load"},{"kind":"card","type":"battery"},{"kind":"card","type":"house-to-grid"},{"kind":"card","type":"renewables"}]},{"kind":"card","type":"chart","config":{"variant":"lines"}},{"kind":"card","type":"generator-runs"}]}',
    ),
  },
  {
    name: "site multi-device + oe-grid card",
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}},{"kind":"group","direction":"row","wrap":true,"children":[{"kind":"card","type":"solar"},{"kind":"card","type":"load"},{"kind":"card","type":"hotWater"},{"kind":"card","type":"battery"},{"kind":"card","type":"house-to-grid"},{"kind":"card","type":"amber"},{"kind":"card","type":"ev"},{"kind":"card","type":"renewables"},{"kind":"card","type":"oe-grid","device":"dv_01k0000000e00800000000000c"}]},{"kind":"card","type":"chart","config":{"variant":"stacked-areas","split":"load"}},{"kind":"card","type":"chart","config":{"variant":"stacked-areas","split":"generation"}}]}',
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}},{"kind":"card","type":"amber-now"},{"kind":"card","type":"amber-timeline"}]}',
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}}]}',
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}},{"kind":"card","type":"battery-provenance-history"}]}',
    ),
  },
  {
    name: "instrumentation-only device WITHOUT battery/provenance — no history card (no lead)",
    ctx: {
      area: A,
      capabilities: caps("instrumentation", "generator-running"),
      aggregate: false,
    },
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics"},{"kind":"card","type":"generator-runs"}]}',
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
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"group","direction":"row","wrap":true,"children":[{"kind":"card","type":"solar"},{"kind":"card","type":"load"},{"kind":"card","type":"hotWater"},{"kind":"card","type":"battery"},{"kind":"card","type":"house-to-grid"},{"kind":"card","type":"amber"},{"kind":"card","type":"ev"},{"kind":"card","type":"renewables"}]},{"kind":"card","type":"chart","config":{"variant":"lines"}}]}',
    ),
  },
];

describe("buildAreaStrategy golden output", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(buildAreaStrategy(c.ctx)).toEqual(c.want);
    });
  }

  // The strategy is machine-built, so it must only ever emit KNOWN card types carrying config their
  // per-type schema accepts: an unknown type would only warn, and a bad config would 422 on save.
  it("every golden is a valid v4 document with no warnings", () => {
    for (const c of CASES) {
      const r = validateDocV4({
        version: 4,
        root: { kind: "group", direction: "column", children: [c.want] },
      });
      expect({ name: c.name, errors: r.errors, warnings: r.warnings }).toEqual({
        name: c.name,
        errors: [],
        warnings: [],
      });
    }
  });
});
