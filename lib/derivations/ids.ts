/**
 * Deterministic `derivations.id` minting.
 *
 * A derivation's identity is a UUIDv5 over `(anchor, kind, role)` rather than a random uuid, which
 * buys three things the Phase-11 fill and the prod→dev sync both rely on:
 *
 * - the fill is **idempotent** — re-running it upserts by primary key instead of duplicating;
 * - dev and prod mint the **same id** for the same logical derivation, so `prod-dev-sync` copies
 *   `derivations` as a plain by-PK upsert with no `excludeCols`/idDrift dance — and a role-less row
 *   (the HWS model) still has a stable identity;
 * - `derived_intervals.derivation_id` therefore means the same thing in both environments.
 *
 * The namespace is a one-off random UUID and must NEVER change: doing so re-mints every derivation
 * id and orphans its intervals. Same discipline as `POINT_UID_NAMESPACE`.
 *
 * ## 🛑 The anchor moved (migration 0063), and there are three consequences
 *
 * The anchor used to be the AREA. It is now the derivation's own **source point** uuid — the signal
 * point for a run-detector, the power point for an hws-model:
 *
 * 1. **Existing ids are never recomputed.** `ensureRunDetector`/`ensureHwsDerivation` ask
 *    `derivation_sources` whether the wiring already exists (a natural-key lookup) and only reach
 *    this function on the INSERT path. A pre-0063 row keeps its area-anchored id forever, and so do
 *    the `derived_intervals` and `automations.trigger.derivationId` that name it. Re-anchoring is
 *    therefore not a migration — nothing is re-minted.
 * 2. **It is cross-environment stable, which the alternative was not.** `points.id` is itself a
 *    uuidv5, so prod and dev mint the same one for the same logical point. Anchoring on
 *    `devices.id` — the other obvious choice now that a derivation belongs to a device — would NOT
 *    have been: those are per-environment random UUIDv7s (see `prod-dev-sync`'s `devices` idDrift
 *    leg), so every derivation id would diverge and the by-PK upsert would break.
 * 3. **Two derivations of the same kind+role on one point are the same derivation.** That is the
 *    intent, and it is what makes the natural-key lookup and this mint agree. The looser hazard —
 *    two detectors for one role sharing an OWNER device via different signal points — is not
 *    expressible here and is refused by `ensureRunDetector`'s `owner-role-taken` check instead.
 */
import { uuidv5 } from "@/lib/identifiers/point-uid";

const DERIVATION_ID_NAMESPACE = "7c1f5b62-0a4e-4d3f-9b8a-2e6d41c07f95";

/**
 * The deterministic id for a derivation. `anchor` is its source point's uuid (see the note above);
 * `role` is null for role-less kinds (e.g. the HWS model), which still yields a stable id because
 * the kind disambiguates it on the same point.
 */
export function deriveDerivationId(
  anchor: string,
  kind: string,
  role: string | null,
): string {
  return uuidv5(`${anchor}:${kind}:${role ?? ""}`, DERIVATION_ID_NAMESPACE);
}
