/**
 * Nested dashboard model (v3) — the on-disk dashboard definition (dashboards.descriptor JSONB).
 *
 * Shape: Dashboard -> AreaSection -> Card -> device-bound Tile. See docs/plans/dashboard-nested-tile-model.md.
 *
 * Design rule: store only CHOICES + STRUCTURE; DERIVE everything that comes from the Area. So a section
 * carries just `{ areaId, cards }` in the common case — the handle (area.legacy_system_id), the layout
 * (getLayout(area.vendorType)) and the header (shown only when there are multiple sections) are all
 * resolved at render time from the Area, never stored.
 *
 * Key ideas:
 *  - An AreaSection binds one Area (the unified view = exactly ONE section; composition = N).
 *  - A Tile = (view, deviceSystemId?): omit the device -> the section's own handle (whole-area tile);
 *    name a device -> that specific member (e.g. the OpenElectricity region system for the `oe-grid`
 *    view, a member device of the Area).
 */
import { getLayout, TILE_IDS } from "./cards";
import type { DashboardCardType, DashboardLayout, TileId } from "./cards";

/** A chart card's config — lines (sidebar) vs stacked-areas (site load/generation halves). */
export interface ChartCardConfig {
  /** Overlaid lines (sidebar) vs stacked areas (site load/generation). */
  variant: "lines" | "stacked-areas";
  /** For stacked-areas: which half of the stacked chart (load vs generation). */
  split?: "load" | "generation";
  /** Optional series subset for the (future) union-of-series fetch. */
  series?: string[];
}

/**
 * The tile-view catalog: today's TileId (`solar`, `load`, `hotWater`, `battery`, `house-to-grid`,
 * `amber`, `ev`) plus `oe-grid` — the OpenElectricity NEM grid signals, bound to a member device.
 */
export type TileView = TileId | "oe-grid";

/** HA-style optional tile "features" (detail/affordances). Forward seam; inert-with-defaults today. */
export type TileFeature =
  | { kind: "sparkline"; series: string }
  | { kind: "breakdown" }
  | { kind: "flow-direction" }
  | { kind: "toggle"; command: string };

/** A device-bound tile — the mix-and-match unit. device -> data, view -> rendering. */
export interface TileV3 {
  /** Member device this tile reads. Omitted => the section's own handle (whole-area). */
  deviceSystemId?: number;
  view: TileView;
  /** Stable per-instance id; reconcile/visibility key = id ?? view. */
  id?: string;
  hidden?: boolean;
  features?: TileFeature[];
}

/** A card. `tiles` holds device-bound TileV3[]; `chart` carries the chart config; others are bare. */
export interface CardV3 {
  type: DashboardCardType;
  id?: string;
  hidden?: boolean;
  tiles?: TileV3[]; // type === "tiles"
  chart?: ChartCardConfig; // type === "chart"
  /**
   * The member device this card reads (mirrors TileV3.deviceSystemId). Used by section-agnostic,
   * device-bound cards (`device-metrics`, `generator-runs`): omit ⇒ the section's own handle
   * (whole-area). Needed when a multi-device area's handle isn't where the card's data lives —
   * e.g. run periods are keyed by a member `system_id`, not the synthetic area handle.
   */
  deviceSystemId?: number; // type === "device-metrics" | "generator-runs"
  /**
   * `device-metrics` presentation: `grid` (the historical gauge-tile grid) or `table` (a compact
   * two-column name → formatted-value list). Omitted ⇒ `grid`. The device viewer leads with the
   * `table` variant; instrumentation-only fallbacks keep it too.
   */
  variant?: "grid" | "table"; // type === "device-metrics"
}

/**
 * One Area + the cards rendered against it. Stores ONLY the binding + choices; the handle, layout and
 * header are derived from the Area at render time (see file header).
 */
export interface AreaSectionV3 {
  /** The Area this section reads. Its legacy_system_id (the handle) + vendorType are resolved here. */
  areaId: string;
  /** Optional layout OVERRIDE; omitted => getLayout(area.vendorType). */
  layout?: DashboardLayout;
  hidden?: boolean;
  cards: CardV3[];
}

export interface DashboardV3 {
  version: 3;
  sections: AreaSectionV3[];
}

/** Narrow an opaque descriptor (JSONB) to v3. */
export function isDashboardV3(x: unknown): x is DashboardV3 {
  return (
    !!x &&
    typeof x === "object" &&
    (x as { version?: number }).version === 3 &&
    Array.isArray((x as DashboardV3).sections)
  );
}

/** The distinct cards across all sections (used for counts / scope). */
export function allCardsV3(d: DashboardV3): CardV3[] {
  return d.sections.flatMap((s) => s.cards);
}

/** The distinct Area ids a v3 dashboard references (its scope set). */
export function sectionAreaIdsV3(d: DashboardV3): string[] {
  return [...new Set(d.sections.map((s) => s.areaId))];
}

export interface BuildDefaultV3Opts {
  areaId: string;
  /** The Area's vendorType — selects the default card set + layout (site | sidebar | amber). */
  vendorType: string;
  /** OE region member device (e.g. VIC1 = 12) → appends the `oe-grid` tile. Omit if the Area has none. */
  gridDeviceSystemId?: number;
  /** The Area's system has an enabled generator run-tracker → appends a `generator-runs` card. */
  hasGenerator?: boolean;
  /**
   * The whole-area tile views the system actually supports (from its latest). Omitted ⇒ all TILE_IDS.
   * Supplying it keeps the descriptor's tile set == the rendered set, so the loading skeleton doesn't
   * over-count then collapse (e.g. a sidebar system that only has solar/load/battery/grid).
   */
  availableViews?: readonly TileView[];
  /**
   * Lead every layout with a generic all-values `device-metrics` card (the `table` variant) as the
   * FIRST card. Only the live `/device/{id}` DeviceViewer sets this, so the device view (direct and
   * via the rail browser) gets the panel while persisted / composition dashboards are untouched.
   */
  leadWithDeviceMetrics?: boolean;
}

/**
 * The v3 default dashboard for an Area (the "area strategy") — one AreaSection, vendor-appropriate
 * cards. Native v3 (no v2 round-trip): the same card sets `buildDefaultDescriptor` picks, expressed
 * nested, with the retired grid-signals card folded into the `oe-grid` tile. Layout is DERIVED from
 * the vendorType at render time, so it is not stored (omitted from the section).
 */
export function buildDefaultDashboardV3(opts: BuildDefaultV3Opts): DashboardV3 {
  const layout = getLayout(opts.vendorType);

  // The generic all-values panel that leads the device view (name → formatted value, works for any
  // device). Only emitted when the caller (the DeviceViewer) opts in, so other descriptor builders
  // are unaffected. `deviceMetricsLead` is the prefix; `[]` when not leading.
  const deviceMetricsLead: CardV3[] = opts.leadWithDeviceMetrics
    ? [{ type: "device-metrics", variant: "table" }]
    : [];

  if (layout === "amber") {
    // An Amber price dashboard: the two amber cards, no tiles/charts.
    return {
      version: 3,
      sections: [
        {
          areaId: opts.areaId,
          cards: [
            ...deviceMetricsLead,
            { type: "amber-now" },
            { type: "amber-timeline" },
          ],
        },
      ],
    };
  }

  const supported = opts.availableViews
    ? TILE_IDS.filter((v) => opts.availableViews!.includes(v))
    : [...TILE_IDS];

  // Instrumentation-only device (a generator, a sensor pack, …): the tile catalog represents NONE of
  // its points, and it has no OE grid member. Only the live DeviceViewer supplies availableViews (the
  // seed/AddArea paths omit it, so persisted & composition dashboards are untouched — composition.test
  // stays green), so this fires only for the on-the-fly `/device/{id}` page. Show just the generic
  // device-metrics card (+ generator-runs if tracked) instead of an empty tiles grid + empty chart.
  if (
    opts.availableViews != null &&
    supported.length === 0 &&
    opts.gridDeviceSystemId == null
  ) {
    // Already leads with device-metrics — honor the requested variant (table when leading), no dup.
    const cards: CardV3[] = opts.leadWithDeviceMetrics
      ? [...deviceMetricsLead]
      : [{ type: "device-metrics" }];
    if (opts.hasGenerator) cards.push({ type: "generator-runs" });
    return { version: 3, sections: [{ areaId: opts.areaId, cards }] };
  }

  const tiles: TileV3[] = supported.map((view) => ({ view }));
  if (opts.gridDeviceSystemId != null) {
    tiles.push({ view: "oe-grid", deviceSystemId: opts.gridDeviceSystemId });
  }
  const cards: CardV3[] = [...deviceMetricsLead, { type: "tiles", tiles }];

  if (layout === "site") {
    // Site (mondo/composite): the two stacked-area charts. The sankey is NOT a default — it's an opt-in
    // card you add (it works for any area with loads + sources), so it's never auto-given here.
    cards.push(
      {
        type: "chart",
        id: "chart:load",
        chart: { variant: "stacked-areas", split: "load" },
      },
      {
        type: "chart",
        id: "chart:generation",
        chart: { variant: "stacked-areas", split: "generation" },
      },
    );
  } else {
    // Sidebar (selectronic/enphase/...): a single lines chart.
    cards.push({
      type: "chart",
      id: "chart:lines",
      chart: { variant: "lines" },
    });
  }

  if (opts.hasGenerator) cards.push({ type: "generator-runs" });

  return { version: 3, sections: [{ areaId: opts.areaId, cards }] };
}

/** An empty v3 dashboard (no sections yet — the user adds them via the configurator). */
export function emptyDashboardV3(): DashboardV3 {
  return { version: 3, sections: [] };
}

/**
 * Guarantee every sankey card carries a stable `id` — the `sankeyId` slot of the per-sankey display-
 * options key (`sankeyId:areaId:dashboardId`). One sankey per area, so a lone card is given the
 * deterministic id `"sankey"` (matching the render-side fallback in Dashboard.tsx); a hypothetical 2nd+
 * sankey in one section gets `"sankey:1"`, `"sankey:2"`, … Idempotent — existing ids are preserved.
 * Run on every descriptor WRITE (create + update) so persisted descriptors are never missing the id.
 */
export function ensureSankeyCardIds(descriptor: DashboardV3): DashboardV3 {
  return {
    ...descriptor,
    sections: descriptor.sections.map((section) => {
      let sankeyOrdinal = 0;
      return {
        ...section,
        cards: section.cards.map((card) => {
          if (card.type !== "sankey") return card;
          const ordinal = sankeyOrdinal++;
          if (card.id) return card;
          return {
            ...card,
            id: ordinal === 0 ? "sankey" : `sankey:${ordinal}`,
          };
        }),
      };
    }),
  };
}

export type { DashboardCardType };
