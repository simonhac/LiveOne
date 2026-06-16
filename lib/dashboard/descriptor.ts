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
  /** For stacked-areas: which half of the stacked chart (load vs generation). */
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
  /**
   * The Area this card reads from (uuid). OPTIONAL and absent in practice today: a card with no
   * `areaId` INHERITS the dashboard's default area (`dashboards.area_id`). This is the per-card
   * junction for the multi-area future (see docs/architecture/areas-and-dashboards.md §3) — carried
   * on the descriptor (no `dashboard_cards` table). Forward-only seam; every card is areaId-less
   * today, so it's inert. Rides on the saved instance like `hidden`/`tiles` (it's customization, not
   * structure).
   */
  areaId?: string;
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
 * Reconcile a saved descriptor with the current default. Discards the save if the layout changed
 * (e.g. the system's vendor type changed); otherwise keeps the saved card ORDER + hidden/tiles/chart
 * config, appends cards introduced since the save (as visible defaults), and drops any that no
 * longer exist. Returns the default if `saved` is missing or malformed.
 *
 * Cards are matched by IDENTITY (`id ?? type`), not bare `type`, so a layout can hold more than one
 * card of the same type (the `chart` card). For today's singletons identity == type, so this is a
 * no-op: a saved descriptor with no `id`s reconciles byte-identically to before.
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
  const savedCards = raw.cards as ModuleCardInstance[];
  const savedPageById = new Map(
    savedCards.filter((c) => !c.areaId).map((c) => [cardIdentity(c), c]),
  );
  const defById = new Map(def.cards.map((c) => [cardIdentity(c), c]));

  // Reconcile a PAGE (areaId-less) card: structure (type/id/tiles/chart) from the canonical default;
  // hidden + tile order from the save.
  const reconcilePageCard = (id: string): ModuleCardInstance => {
    const defCard = defById.get(id)!;
    const sc = savedPageById.get(id);
    if (!sc) return defCard; // card introduced since the save → default (visible)
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
  };

  // An OFF-AREA composed card (Phase 2b: `areaId` set) is user-authored, not catalog — it has no
  // default counterpart, so keep its structure verbatim. Without this it would be dropped (it isn't
  // in `def`), and the multi-area cards would vanish on reload.
  const keepOffAreaCard = (c: ModuleCardInstance): ModuleCardInstance => {
    const card: ModuleCardInstance = {
      type: c.type,
      areaId: c.areaId,
      hidden: !!c.hidden,
    };
    if (c.id !== undefined) card.id = c.id;
    if (c.tiles) card.tiles = c.tiles;
    if (c.chart) card.chart = c.chart;
    return card;
  };

  // Walk the SAVED order (so a Customize reorder sticks): off-area cards kept in place; page cards
  // reconciled against the default, dropping any that no longer exist. Then append default page
  // cards introduced since the save.
  const cards: ModuleCardInstance[] = [];
  const seenPage = new Set<string>();
  for (const c of savedCards) {
    if (c.areaId) {
      cards.push(keepOffAreaCard(c));
      continue;
    }
    const id = cardIdentity(c);
    if (defById.has(id) && !seenPage.has(id)) {
      cards.push(reconcilePageCard(id));
      seenPage.add(id);
    }
  }
  for (const c of def.cards) {
    const id = cardIdentity(c);
    if (!seenPage.has(id)) {
      cards.push(c);
      seenPage.add(id);
    }
  }
  return { version: 2, layout: def.layout, cards };
}

/**
 * The PAGE tiles module's config from a descriptor (or a default if absent). Targets the page's own
 * tile grid — the `tiles` card with no `areaId`. A multi-area `tiles` card (areaId set) is a separate
 * off-area block (rendered by MultiAreaCards), not part of the page tile grid, so it's skipped here.
 */
export function tilesConfigOf(descriptor: DashboardDescriptor): TilesConfig {
  const card = descriptor.cards.find((c) => c.type === "tiles" && !c.areaId);
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
