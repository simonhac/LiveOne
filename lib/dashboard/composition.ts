/**
 * Composition-first dashboards (Phase 2b-2) — helpers for building their descriptors.
 *
 * A composition dashboard reuses the existing `DashboardDescriptor`, with the convention that EVERY
 * card carries its own `areaId` (no home system/area). The renderer iterates the cards and each
 * self-fetches its Area's data. `layout` is vestigial for composition dashboards (the renderer is a
 * flat ordered list, not a vendor template).
 */
import { emptyDashboardV3, isDashboardV3, type DashboardV3 } from "./v3";
import { isDashboardV4 } from "./v4";
import { collectRefs } from "./v4-validate";
import { Area } from "@/lib/ids";
import { areaRefToUuid } from "@/lib/areas/ref";

/** An empty composition dashboard — no sections yet (the user adds them in the configurator). */
export function emptyCompositionDescriptor(): DashboardV3 {
  return emptyDashboardV3();
}

// A composition dashboard's default card set (the "seed") is built server-side from the Area's
// CAPABILITIES via `buildAreaStrategyForHandle` (lib/capabilities/server.ts) — no vendor template.

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

/**
 * The distinct Area UUIDS a dashboard references, SHAPE-AWARE: a v4 `doc` (via the §8.3 envelope walk,
 * decoded to uuids) else the v3 `descriptor` (its stored `section.areaId` is `ar_`, dual-accept-decoded
 * to uuid — `areaRefToUuid` also tolerates a not-yet-migrated raw-uuid descriptor). Use this wherever
 * the render path resolves a dashboard's areas, so a v4 doc's sections resolve on the shared/grantee
 * paths too (the owner path already lists all readable areas). Unlike `descriptorAreaIds`, this ALWAYS
 * returns raw uuids (below the seam) regardless of the stored ref form — callers passing the result to
 * a below-seam DAO (`getLegacySystemIdForArea`, `resolveAreasByIds`, …) must use this, not
 * `descriptorAreaIds`.
 */
export function dashboardAreaUuids(d: {
  descriptor?: unknown;
  doc?: unknown;
}): string[] {
  if (isDashboardV4(d.doc)) {
    return [
      ...new Set(
        collectRefs(d.doc)
          .areas.map((a) => {
            try {
              return Area.toUuid(a);
            } catch {
              return null;
            }
          })
          .filter((x): x is string => x != null),
      ),
    ];
  }
  return [
    ...new Set(
      descriptorAreaIds(d.descriptor)
        .map((ref) => areaRefToUuid(ref))
        .filter((x): x is string => x != null),
    ),
  ];
}
