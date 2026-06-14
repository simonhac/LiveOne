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
  POWER_CARD_IDS,
  type DashboardCardType,
  type DashboardLayout,
  type PowerCardId,
} from "./cards";

/** Per-card customization for the power mini-cards inside the `power-cards` module. */
export interface PowerCardsConfig {
  order: PowerCardId[];
  hidden: PowerCardId[];
}

export interface ModuleCardInstance {
  type: DashboardCardType;
  /** Hidden module cards are persisted but not rendered (re-addable from the gallery). */
  hidden?: boolean;
  /** Only meaningful for type === "power-cards". */
  powerCards?: PowerCardsConfig;
}

export interface DashboardDescriptor {
  version: 2;
  layout: DashboardLayout;
  cards: ModuleCardInstance[];
}

/** Cards each layout shows by default — the exact set the vendor_type ladder renders today. */
const CARDS_BY_LAYOUT: Record<DashboardLayout, DashboardCardType[]> = {
  amber: ["amber-now", "amber-timeline"],
  site: ["power-cards", "site-charts", "sankey", "generator-runs"],
  sidebar: ["power-cards", "energy-chart", "generator-runs"],
};

function defaultPowerCardsConfig(): PowerCardsConfig {
  return { order: [...POWER_CARD_IDS], hidden: [] };
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
    type === "power-cards"
      ? { type, powerCards: defaultPowerCardsConfig() }
      : { type },
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

function normalizePowerCards(
  saved: unknown,
  def: PowerCardsConfig,
): PowerCardsConfig {
  const s = saved as Partial<PowerCardsConfig> | undefined;
  if (!s || !Array.isArray(s.order)) return def;
  const valid = new Set<PowerCardId>(def.order);
  const order = s.order.filter((id): id is PowerCardId =>
    valid.has(id as PowerCardId),
  );
  // Append any newly-introduced power cards not present in the saved order.
  for (const id of def.order) if (!order.includes(id)) order.push(id);
  const hidden = (Array.isArray(s.hidden) ? s.hidden : []).filter(
    (id): id is PowerCardId => valid.has(id as PowerCardId),
  );
  return { order, hidden };
}

/**
 * Upgrade a saved descriptor from a legacy wire shape to the current one — the READ side of the
 * expand→migrate→contract rename. The old monolithic `"amber"` module expands to `amber-now` +
 * `amber-timeline` (inheriting its hidden state). In-memory only; the persisted `dashboards` rows
 * are rewritten by a separate data migration once this is deployed. KEEP until that migration ships.
 */
function migrateLegacyDescriptor(
  s: Partial<DashboardDescriptor>,
): Partial<DashboardDescriptor> {
  if (!Array.isArray(s.cards)) return s;
  const cards: ModuleCardInstance[] = [];
  for (const c of s.cards) {
    if ((c.type as string) === "amber") {
      cards.push({ type: "amber-now", hidden: c.hidden });
      cards.push({ type: "amber-timeline", hidden: c.hidden });
    } else {
      cards.push(c);
    }
  }
  return { ...s, cards };
}

/**
 * Reconcile a saved descriptor with the current default. Discards the save if the layout changed
 * (e.g. the system's vendor type changed); otherwise keeps the saved hidden/order, adds module/power
 * cards introduced since, and drops any that no longer exist. Returns the default if `saved` is
 * missing or malformed. Legacy wire shapes are upgraded first (migrateLegacyDescriptor).
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
  const cards: ModuleCardInstance[] = def.cards.map((defCard) => {
    const sc = savedByType.get(defCard.type);
    if (!sc) return defCard; // module card introduced since the save → default (visible)
    const card: ModuleCardInstance = {
      type: defCard.type,
      hidden: !!sc.hidden,
    };
    if (defCard.type === "power-cards") {
      card.powerCards = normalizePowerCards(sc.powerCards, defCard.powerCards!);
    }
    return card;
  });
  return { version: 2, layout: def.layout, cards };
}

/** The power-cards module's config from a descriptor (or a default if absent). */
export function powerCardsConfigOf(
  descriptor: DashboardDescriptor,
): PowerCardsConfig {
  const card = descriptor.cards.find((c) => c.type === "power-cards");
  return card?.powerCards ?? defaultPowerCardsConfig();
}

/** Whether a module card is present and not hidden. */
export function isCardVisible(
  descriptor: DashboardDescriptor,
  type: DashboardCardType,
): boolean {
  const card = descriptor.cards.find((c) => c.type === type);
  return !!card && !card.hidden;
}
