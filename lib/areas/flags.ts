/**
 * Areas feature flag (P3). Read once at module load. Only the exact string "true" (trimmed,
 * case-insensitive) is truthy — mirrors lib/db/routing.ts.
 */

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve composite role→point mappings from the typed `area_bindings` table instead of the untyped
 * `systems.metadata` JSON. Off → byte-identical to the previous behaviour (reads metadata.mappings).
 * On → the three composite read sites (PointManager._resolveCompositeSystemPoints,
 * CompositeAdapter.getLastReading, buildSubscriptionRegistry) read area_bindings, and the composite
 * editor dual-writes bindings alongside metadata. The composite systems-row shim + its metadata stay
 * live through the soak, so /api/data (returns metadata raw) is frozen and rollback = flag off.
 * See docs/architecture/areas-and-dashboards.md (P3).
 */
export const AREAS_TABLE = envFlag("AREAS_TABLE");
