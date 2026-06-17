/**
 * Composition-first dashboards (Phase 2b-2) — helpers for building their descriptors.
 *
 * A composition dashboard reuses the existing `DashboardDescriptor`, with the convention that EVERY
 * card carries its own `areaId` (no home system/area). The renderer iterates the cards and each
 * self-fetches its Area's data. `layout` is vestigial for composition dashboards (the renderer is a
 * flat ordered list, not a vendor template).
 */
import type { ReadableArea } from "@/lib/areas/list";
import type { DashboardDescriptor } from "./descriptor";
import type { DashboardCardType } from "./cards";
import {
  buildDefaultDashboardV3,
  emptyDashboardV3,
  isDashboardV3,
  type DashboardV3,
} from "./v3";

/** An empty composition dashboard — no sections yet (the user adds them in the configurator). */
export function emptyCompositionDescriptor(): DashboardV3 {
  return emptyDashboardV3();
}

/**
 * Seed a composition dashboard from an Area's default card set (the v3 area strategy): one AreaSection
 * bound to the Area, vendor-appropriate cards. Pure STARTING CONTENT — the user freely edits afterwards.
 */
export function buildSeedDescriptor(
  area: Pick<ReadableArea, "id">,
  system: { vendorType: string },
): DashboardV3 {
  return buildDefaultDashboardV3({
    areaId: area.id,
    vendorType: system.vendorType,
  });
}

/**
 * Whether a card type can render for a given vendor type, using ONLY the vendor-deterministic subset
 * of `CARD_REGISTRY.canRender` (`tiles`/`grid-signals` are pointless on pure-amber; `sankey` needs a
 * site vendor). The data-driven predicates (`chart`, `amber-*`, `generator-runs`) need live `latest`,
 * which isn't available server-side, so they — and any unknown/future type — default to compatible.
 * The client gallery + renderer remain the authority for those.
 */
export function isCardTypeVendorCompatible(
  type: DashboardCardType,
  vendorType: string,
): boolean {
  switch (type) {
    case "tiles":
    case "grid-signals":
      return vendorType !== "amber";
    case "sankey":
      return vendorType === "mondo" || vendorType === "composite";
    default:
      return true;
  }
}

/**
 * Drop cards whose type can't render for their bound Area's vendor type (vendor-deterministic rules
 * only — see `isCardTypeVendorCompatible`). Cards with no `areaId` or an unresolvable vendor type are
 * KEPT (drop, never reject: matches the codebase's defensive ethos and can't brick a save). Used by
 * the authoring PATCH so a descriptor can't persist a permanently-broken card.
 */
export function filterVendorIncompatibleCards(
  descriptor: DashboardDescriptor,
  vendorTypeByAreaId: Map<string, string>,
): DashboardDescriptor {
  const cards = descriptor.cards.filter((c) => {
    if (!c.areaId) return true;
    const vt = vendorTypeByAreaId.get(c.areaId);
    if (vt == null) return true;
    return isCardTypeVendorCompatible(c.type, vt);
  });
  return cards.length === descriptor.cards.length
    ? descriptor
    : { ...descriptor, cards };
}

/**
 * The distinct Area ids a dashboard descriptor references (its scope set). Handles BOTH shapes: v3
 * (each section's `areaId`) and the legacy per-system v2 (each card's `areaId`). Used by the read-access
 * scope (access.ts) and the authoring no-escalation check, so it must never assume one shape.
 */
export function descriptorAreaIds(descriptor: unknown): string[] {
  if (isDashboardV3(descriptor)) {
    return [...new Set(descriptor.sections.map((s) => s.areaId))];
  }
  const cards = (descriptor as { cards?: { areaId?: unknown }[] } | null)
    ?.cards;
  if (!Array.isArray(cards)) return [];
  return [
    ...new Set(
      cards
        .map((c) => c?.areaId)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
}
