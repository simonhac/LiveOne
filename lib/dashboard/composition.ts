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
