/**
 * Composition-first dashboards (Phase 2b-2) — resolving the Areas a dashboard references.
 *
 * A composition dashboard has no home device/area: every scope ref sits on a node envelope in the v4
 * document (§8.3), and each card self-fetches its Area's data.
 */
import { isDashboardV4 } from "./v4";
import { collectRefs } from "./v4-validate";
import { Area } from "@/lib/ids";

/**
 * The distinct Area UUIDS a dashboard references — the §8.3 envelope walk over its v4 `doc`, each
 * `ar_` ref decoded to the raw uuid.
 *
 * config-v4 Phase 14 stage 15: there is no second shape any more. This used to fall back to the v3
 * `descriptor` when `doc` was not a valid v4; that fallback is gone with the column, so a doc that
 * fails the shape guard now yields an EMPTY scope. That is the fail-closed direction — an
 * unresolvable dashboard authorizes nothing — and matches the render path, which likewise renders an
 * empty document rather than silently serving a second, divergent shape.
 *
 * A ref that will not decode is filtered out silently, which narrows the set rather than widening it;
 * the write paths (v4 validation, strict `ar_` refs) are what guarantee no such ref is ever stored.
 * ALWAYS returns raw uuids (below the seam), so callers may hand the result straight to a below-seam
 * DAO (`getLegacySystemIdForArea`, `resolveAreasByIds`, …).
 */
export function dashboardAreaUuids(d: { doc?: unknown }): string[] {
  if (!isDashboardV4(d.doc)) return [];
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
