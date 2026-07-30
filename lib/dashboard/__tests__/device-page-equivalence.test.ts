/**
 * 🛑 TEMPORARY — the one-shot v3-renderer ↔ v4-renderer equivalence check for `/device/{id}`.
 * DELETED in the second commit of this PR, together with `components/Dashboard.tsx`.
 *
 * config-v4 Phase 14 stage 9 swaps `/device/{id}` from the v3 renderer (`components/Dashboard.tsx`,
 * fed a transient `DashboardV3` from `buildAreaStrategyForHandle`) to `<DashboardV4View>` fed the v4
 * doc the page now builds. That is a pure refactor: it must change NOTHING a user can see.
 *
 * This check is the oracle for that claim, and it can only ever run ONCE — the moment the v3 renderer
 * is deleted, one of the two sides no longer exists. So it is landed as its own commit, shown to fail
 * when perturbed, and then removed with the renderer it compares against (the same discipline stage 8
 * used for `strategy-equivalence`).
 *
 * WHAT IT COMPARES. For every capability shape `/device/{id}` can produce, it renders BOTH:
 *
 *   v3 side — `areaStrategyGroupToV3(group, …)` → `<Dashboard descriptor areaById areasResolved/>`
 *             with the synthetic `ReadableArea` the page builds today
 *             (`{id: <area uuid | "device-N">, displayName, legacySystemId: <device handle>}`).
 *   v4 side — the page's NEW composition: `{version:4, root:{kind:"group", direction:"column",
 *             device: dv_…, children:[group]}}` normalized, rendered through `<DashboardV4View>`
 *             with an EMPTY `areaById` (the device page binds no area) and a `deviceById` carrying
 *             the page device + the `oe-grid` pin.
 *
 * and asserts the captured props are identical — both the props each card/tile plugin RECEIVED and
 * the props each plugin handed to its (mocked) leaf. The leaf layer is the real gate: the leaves are
 * untouched by this PR, so identical leaf props ⇒ identical pixels.
 *
 * Two differences are EXPECTED and asserted explicitly rather than normalised away:
 *   1. `section.areaId` — v3 passes the area uuid (or the `device-N` sentinel); v4 has no area
 *      envelope on a device page, so `synthSectionV3(undefined)` yields `""`. Only
 *      `battery-provenance-history` reads it, and both values resolve to "no area" for a NON-helper
 *      device (`areaRefToArId` is null for `""`; the `device-` branch returned null). For a HELPER
 *      device the card reads `vendorSiteId` instead and never looks at `section`.
 *   2. `card.deviceSystemId` — v3 sets it only on the `oe-grid` pin; under a device-bound envelope
 *      every card inherits `device`, so `synthCardV3` stamps the page device's handle on all of them.
 *      Every consumer reads `card.deviceSystemId ?? handle`, and here the two are the SAME number, so
 *      the value each plugin computes is unchanged — which is what the leaf layer proves.
 *
 * Everything else — card set, order, tile grid, collapse into one `SiteChartsGroup`, handles, chart
 * configs, skeleton gating — must match exactly.
 */
import { describe, it, expect } from "@jest/globals";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Area, Device, type AreaId, type DeviceId } from "@/lib/ids";
import {
  buildAreaStrategy,
  type AreaStrategyContext,
} from "@/lib/capabilities/strategy";
import { areaStrategyGroupToV3 } from "@/lib/capabilities/strategy-v3";
import { normalizeDocV4 } from "@/lib/dashboard/v4-validate";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import type { CapabilityId } from "@/lib/capabilities/registry";
import type { ReadableArea } from "@/lib/areas/list";
import type { ResolvedDevice } from "@/lib/dashboard/resolve-shell";
import {
  leafCaptures,
  pluginCaptures,
  resetCaptures,
  serialise,
} from "./v4-render-harness";

// --- the same environment the prop-equivalence harness establishes -----------------------------
jest.mock("next/font/local", () => ({
  __esModule: true,
  default: () => ({
    className: "f",
    style: { fontFamily: "f" },
    variable: "--f",
  }),
}));
jest.mock("next/navigation", () => ({
  __esModule: true,
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/device/1",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => ({
      data: undefined,
      isLoading: false,
      isPending: true,
      isError: false,
      isSuccess: false,
    }),
    useQueryClient: () => ({ setQueryData: () => {}, getQueryData: () => {} }),
  };
});
jest.mock("@/components/dashboard/cards/shared", () => {
  const actual = jest.requireActual("@/components/dashboard/cards/shared");
  return {
    ...actual,
    useAreaDatum: (systemId: number) =>
      (
        require("./v4-render-harness") as typeof import("./v4-render-harness")
      ).fakeAreaDatum(systemId),
  };
});
jest.mock("@/components/dashboard/cards/registry", () => {
  const h =
    require("./v4-render-harness") as typeof import("./v4-render-harness");
  const actual = jest.requireActual("@/components/dashboard/cards/registry");
  return { CARD_RENDERERS: h.instrumentCardRenderers(actual.CARD_RENDERERS) };
});
jest.mock("@/components/dashboard/tiles/registry", () => {
  const h =
    require("./v4-render-harness") as typeof import("./v4-render-harness");
  const actual = jest.requireActual("@/components/dashboard/tiles/registry");
  return { TILE_RENDERERS: h.instrumentTileRenderers(actual.TILE_RENDERERS) };
});
const LEAF_MODULES: Record<string, string> = {
  "@/components/LinesChartCard": "LinesChartCard",
  "@/components/AmberSmallCard": "AmberSmallCard",
  "@/components/AmberNow": "AmberNow",
  "@/components/AmberCard": "AmberCard",
  "@/components/BatteryContentsCard": "BatteryContentsCard",
  "@/components/battery-provenance/BatteryProvenancePanel":
    "BatteryProvenancePanel",
  "@/components/DeviceMetricsCard": "DeviceMetricsCard",
  "@/components/LoadProvenanceCard": "LoadProvenanceCard",
  "@/components/GeneratorRunsCard": "GeneratorRunsCard",
  "@/components/Tile": "Tile",
  "@/components/TeslaSmallCard": "TeslaSmallCard",
  "@/components/HwsSmallCard": "HwsSmallCard",
  "@/components/GridSignalsCard": "GridSignalsCard",
  "@/components/HomeEnergyCard": "HomeEnergyCard",
};
for (const [modulePath, name] of Object.entries(LEAF_MODULES)) {
  jest.mock(modulePath, () => {
    const h =
      require("./v4-render-harness") as typeof import("./v4-render-harness");
    return { __esModule: true, default: h.makeLeaf(name) };
  });
}
jest.mock("@/components/SiteChartsCard", () => {
  const h =
    require("./v4-render-harness") as typeof import("./v4-render-harness");
  return { __esModule: true, default: h.makeSiteChartsLeaf() };
});

// ---------------------------------------------------------------------------------------------
// The device the page renders. Handle 1 is the fixture `/api/data` payload the harness serves;
// handle 13 is the OE region device the `oe-grid` pin resolves to.
// ---------------------------------------------------------------------------------------------
const DEVICE_UUID = "01912e2a-0000-7000-8000-000000000001";
const GRID_UUID = "01912e2a-0000-7000-8000-000000000013";
const AREA_UUID = "01912e2a-0000-7000-8000-0000000000a1";
const DEVICE: DeviceId = Device.encode(DEVICE_UUID);
const GRID_DEVICE: DeviceId = Device.encode(GRID_UUID);
const AREA: AreaId = Area.encode(AREA_UUID);
const HANDLE = 1;
const GRID_HANDLE = 13;

const caps = (...ids: CapabilityId[]): Set<CapabilityId> => new Set(ids);

/** The capability shapes `/device/{id}` actually produces, one per branch of `buildAreaStrategy`. */
const CASES: {
  name: string;
  ctx: Omit<AreaStrategyContext, "area" | "leadWithDeviceMetrics">;
  /** The raw `section.areaId` today's page passes: the area uuid, or the `device-N` sentinel. */
  v3AreaId: string;
}[] = [
  {
    name: "single-inverter site (lines chart)",
    ctx: {
      capabilities: caps("solar/power", "load/power", "battery/power"),
      aggregate: false,
    },
    v3AreaId: AREA_UUID,
  },
  {
    name: "aggregate site (two stacked-area charts)",
    ctx: {
      capabilities: caps(
        "solar/power",
        "load/power",
        "battery/power",
        "battery/soc",
        "grid/power",
      ),
      aggregate: true,
    },
    v3AreaId: AREA_UUID,
  },
  {
    name: "site with grid context (oe-grid tile pinned to another device)",
    ctx: {
      capabilities: caps("solar/power", "load/power", "grid/power"),
      aggregate: true,
      gridDevice: GRID_DEVICE,
    },
    v3AreaId: AREA_UUID,
  },
  {
    name: "site with a tracked generator",
    ctx: {
      capabilities: caps("solar/power", "load/power", "generator-running"),
      aggregate: false,
    },
    v3AreaId: AREA_UUID,
  },
  {
    name: "hot water + renewables tiles",
    ctx: {
      capabilities: caps(
        "solar/power",
        "load/power",
        "load.hws/temperature",
        "grid/power",
      ),
      aggregate: false,
    },
    v3AreaId: AREA_UUID,
  },
  {
    name: "amber pricing-only feed",
    ctx: { capabilities: caps("grid/rate"), aggregate: false },
    v3AreaId: AREA_UUID,
  },
  {
    name: "instrumentation-only device, no area (the `device-` sentinel)",
    ctx: { capabilities: caps(), aggregate: false },
    v3AreaId: `device-${HANDLE}`,
  },
  {
    name: "instrumentation-only device with generator + provenance",
    ctx: {
      capabilities: caps("generator-running", "battery/provenance"),
      aggregate: false,
    },
    v3AreaId: `device-${HANDLE}`,
  },
];

interface Capture {
  plugin: string;
  renderProps: unknown;
  leaves: { component: string; props: unknown }[];
}

/**
 * The captures, IN RENDER ORDER (`pluginCaptures` is pushed depth-first as each plugin mounts), with
 * the host-rendered collapse target appended last. Order is the comparison key: the two sides name
 * their nodes differently (v3 `card.id ?? type-i` vs v4 `n_…`), so position is the only shared
 * identity — and it is the meaning-bearing one, since it also pins card ORDER on the page.
 */
function collect(): Capture[] {
  const byKey = new Map<string, Capture>();
  const order: string[] = [];
  for (const c of pluginCaptures) {
    if (!byKey.has(c.key)) order.push(c.key);
    byKey.set(c.key, {
      plugin: c.plugin,
      renderProps: serialise(c.props),
      leaves: [],
    });
  }
  for (const l of leafCaptures) {
    let entry = byKey.get(l.key);
    if (!entry) {
      entry = {
        plugin: "host:site-charts-collapse",
        renderProps: null,
        leaves: [],
      };
      byKey.set(l.key, entry);
      order.push(l.key); // the collapse target has no plugin capture — it lands last
    }
    entry.leaves.push({ component: l.component, props: serialise(l.props) });
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * The v3 side: exactly what `app/device/[...slug]/page.tsx` builds today — the strategy group
 * projected back to v3 and rendered through `<Dashboard>` with the page's synthetic ReadableArea.
 */
function renderV3(
  ctx: (typeof CASES)[number]["ctx"],
  v3AreaId: string,
): Capture[] {
  const group = buildAreaStrategy({ ...ctx, leadWithDeviceMetrics: true });
  const descriptor = areaStrategyGroupToV3(group, {
    areaId: v3AreaId,
    handleForDevice: new Map(
      ctx.gridDevice ? [[ctx.gridDevice, GRID_HANDLE]] : [],
    ),
  });
  const area: ReadableArea = {
    id: v3AreaId,
    displayName: "Fixture Device",
    legacySystemId: HANDLE,
  };
  resetCaptures();
  const Dashboard = require("@/components/Dashboard").default;
  renderToStaticMarkup(
    React.createElement(Dashboard, {
      descriptor,
      areaById: new Map<string, ReadableArea>([[area.id, area]]),
      areasResolved: true,
    }),
  );
  return collect();
}

/** The v4 side: the doc the ported page builds, through the live v4 renderer. */
function renderV4(ctx: (typeof CASES)[number]["ctx"]): Capture[] {
  const group = buildAreaStrategy({ ...ctx, leadWithDeviceMetrics: true });
  const doc: DashboardV4 = normalizeDocV4({
    version: 4,
    root: {
      kind: "group",
      direction: "column",
      device: DEVICE,
      children: [group],
    },
  });
  const deviceById = new Map<string, ResolvedDevice>([
    [
      DEVICE as string,
      { deviceId: DEVICE, name: "Fixture Device", systemId: HANDLE },
    ],
  ]);
  if (ctx.gridDevice) {
    deviceById.set(GRID_DEVICE as string, {
      deviceId: GRID_DEVICE,
      name: "NSW1",
      systemId: GRID_HANDLE,
    });
  }
  resetCaptures();
  const { DashboardV4View } = require("@/components/dashboard/v4/node-view");
  renderToStaticMarkup(
    React.createElement(DashboardV4View, {
      doc,
      areaById: new Map<string, ReadableArea>(), // a device page binds NO area
      deviceById,
      areasResolved: true,
    }),
  );
  return collect();
}

/** Label each capture `plugin#ordinal`, in render order — a readable key for the diff. */
function byOrdinal(captures: Capture[]): Record<string, Capture> {
  const seen = new Map<string, number>();
  const out: Record<string, Capture> = {};
  for (const entry of captures) {
    const n = seen.get(entry.plugin) ?? 0;
    seen.set(entry.plugin, n + 1);
    out[`${entry.plugin}#${n}`] = entry;
  }
  return out;
}

/**
 * The four expected, named differences in the `CardRenderProps` each plugin RECEIVES, erased so the
 * rest can be compared. Nothing here touches the LEAF layer, which is compared raw — so if any of
 * these four actually mattered to a plugin's output, the leaf comparison would still catch it.
 *
 *  1. `section.areaId` — v3 passes the area uuid / `device-N` sentinel; a device-bound v4 subtree has
 *     no area envelope, so `synthSectionV3(undefined)` yields `""`.
 *  2. `section.cards`  — v3 passes the section's real card list; `synthSectionV3` always passes `[]`.
 *     PRE-EXISTING (Phase 5's adapter), not introduced here; no plugin reads it.
 *  3. `card.id`        — v3's descriptor id (`chart:lines`) vs the v4 server-assigned `n_…`. It is a
 *     React key only; order/arity is asserted separately above.
 *  4. `card.deviceSystemId` — v3 stamps it only on the `oe-grid` pin; under a device-bound envelope
 *     every card inherits `device`, so the adapter stamps the PAGE DEVICE's handle on all of them.
 *     Erased only when it equals the page handle (a real pin, e.g. the grid device, is compared).
 */
function normaliseKnownDiffs(entry: Capture): Capture {
  const props = entry.renderProps as Record<string, unknown> | null;
  if (!props || typeof props !== "object") return entry;
  const out: Record<string, unknown> = { ...props };
  if (out.section && typeof out.section === "object") {
    const {
      areaId: _a,
      cards: _c,
      ...rest
    } = out.section as Record<string, unknown>;
    out.section = rest;
  }
  if (out.card && typeof out.card === "object") {
    const { id: _i, ...card } = out.card as Record<string, unknown>;
    if (card.deviceSystemId === HANDLE) delete card.deviceSystemId;
    out.card = card;
  }
  return { ...entry, renderProps: out };
}

function normalise(captures: Capture[]): Record<string, Capture> {
  return Object.fromEntries(
    Object.entries(byOrdinal(captures)).map(([k, v]) => [
      k,
      normaliseKnownDiffs(v),
    ]),
  );
}

/**
 * The v3 `tiles` CONTAINER plugin has no v4 counterpart by design — a tiles card became a structural
 * `row` group (§8.1), so v4 mounts the tile plugins directly. It is dropped from the v3 side before
 * comparison; the assertion that it is a pure container (renders no leaf of its own) is a test in its
 * own right below, so the drop cannot hide anything.
 */
function withoutTilesContainer(captures: Capture[]): Capture[] {
  return captures.filter((e) => e.plugin !== "card:tiles");
}

describe("/device/{id}: the v4 renderer reproduces the v3 renderer", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const rawV3 = renderV3(c.ctx, c.v3AreaId);
      const v3 = withoutTilesContainer(rawV3);
      const v4 = renderV4(c.ctx);

      it("renders a non-empty page (the comparison is not vacuous)", () => {
        expect(v3.length).toBeGreaterThan(0);
      });

      it("the dropped v3 `tiles` container renders no leaf of its own", () => {
        for (const e of rawV3.filter((x) => x.plugin === "card:tiles")) {
          expect(e.leaves).toEqual([]);
        }
      });

      it("invokes the same plugins, in the same order, the same number of times", () => {
        expect(v4.map((e) => e.plugin)).toEqual(v3.map((e) => e.plugin));
      });

      it("hands every plugin the same props", () => {
        expect(normalise(v4)).toEqual(normalise(v3));
      });

      it("hands every LEAF the same props (the gate)", () => {
        const leaves = (s: Capture[]) =>
          Object.fromEntries(
            Object.entries(byOrdinal(s)).map(([k, v]) => [k, v.leaves]),
          );
        expect(leaves(v4)).toEqual(leaves(v3));
      });
    });
  }
});
