/**
 * ============================================================================================
 * THE PROP-EQUIVALENCE GATE for the `CardRenderProps` port (config-v4 Phase 14).
 * ============================================================================================
 *
 * WHAT THIS IS FOR
 * Stage 6 changed `CardRenderProps` (components/dashboard/cards/types.ts) from the v3 shape
 * `{card: CardV3, section: AreaSectionV3, handle?}` to the v4-native `{node: CardNode, context:
 * NodeContext, handle?, deviceSystemId?}`, ported all nine card plugins onto it, and deleted the
 * adapter `lib/dashboard/v4-adapt.ts` (`synthCardV3` / `synthSectionV3`). That was a pure refactor:
 * it must change NOTHING a user can see. It is kept as the standing gate on this seam.
 *
 * The stage-6 result: all 11 `card:*` `renderProps` entries changed shape (that IS the port); all
 * 22 `leaves` entries, all 10 `tile:*` `renderProps` entries and the whole key set were
 * byte-identical.
 *
 * STAGE 7 then merged the two plugin registries into one `CARD_RENDERERS` keyed on `CardType`
 * (components/dashboard/registry.tsx) and moved the renderer's tile-vs-card dispatch onto the
 * plugin's own `kind`. The plugins and their props were NOT touched, so `v4-render-props.expected.json`
 * is absent from that diff entirely: 0 of 22 changed in BOTH layers. The only harness change is that
 * one module is mocked where two were.
 *
 * Pixel equivalence is not provable here at any sane cost — four card plugins bottom out in chart.js
 * on a `<canvas>` (zero DOM to assert on) and the repo has no React-rendering test infrastructure.
 * PROP-LEVEL equivalence is the sound substitute: the leaf components are NOT being touched, so
 * identical leaf props ⇒ identical pixels. This file makes that provable.
 *
 * WHAT IT ASSERTS
 * It renders fixture v4 documents through the REAL `<DashboardV4View>` / `<NodeView>` with the real
 * card and tile registries (the plugins are wrapped to record their props, then rendered — they are
 * the code under test, never replaced), and captures two layers into
 * `v4-render-props.expected.json`, keyed by node id:
 *
 *   `leaves`      — the props each plugin handed to the leaf component it renders into
 *                   (LinesChartCard, DeviceMetricsCard, Tile, SiteChartsCard, …).
 *                   🛑 THIS IS THE GATE. It MUST NOT change across the port. A diff here is a
 *                      behaviour change, full stop.
 *
 *   `renderProps` — the `CardRenderProps` / `TileRenderProps` object each plugin RECEIVED.
 *                   The card entries changed wholesale in the port (that was the point of it):
 *                   `{card, section, handle}` became `{node, context, handle, deviceSystemId}`.
 *                   They are recorded so the reviewer can read the before/after side by side and
 *                   check that every field that was being consumed is still reachable. The TILE
 *                   entries must NOT change — `V4TileCell` never went through the adapter.
 *
 * plus explicit COVERAGE and ARITY assertions, because a mocked chain silently encodes arity: if a
 * plugin is never invoked the harness must go red, not quietly assert nothing. Hence
 * "every known v4 card type is exercised" and "the captured key set equals the expected key set"
 * are asserted independently of the snapshot comparison.
 *
 * HOW TO REGENERATE (only ever with a reviewed, understood diff):
 *   UPDATE_V4_PROP_SNAPSHOT=1 npx jest lib/dashboard/__tests__/v4-render-props.test.ts
 *
 * WHAT IS MOCKED, AND WHY (nothing else — no jsdom, no @testing-library, zero new dependencies):
 *   - `useAreaDatum`      — calls `useQuery` + `useModalContext`; there is no QueryClientProvider
 *                           under a bare `renderToStaticMarkup`. Replaced by a fixed payload.
 *   - `useQuery`          — the two tiles and the one card that query directly (hot-water,
 *                           renewables, ev-provenance).
 *   - `useSearchParams`   — `useTemporalRange` reads it during render.
 *   - `next/font/local`   — only Next's compiler can evaluate it.
 *   - the leaf components — so we capture props rather than markup.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { V4_CARD_TYPES } from "@/lib/dashboard/card-types";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import {
  AREAS_BY_ID,
  AREA_1,
  AREA_2,
  DEVICES_BY_ID,
  DEV_GEN,
  DEV_METRICS,
  DEV_MISSING,
  DEV_OE,
  leafCaptures,
  pluginCaptures,
  resetCaptures,
  serialise,
} from "./v4-render-harness";

// --- hooks that cannot run in a bare static render -------------------------------------------
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
  usePathname: () => "/dashboard/fixture",
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

// --- the plugins: wrapped to record, then rendered for real ----------------------------------
jest.mock("@/components/dashboard/registry", () => {
  const h =
    require("./v4-render-harness") as typeof import("./v4-render-harness");
  const actual = jest.requireActual("@/components/dashboard/registry");
  return { CARD_RENDERERS: h.instrumentRenderers(actual.CARD_RENDERERS) };
});

// --- the leaves: every component a plugin renders into ---------------------------------------
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
  // config-v4 Phase 14 stage 20. CAPTURED as a leaf, not stubbed away like `DailyStripes` below —
  // the two stage-19 reasons for stubbing were checked against it and only one applies:
  //   1. Date.now()-derived props: NO. `HeatmapPanel`'s props are `systemId`/`timezone`/the two pins
  //      /`variant` — all doc- and fixture-derived, so the golden is stable across midnight. (The
  //      30-day window is computed INSIDE `HeatmapChart`, below the captured boundary.)
  //   2. ESM-only deps: yes — it reaches `lib/heatmap-colors` → `d3-scale-chromatic`, and
  //      `HeatmapChart` → `chart.js`/`chartjs-chart-matrix`. But a `jest.mock` FACTORY already
  //      solves that: the real module is never required either way. That is the same thing the 14
  //      entries above do for their chart.js leaves.
  // So the strictly stronger option is available here, and taking it puts the card's actual output
  // — including which series/palette it pins — under the byte-for-byte `leaves` gate.
  "@/components/heatmap/HeatmapPanel": "HeatmapPanel",
};
for (const [modulePath, name] of Object.entries(LEAF_MODULES)) {
  jest.mock(modulePath, () => {
    const h =
      require("./v4-render-harness") as typeof import("./v4-render-harness");
    return { __esModule: true, default: h.makeLeaf(name) };
  });
}
// 🛑 `DailyStripes` is stubbed OUT of the capture set rather than added to `LEAF_MODULES`, for one
// remaining reason (config-v4 Phase 14 stage 19):
//   1. Its props embed a `Date.now()`-derived local-day window (`firstDayMidnightMs`, set at
//      `components/dashboard/cards/daily-stripe.tsx:67`), so recording them would bake today's date
//      into the checked-in golden and turn it red at the next local midnight — exactly what the
//      fixture world's "no clocks, no randomness" rule exists to stop.
//   2. ~~ESM-only d3 cannot be loaded under jest at all.~~ **No longer true** as of the chart-library
//      consolidation Stage 0: `jest.shared.js` now transforms `d3-*`, guarded by
//      `lib/charts/__tests__/d3-esm-imports.test.ts`. Reason 1 is load-bearing on its own, so the
//      mock stays — but do not cite ESM as the blocker.
// The `daily-stripe` entry therefore records `renderProps` (node + config + resolved scope, all
// deterministic) with an empty `leaves` list; the window/parse/domain logic that would have shown up
// in `leaves` is unit-tested directly in ./daily-stripe.test.ts.
jest.mock("@/components/dashboard/DailyStripes", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/SiteChartsCard", () => {
  const h =
    require("./v4-render-harness") as typeof import("./v4-render-harness");
  return { __esModule: true, default: h.makeSiteChartsLeaf() };
});

// ---------------------------------------------------------------------------------------------
// The fixture document. Every branch of `node-view.tsx` that carries v3 coupling is represented.
// ---------------------------------------------------------------------------------------------
const DASHBOARD_ID = "db_fixture";

const FIXTURE_DOC: DashboardV4 = {
  version: 4,
  root: {
    id: "n_root",
    kind: "group",
    direction: "column",
    children: [
      {
        id: "n_secA",
        kind: "group",
        area: AREA_1, // handle 1, chartCapable
        heading: true,
        children: [
          // ---- the tile path (V4TileCell): all 9 promoted tile views -------------------------
          {
            id: "n_row",
            kind: "group",
            direction: "row",
            children: [
              { id: "n_t_solar", kind: "card", type: "solar" },
              { id: "n_t_load", kind: "card", type: "load" },
              { id: "n_t_hotwater", kind: "card", type: "hotWater" },
              { id: "n_t_battery", kind: "card", type: "battery" },
              { id: "n_t_grid", kind: "card", type: "house-to-grid" },
              { id: "n_t_amber", kind: "card", type: "amber" },
              { id: "n_t_ev", kind: "card", type: "ev" },
              { id: "n_t_renewables", kind: "card", type: "renewables" },
              // device-bound tile: `V4TileCell` must fetch the DEVICE's handle (13), not the area's.
              {
                id: "n_t_oegrid",
                kind: "card",
                type: "oe-grid",
                device: DEV_OE,
              },
            ],
          },
          // ---- `card.chart` (variant/split) + the SiteChartsGroup two-pass collapse -----------
          {
            id: "n_chart_lines",
            kind: "card",
            type: "chart",
            config: { variant: "lines" },
          },
          {
            id: "n_chart_load",
            kind: "card",
            type: "chart",
            config: { variant: "stacked-areas", split: "load" },
          },
          { id: "n_sankey", kind: "card", type: "sankey" },
          {
            id: "n_chart_gen",
            kind: "card",
            type: "chart",
            config: { variant: "stacked-areas", split: "generation" },
          },
          // ---- the 5 cards that read nothing but `handle` -------------------------------------
          { id: "n_amber_now", kind: "card", type: "amber-now" },
          { id: "n_amber_timeline", kind: "card", type: "amber-timeline" },
          { id: "n_batt_contents", kind: "card", type: "battery-contents" },
          { id: "n_ev_prov", kind: "card", type: "ev-provenance" },
          // ---- `section.areaId` ---------------------------------------------------------------
          {
            id: "n_batt_prov",
            kind: "card",
            type: "battery-provenance-history",
          },
          // ---- the v4-native `daily-stripe` (stage 19): structural `node.config`, no scope refs --
          // Configured as the HWS reproduction, so the snapshot pins the exact config shape the
          // card claims to render `/labs/kinkora-hws` from.
          {
            id: "n_daily_stripe",
            kind: "card",
            type: "daily-stripe",
            config: {
              primary: { logicalPath: "load.hws/temperature" },
              state: { logicalPath: "load.hws/power", onThreshold: 100 },
              days: 7,
              color: {
                min: 30,
                max: 40,
                from: "hsl(210,80%,50%)",
                to: "hsl(0,80%,50%)",
              },
              unit: "°C",
              label: "Faucet",
            },
          },
          // ---- the v4-native `heatmap` (stage 20), in BOTH of its configurations ---------------
          // Fully pinned + device-bound: proves `deviceSystemId` (11) beats the area handle (1) and
          // that both pins reach the panel, which is what hides its two selectors.
          {
            id: "n_heatmap",
            kind: "card",
            type: "heatmap",
            device: DEV_METRICS,
            config: { series: "load.hws/temperature", palette: "turbo" },
          },
          // Bare + area-scoped: the default selector-driven card. Two heatmaps on one document is
          // also the structural half of the "cards must not collide" edge case — they resolve to
          // different subjects and neither writes to the URL (the state is inside the panel).
          { id: "n_heatmap_bare", kind: "card", type: "heatmap" },
          // ---- `card.deviceSystemId`: device-bound AND inheriting-from-section -----------------
          {
            id: "n_dm_device",
            kind: "card",
            type: "device-metrics",
            device: DEV_METRICS,
            config: { variant: "table" },
          },
          {
            id: "n_dm_inherit",
            kind: "card",
            type: "device-metrics",
            config: { variant: "grid" },
          },
          {
            id: "n_gen_device",
            kind: "card",
            type: "runs",
            device: DEV_GEN,
          },
          // No config at all — the pre-rename shape. Must still resolve to the generator, which is
          // what such a node has always meant; `runsConfigSchema`'s default is what guarantees it.
          { id: "n_gen_inherit", kind: "card", type: "runs" },
          // The other role, so the golden pins BOTH sets of card copy rather than just the default.
          {
            id: "n_ev_runs",
            kind: "card",
            type: "runs",
            config: { role: "ev" },
            device: DEV_GEN,
          },
          // ---- must NOT render ------------------------------------------------------------------
          { id: "n_hidden", kind: "card", type: "amber-now", hidden: true },
          // `tiles` is a v3 card type but NOT a v4 one (it became a group) → placeholder branch.
          { id: "n_tiles_legacy", kind: "card", type: "tiles" },
          { id: "n_future", kind: "card", type: "future-card" },
          {
            id: "n_dev_missing",
            kind: "card",
            type: "device-metrics",
            device: DEV_MISSING,
          },
        ],
      },
      // ---- context inheritance: area AND device come from the ancestor group -------------------
      {
        id: "n_secB",
        kind: "group",
        area: AREA_2, // handle 2
        device: DEV_METRICS, // systemId 11
        heading: true,
        children: [
          { id: "n_b_dm", kind: "card", type: "device-metrics" },
          { id: "n_b_tile", kind: "card", type: "battery" },
        ],
      },
    ],
  },
};

/**
 * Every key the render MUST produce. Asserted as a set on its own, before any deep comparison, so a
 * plugin that silently stops being invoked fails loudly instead of shrinking the snapshot.
 */
const EXPECTED_KEYS = [
  // tiles (keyed `tile:<view>@<systemId>` — tile props carry no node id)
  "tile:amber@1",
  "tile:battery@1",
  "tile:battery@11",
  "tile:ev@1",
  "tile:hotWater@1",
  "tile:house-to-grid@1",
  "tile:load@1",
  "tile:oe-grid@13",
  "tile:renewables@1",
  "tile:solar@1",
  // v3 card plugins (keyed by node id)
  "n_amber_now",
  "n_amber_timeline",
  "n_b_dm",
  "n_batt_contents",
  "n_batt_prov",
  "n_chart_lines",
  "n_daily_stripe",
  "n_dm_device",
  "n_dm_inherit",
  "n_ev_prov",
  "n_ev_runs",
  "n_gen_device",
  "n_gen_inherit",
  "n_heatmap",
  "n_heatmap_bare",
  // the collapse target (rendered by the host, not by a plugin)
  "site-charts@1",
].sort();

/** Node ids that must be captured by NOTHING, each for a different reason. */
const EXPECTED_ABSENT_KEYS = [
  "n_sankey", // collapsed into site-charts@1 (its Render is unreachable by design)
  "n_chart_load", // collapsed
  "n_chart_gen", // collapsed
  "n_hidden", // hidden
  "n_tiles_legacy", // unknown-type placeholder
  "n_future", // unknown-type placeholder
  "n_dev_missing", // device unavailable
];

interface SnapshotEntry {
  plugin: string;
  renderProps: unknown;
  leaves: { component: string; props: unknown }[];
}
type Snapshot = Record<string, SnapshotEntry>;

const EXPECTED_PATH = nodePath.join(__dirname, "v4-render-props.expected.json");

let html = "";
let actual: Snapshot = {};
let expected: Snapshot = {};

function leavesOnly(s: Snapshot): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [
      k,
      { plugin: v.plugin, leaves: v.leaves },
    ]),
  );
}
function renderPropsOnly(s: Snapshot): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [
      k,
      { plugin: v.plugin, renderProps: v.renderProps },
    ]),
  );
}

beforeAll(() => {
  resetCaptures();
  const { DashboardV4View } = require("@/components/dashboard/v4/node-view");
  html = renderToStaticMarkup(
    React.createElement(DashboardV4View, {
      doc: FIXTURE_DOC,
      areaById: AREAS_BY_ID,
      deviceById: DEVICES_BY_ID,
      dashboardId: DASHBOARD_ID,
      areasResolved: true,
    }),
  );

  const built: Snapshot = {};
  for (const c of pluginCaptures) {
    built[c.key] = {
      plugin: c.plugin,
      renderProps: serialise(c.props),
      leaves: [],
    };
  }
  for (const l of leafCaptures) {
    const entry = (built[l.key] ??= {
      plugin: "host:site-charts-collapse",
      renderProps: null,
      leaves: [],
    });
    entry.leaves.push({ component: l.component, props: serialise(l.props) });
  }
  // Sort the top-level keys so the checked-in file diffs cleanly.
  actual = Object.fromEntries(
    Object.keys(built)
      .sort()
      .map((k) => [k, built[k]]),
  );

  if (process.env.UPDATE_V4_PROP_SNAPSHOT === "1") {
    writeFileSync(EXPECTED_PATH, JSON.stringify(actual, null, 2) + "\n");
  }
  expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as Snapshot;
});

describe("v4 renderer — coverage and arity", () => {
  it("exercises every one of the 20 known v4 card types", () => {
    const covered = new Set<string>();
    for (const c of pluginCaptures)
      covered.add(c.plugin.replace(/^(card|tile):/, ""));
    // `sankey`'s own Render is unreachable by design (it always collapses); it is covered by its
    // contribution to the collapse key set, which the SiteChartsCard capture records.
    const siteCharts = leafCaptures.find(
      (l) => l.component === "SiteChartsCard",
    );
    expect(siteCharts?.props.visibleKeys).toEqual([
      "chart:generation",
      "chart:load",
      "sankey",
    ]);
    covered.add("sankey");
    expect([...covered].sort()).toEqual([...V4_CARD_TYPES].sort());
  });

  it("captures exactly the expected node keys — no plugin silently skipped", () => {
    const captured = [...new Set(pluginCaptures.map((c) => c.key))]
      .concat([...new Set(leafCaptures.map((l) => l.key))])
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
    expect(captured).toEqual(EXPECTED_KEYS);
    for (const k of EXPECTED_ABSENT_KEYS) expect(captured).not.toContain(k);
  });

  it("attributes every leaf capture to a plugin (no orphans but the collapse target)", () => {
    const orphans = leafCaptures.filter((l) => l.key.startsWith("<orphan:"));
    expect(orphans).toEqual([]);
  });

  it("renders the unknown-type placeholder, the device-unavailable notice, and both area headers", () => {
    expect(html).toContain("Unknown card type");
    expect(html).toContain("future-card");
    expect(html).toContain(">tiles<"); // `tiles` is not a v4 card type → placeholder, not a plugin
    expect(html).toContain("Device unavailable");
    expect(html).toContain("Fixture Area One");
    expect(html).toContain("Fixture Area Two");
  });
});

describe("v4 renderer — prop equivalence", () => {
  /**
   * 🛑 THE GATE. These props are what the (untouched) leaf components render from. They must be
   * byte-identical before and after the `CardRenderProps` port.
   */
  it("leaf props are exactly as recorded", () => {
    expect(leavesOnly(actual)).toEqual(leavesOnly(expected));
  });

  /**
   * The props each plugin RECEIVED. The `card:*` entries change shape in the port (that is the
   * port); the `tile:*` entries must not, since `V4TileCell` never used the adapter.
   */
  it("plugin render props are exactly as recorded", () => {
    expect(renderPropsOnly(actual)).toEqual(renderPropsOnly(expected));
  });
});
