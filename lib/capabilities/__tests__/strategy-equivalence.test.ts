/**
 * Golden test for buildAreaStrategy — the capability-driven default-dashboard builder.
 *
 * WHY THESE GOLDENS CAN BE TRUSTED. They are `GroupNode`s, and they descend unbroken from the
 * descriptors captured off the earlier vendor-keyed builder: when the strategy moved to emitting
 * groups natively, a one-shot assertion checked that the new builder reproduced the rewritten old
 * golden for every case below, and was deleted along with those old goldens once it passed. So these
 * values were not hand-authored from the implementation they now guard. Each case pairs a capability
 * context with the exact group it must produce.
 *
 * Node ids are absent by design: `normalizeDocV4` mints the `n_…` ids when the seed path wraps this
 * group into a document (lib/dashboard/v4-seed.ts).
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import {
  RUN_TRACKING_CAPABILITY,
  type CapabilityId,
} from "@/lib/capabilities/registry";
import { TRACKABLE_ROLE_IDS } from "@/lib/roles/registry";
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
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics","config":{"variant":"table"}},{"kind":"group","direction":"row","wrap":true,"children":[{"kind":"card","type":"solar"},{"kind":"card","type":"load"},{"kind":"card","type":"battery"},{"kind":"card","type":"house-to-grid"},{"kind":"card","type":"renewables"}]},{"kind":"card","type":"chart","config":{"variant":"lines"}},{"kind":"card","type":"runs","config":{"role":"generator"}}]}',
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
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics"},{"kind":"card","type":"runs","config":{"role":"generator"}}]}',
    ),
  },
  {
    // Kinkora's shape: an EV detector on a member, so the site gets a `runs` card for the EV and
    // NOT one for a generator it doesn't have. Pinning is deliberately absent — see `runsCards`.
    name: "EV charge tracking (no generator)",
    ctx: {
      area: A,
      capabilities: caps(
        "solar/power",
        "load/power",
        "battery/soc",
        "battery/power",
        "grid/power",
        "ev-charging",
      ),
      aggregate: false,
    },
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"group","direction":"row","wrap":true,"children":[{"kind":"card","type":"solar"},{"kind":"card","type":"load"},{"kind":"card","type":"battery"},{"kind":"card","type":"house-to-grid"},{"kind":"card","type":"renewables"}]},{"kind":"card","type":"chart","config":{"variant":"lines"}},{"kind":"card","type":"runs","config":{"role":"ev"}}]}',
    ),
  },
  {
    // Both detectors on one area: two runs cards, in registry order, distinguished only by config.
    name: "both trackable roles → one runs card each",
    ctx: {
      area: A,
      capabilities: caps("instrumentation", "generator-running", "ev-charging"),
      aggregate: false,
    },
    want: golden(
      '{"kind":"group","area":"ar_01k0000000e008000000000001","heading":true,"children":[{"kind":"card","type":"device-metrics"},{"kind":"card","type":"runs","config":{"role":"generator"}},{"kind":"card","type":"runs","config":{"role":"ev"}}]}',
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

  /**
   * The half of the trackable-role ⇄ capability agreement that TypeScript can't state.
   *
   * `RUN_TRACKING_CAPABILITY` is a total `Record<TrackableRoleId, …>`, so a capability without a
   * role is a compile error. The reverse — marking a role `device.trackable` in the role registry
   * and forgetting to give it a capability here — is not, and it fails SILENTLY: the detector runs,
   * writes intervals, publishes its running point, and the card it exists to feed is simply never
   * eligible. (`lib/capabilities/registry.ts` carries the matching note.)
   */
  it("every trackable role advertises a capability", () => {
    for (const role of TRACKABLE_ROLE_IDS) {
      expect(
        RUN_TRACKING_CAPABILITY[role as keyof typeof RUN_TRACKING_CAPABILITY],
      ).toBeTruthy();
    }
  });

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
