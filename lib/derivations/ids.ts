/**
 * Deterministic `derivations.id` minting.
 *
 * A derivation's identity is a UUIDv5 over `(area, kind, role)` rather than a random uuid, which
 * buys three things the Phase-11 fill and the prod→dev sync both rely on:
 *
 * - the fill is **idempotent** — re-running it upserts by primary key instead of duplicating;
 * - dev and prod mint the **same id** for the same logical derivation (areas share their uuid
 *   across environments), so `prod-dev-sync` copies `derivations` as a plain by-PK upsert with no
 *   `excludeCols`/idDrift dance — and a role-less row (the HWS model) still has a stable identity;
 * - `derived_intervals.derivation_id` therefore means the same thing in both environments.
 *
 * The namespace is a one-off random UUID and must NEVER change: doing so re-mints every derivation
 * id and orphans its intervals. Same discipline as `POINT_UID_NAMESPACE`.
 */
import { uuidv5 } from "@/lib/identifiers/point-uid";

export const DERIVATION_ID_NAMESPACE = "7c1f5b62-0a4e-4d3f-9b8a-2e6d41c07f95";

/**
 * The deterministic id for a derivation. `role` is null for role-less kinds (e.g. the HWS model),
 * which still yields a stable id because the kind disambiguates it within the area.
 */
export function deriveDerivationId(
  areaId: string,
  kind: string,
  role: string | null,
): string {
  return uuidv5(`${areaId}:${kind}:${role ?? ""}`, DERIVATION_ID_NAMESPACE);
}
