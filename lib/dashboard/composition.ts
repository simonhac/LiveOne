/**
 * Composition-first dashboards (Phase 2b-2) — helpers for building their descriptors.
 *
 * A composition dashboard reuses the existing `DashboardDescriptor`, with the convention that EVERY
 * card carries its own `areaId` (no home system/area). The renderer iterates the cards and each
 * self-fetches its Area's data. `layout` is vestigial for composition dashboards (the renderer is a
 * flat ordered list, not a vendor template).
 */
import type { ReadableArea } from "@/lib/areas/list";
import { buildDefaultDescriptor, type DashboardDescriptor } from "./descriptor";
import type { DashboardCardType } from "./cards";
import type { LatestPointValues } from "@/lib/types/api";

/** An empty composition dashboard — no cards yet (the user adds them from the picker). */
export function emptyCompositionDescriptor(): DashboardDescriptor {
  return { version: 2, layout: "site", cards: [] };
}

/**
 * Seed a composition dashboard from an Area's default card set: the cards `buildDefaultDescriptor`
 * picks for that Area's system, each stamped with the Area's id + a unique instance id. This is pure
 * STARTING CONTENT — the Area is not a "home"; the user freely adds/removes cards afterwards.
 */
export function buildSeedDescriptor(
  area: Pick<ReadableArea, "id">,
  system: { vendorType: string },
): DashboardDescriptor {
  const base = buildDefaultDescriptor(system, {} as LatestPointValues);
  const short = area.id.slice(0, 8);
  const cards = base.cards.map((c, i) => ({
    ...c,
    // Unique per-instance id so two Areas' same-type cards never collide on identity.
    id: `${c.id ?? c.type}@${short}-${i}`,
    areaId: area.id,
  }));
  return { version: 2, layout: base.layout, cards };
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

/** The distinct Area ids a composition descriptor references (its scope set). */
export function descriptorAreaIds(descriptor: DashboardDescriptor): string[] {
  return [
    ...new Set(
      descriptor.cards
        .map((c) => c.areaId)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
}
