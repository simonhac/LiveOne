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

export interface ModuleCardInstance {
  type: DashboardCardType;
  /** Hidden module cards are persisted but not rendered (re-addable from the gallery). */
  hidden?: boolean;
  /** Only meaningful for type === "tiles". */
  tiles?: TilesConfig;
}

export interface DashboardDescriptor {
  version: 2;
  layout: DashboardLayout;
  cards: ModuleCardInstance[];
}

/** Cards each layout shows by default — the exact set the vendor_type ladder renders today. */
const CARDS_BY_LAYOUT: Record<DashboardLayout, DashboardCardType[]> = {
  amber: ["amber-now", "amber-timeline"],
  site: ["tiles", "site-charts", "sankey", "generator-runs"],
  sidebar: ["tiles", "energy-chart", "generator-runs"],
};

function defaultTilesConfig(): TilesConfig {
  return { order: [...TILE_IDS], hidden: [] };
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
  const cards: ModuleCardInstance[] = CARDS_BY_LAYOUT[layout].map((type) =>
    type === "tiles" ? { type, tiles: defaultTilesConfig() } : { type },
  );
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
 * The legacy module card types this codebase no longer emits but may still find in persisted rows:
 * the monolithic `"amber"` and the `"power-cards"` predecessor of `"tiles"`. Matched on the MODULE
 * `card.type` only — note `"amber"` is ALSO a `TileId` and a `DashboardLayout` value, so never test
 * by substring/tile-id/layout. `version` cannot discriminate (it has been `2` for both shapes).
 */
const LEGACY_CARD_TYPES = new Set(["amber", "power-cards"]);

/**
 * Whether a (possibly malformed, unknown-typed) descriptor still carries a legacy module card —
 * the gate for both the in-memory read upgrade and the one-off data migration that rewrites the
 * persisted `dashboards` rows. Returns false for any already-current or non-descriptor value, so a
 * migration guarded by this leaves current rows byte-unchanged and is idempotent on a re-run.
 */
export function hasLegacyCards(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const cards = (d as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return false;
  return cards.some(
    (c) =>
      !!c &&
      typeof c === "object" &&
      LEGACY_CARD_TYPES.has((c as { type?: unknown }).type as string),
  );
}

/**
 * Upgrade a saved descriptor from a legacy wire shape to the current one — the READ side of the
 * expand→migrate→contract rename. The old monolithic `"amber"` module expands to `amber-now` +
 * `amber-timeline` (inheriting its hidden state). The old `"power-cards"` module (with its
 * `powerCards` config) becomes the `"tiles"` module (with a `tiles` config). In-memory only; the
 * persisted `dashboards` rows are rewritten by `scripts/migrate-dashboard-descriptors.ts` (which
 * reuses THIS function). KEEP until that migration has run on every environment.
 */
export function migrateLegacyDescriptor(
  s: Partial<DashboardDescriptor>,
): Partial<DashboardDescriptor> {
  if (!Array.isArray(s.cards)) return s;
  const cards: ModuleCardInstance[] = [];
  for (const c of s.cards) {
    // Pass through anything that isn't a card object (a malformed/null sibling shouldn't crash the
    // read path or the data migration — hasLegacyCards is already null-safe, so the transform must
    // be too, else a row like `{cards:[null,{type:"amber"}]}` would throw mid-rewrite forever).
    if (!c || typeof c !== "object") {
      cards.push(c);
      continue;
    }
    if ((c.type as string) === "amber") {
      cards.push({ type: "amber-now", hidden: c.hidden });
      cards.push({ type: "amber-timeline", hidden: c.hidden });
    } else if ((c.type as string) === "power-cards") {
      // Legacy `{ type: "power-cards", powerCards: { order, hidden } }` → the new `tiles` shape.
      const legacy = c as ModuleCardInstance & { powerCards?: TilesConfig };
      cards.push({
        type: "tiles",
        tiles: legacy.powerCards ?? legacy.tiles,
        hidden: c.hidden,
      });
    } else {
      cards.push(c);
    }
  }
  return { ...s, cards };
}

/** First-wins dedupe of cards by type (matches normalizeDescriptor's seen-set rule). */
function dedupeCardsByType(cards: ModuleCardInstance[]): ModuleCardInstance[] {
  const seen = new Set<string>();
  const out: ModuleCardInstance[] = [];
  for (const c of cards) {
    const t = c?.type as string | undefined;
    if (t !== undefined) {
      if (seen.has(t)) continue;
      seen.add(t);
    }
    out.push(c);
  }
  return out;
}

/**
 * The descriptor data migration's per-row transform (WRITE side): the rewritten descriptor for a
 * persisted `dashboards` row, or null if the row carries no legacy card (so the caller skips the
 * write — keeping current rows byte-unchanged and the migration idempotent). Applies the same pure
 * rename as the read path (`migrateLegacyDescriptor`) plus a defensive first-wins dedupe by type;
 * unlike `normalizeDescriptor` it is non-lossy (no layout-discard, no dropping unknown cards).
 * Used by scripts/migrate-dashboard-descriptors.ts.
 */
export function migrateLegacyDescriptorRow(
  d: unknown,
): Partial<DashboardDescriptor> | null {
  if (!hasLegacyCards(d)) return null;
  const migrated = migrateLegacyDescriptor(d as Partial<DashboardDescriptor>);
  return {
    ...migrated,
    cards: dedupeCardsByType((migrated.cards ?? []) as ModuleCardInstance[]),
  };
}

/**
 * Reconcile a saved descriptor with the current default. Discards the save if the layout changed
 * (e.g. the system's vendor type changed); otherwise keeps the saved card ORDER + hidden/tiles
 * config, appends module cards introduced since the save (as visible defaults), and drops any that
 * no longer exist. Returns the default if `saved` is missing or malformed. Legacy wire shapes are
 * upgraded first (migrateLegacyDescriptor).
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
  const s = migrateLegacyDescriptor(raw);
  const savedByType = new Map(s.cards!.map((c) => [c.type, c]));
  const defByType = new Map(def.cards.map((c) => [c.type, c]));

  // Card order follows the SAVED order (so a Customize reorder sticks), keeping only types that
  // still exist in the default; any default cards introduced since the save are appended.
  const orderedTypes: DashboardCardType[] = [];
  const seen = new Set<DashboardCardType>();
  for (const c of s.cards!) {
    if (defByType.has(c.type) && !seen.has(c.type)) {
      orderedTypes.push(c.type);
      seen.add(c.type);
    }
  }
  for (const c of def.cards) {
    if (!seen.has(c.type)) {
      orderedTypes.push(c.type);
      seen.add(c.type);
    }
  }

  const cards: ModuleCardInstance[] = orderedTypes.map((type) => {
    const defCard = defByType.get(type)!;
    const sc = savedByType.get(type);
    if (!sc) return defCard; // card introduced since the save → default (visible)
    const card: ModuleCardInstance = { type, hidden: !!sc.hidden };
    if (type === "tiles") {
      card.tiles = normalizeTiles(sc.tiles, defCard.tiles!);
    }
    return card;
  });
  return { version: 2, layout: def.layout, cards };
}

/** The tiles module's config from a descriptor (or a default if absent). */
export function tilesConfigOf(descriptor: DashboardDescriptor): TilesConfig {
  const card = descriptor.cards.find((c) => c.type === "tiles");
  return card?.tiles ?? defaultTilesConfig();
}

/** Whether a module card is present and not hidden. */
export function isCardVisible(
  descriptor: DashboardDescriptor,
  type: DashboardCardType,
): boolean {
  const card = descriptor.cards.find((c) => c.type === type);
  return !!card && !card.hidden;
}
