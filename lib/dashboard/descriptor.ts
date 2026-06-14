/**
 * Dashboard descriptor — the ordered set of cards + layout that drives the dashboard.
 *
 * `buildDefaultDescriptor()` generates the descriptor on the fly from a system, reproducing the
 * vendor_type if/else ladder. `normalizeDescriptor()` reconciles a user's saved descriptor (P2,
 * persisted in the `dashboards` table) with the current default so the catalog can evolve without
 * orphaning saved customizations. See docs/architecture/areas-and-dashboards.md.
 */

import type { LatestPointValues } from "@/lib/types/api";
import {
  getLayout,
  TILE_IDS,
  type DashboardCardType,
  type DashboardLayout,
  type TileId,
} from "./cards";

/** Per-card customization for the tiles inside the `tiles` module. */
export interface TilesConfig {
  order: TileId[];
  hidden: TileId[];
}

/** Per-card config for a `chart` card instance. */
export interface ChartCardConfig {
  /** Overlaid lines (sidebar) vs stacked areas (site load/generation). */
  variant: "lines" | "stacked-areas";
  /** For stacked-areas: which half (maps to SitePowerChart's `mode`). */
  split?: "load" | "generation";
  /** Optional series subset for the (future) union-of-series fetch. */
  series?: string[];
}

export interface ModuleCardInstance {
  type: DashboardCardType;
  /**
   * Stable per-instance identity. Optional: when absent the identity IS the `type` — every card is a
   * singleton today, so this is unset. It lets one layout hold more than one card of the same `type`
   * (e.g. several `chart` cards): reconciliation + visibility key on `id ?? type`, while RENDERING
   * still dispatches on `type`. (Rule: dispatch on type, identity flows on the instance.)
   */
  id?: string;
  /** Hidden module cards are persisted but not rendered (re-addable from the gallery). */
  hidden?: boolean;
  /** Only meaningful for type === "tiles". */
  tiles?: TilesConfig;
  /** Only meaningful for type === "chart". */
  chart?: ChartCardConfig;
}

/** A card's reconciliation/visibility identity: its explicit `id`, or its `type` for singletons. */
export function cardIdentity(c: {
  id?: string;
  type: DashboardCardType;
}): string {
  return c.id ?? c.type;
}

export interface DashboardDescriptor {
  version: 2;
  layout: DashboardLayout;
  cards: ModuleCardInstance[];
}

function defaultTilesConfig(): TilesConfig {
  return { order: [...TILE_IDS], hidden: [] };
}

/**
 * Namespaced ids for the default `chart` instances. The `chart:` prefix guarantees an instance id
 * can never equal a `DashboardCardType` literal (so reconcile/visibility identity never collides
 * with a singleton's type).
 */
const CHART_LINES_ID = "chart:lines";
const CHART_LOAD_ID = "chart:load";
const CHART_GENERATION_ID = "chart:generation";

/** The default card instances each layout shows — the exact set the vendor_type ladder renders. */
function defaultCardsForLayout(layout: DashboardLayout): ModuleCardInstance[] {
  switch (layout) {
    case "amber":
      return [{ type: "amber-now" }, { type: "amber-timeline" }];
    case "site":
      return [
        { type: "tiles", tiles: defaultTilesConfig() },
        {
          type: "chart",
          id: CHART_LOAD_ID,
          chart: { variant: "stacked-areas", split: "load" },
        },
        {
          type: "chart",
          id: CHART_GENERATION_ID,
          chart: { variant: "stacked-areas", split: "generation" },
        },
        { type: "sankey" },
        { type: "generator-runs" },
      ];
    case "sidebar":
      return [
        { type: "tiles", tiles: defaultTilesConfig() },
        { type: "chart", id: CHART_LINES_ID, chart: { variant: "lines" } },
        { type: "generator-runs" },
      ];
  }
}

/**
 * Generate the default dashboard descriptor for a system. Layout + card set depend only on the
 * vendor type (as the ladder does today); `latest` is accepted for forward-compatibility with the
 * per-card eligibility pass but is not used here. When `opts.gridSignalsAvailable` is true (the
 * Area resolves to a NEM region; gated server-side), a `grid-signals` module card is appended for
 * the "sidebar" and "site" layouts.
 */
export function buildDefaultDescriptor(
  system: { vendorType: string },
  _latest: LatestPointValues,
  opts?: { gridSignalsAvailable?: boolean },
): DashboardDescriptor {
  const layout = getLayout(system.vendorType);
  const cards: ModuleCardInstance[] = defaultCardsForLayout(layout);
  if (
    opts?.gridSignalsAvailable &&
    (layout === "sidebar" || layout === "site")
  ) {
    cards.push({ type: "grid-signals" });
  }
  return {
    version: 2,
    layout,
    cards,
  };
}

function normalizeTiles(saved: unknown, def: TilesConfig): TilesConfig {
  const s = saved as Partial<TilesConfig> | undefined;
  if (!s || !Array.isArray(s.order)) return def;
  const valid = new Set<TileId>(def.order);
  const order = s.order.filter((id): id is TileId => valid.has(id as TileId));
  // Append any newly-introduced tiles not present in the saved order.
  for (const id of def.order) if (!order.includes(id)) order.push(id);
  const hidden = (Array.isArray(s.hidden) ? s.hidden : []).filter(
    (id): id is TileId => valid.has(id as TileId),
  );
  return { order, hidden };
}

/**
 * READ-side shim for the `chart`-card rename (the WRITE-side data migration is a separate later PR).
 * A legacy saved card expands to the new chart instances so its identity lines up with the current
 * default (and its `hidden` state is carried onto each half):
 *   { type: "site-charts" }  → chart:load + chart:generation (stacked)
 *   { type: "energy-chart" } → chart:lines
 * Everything else passes through. Runs on the SAVED side of normalizeDescriptor only (the default is
 * already chart-shaped). KEEP until the persisted-descriptor data migration ships.
 */
function migrateLegacyChartCards(
  cards: ModuleCardInstance[],
): ModuleCardInstance[] {
  return cards.flatMap((c) => {
    const t = c.type as string;
    if (t === "site-charts") {
      return [
        {
          type: "chart" as const,
          id: CHART_LOAD_ID,
          hidden: c.hidden,
          chart: { variant: "stacked-areas" as const, split: "load" as const },
        },
        {
          type: "chart" as const,
          id: CHART_GENERATION_ID,
          hidden: c.hidden,
          chart: {
            variant: "stacked-areas" as const,
            split: "generation" as const,
          },
        },
      ];
    }
    if (t === "energy-chart") {
      return [
        {
          type: "chart" as const,
          id: CHART_LINES_ID,
          hidden: c.hidden,
          chart: { variant: "lines" as const },
        },
      ];
    }
    return [c];
  });
}

/**
 * Reconcile a saved descriptor with the current default. Discards the save if the layout changed
 * (e.g. the system's vendor type changed); otherwise keeps the saved card ORDER + hidden/tiles/chart
 * config, appends cards introduced since the save (as visible defaults), and drops any that no
 * longer exist. Returns the default if `saved` is missing or malformed.
 *
 * Cards are matched by IDENTITY (`id ?? type`), not bare `type`, so a layout can hold more than one
 * card of the same type (the `chart` card). For today's singletons identity == type, so this is a
 * no-op: a saved descriptor with no `id`s reconciles byte-identically to before. Legacy chart card
 * types are shimmed to chart instances first (migrateLegacyChartCards).
 */
export function normalizeDescriptor(
  saved: unknown,
  def: DashboardDescriptor,
): DashboardDescriptor {
  const raw = saved as Partial<DashboardDescriptor> | null | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.layout !== def.layout ||
    !Array.isArray(raw.cards)
  ) {
    return def;
  }
  // Shim legacy chart card types BEFORE reconcile so their identities line up with the default.
  const savedCards = migrateLegacyChartCards(raw.cards);
  const savedById = new Map(savedCards.map((c) => [cardIdentity(c), c]));
  const defById = new Map(def.cards.map((c) => [cardIdentity(c), c]));

  // Card order follows the SAVED order (so a Customize reorder sticks), keeping only identities that
  // still exist in the default; any default cards introduced since the save are appended.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const c of savedCards) {
    const id = cardIdentity(c);
    if (defById.has(id) && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }
  for (const c of def.cards) {
    const id = cardIdentity(c);
    if (!seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }

  const cards: ModuleCardInstance[] = orderedIds.map((id) => {
    const defCard = defById.get(id)!;
    const sc = savedById.get(id);
    if (!sc) return defCard; // card introduced since the save → default (visible)
    // Structure (type/id/tiles/chart) comes from the canonical default; hidden + tile order from the save.
    const card: ModuleCardInstance = {
      type: defCard.type,
      hidden: !!sc.hidden,
    };
    if (defCard.id !== undefined) card.id = defCard.id;
    if (defCard.type === "tiles") {
      card.tiles = normalizeTiles(sc.tiles, defCard.tiles!);
    }
    if (defCard.chart) card.chart = defCard.chart;
    return card;
  });
  return { version: 2, layout: def.layout, cards };
}

/** The tiles module's config from a descriptor (or a default if absent). */
export function tilesConfigOf(descriptor: DashboardDescriptor): TilesConfig {
  const card = descriptor.cards.find((c) => c.type === "tiles");
  return card?.tiles ?? defaultTilesConfig();
}

/**
 * Whether a module card is present and not hidden, looked up by IDENTITY (an instance `id`) or by
 * `type` (the singleton case). Pass a card's `id` to target a specific instance, or a `type` to find
 * the first card of that type (today's callers).
 */
export function isCardVisible(
  descriptor: DashboardDescriptor,
  idOrType: DashboardCardType | string,
): boolean {
  const card = descriptor.cards.find(
    (c) => c.id === idOrType || c.type === idOrType,
  );
  return !!card && !card.hidden;
}
