/**
 * Area-ref helpers. **The decode leg is STRICT; the encode leg is not — and the asymmetry is the
 * whole content of this file.** (config-v4 Phase 14; the dual-accept decode dates from Phase 9 PR2.)
 *
 * The Phase-9 rationale was that the persisted v3 descriptor and the deployed code did not migrate in
 * lockstep, so a reader written against `ar_` had to still resolve an unmigrated (raw-uuid) descriptor.
 * **That window is closed.** Measured 2026-07-31 directly against prod `sydney` and `liveone-dev`:
 * 16/16 `descriptor.sections[].areaId` and 16/16 `doc` area refs are `ar_` on BOTH, zero raw uuids,
 * and the newest dashboard predates the check. So `areaRefToUuid` no longer accepts a raw uuid.
 *
 * 🛑 **Strictness here is SILENT at the call sites that matter.** `areaRefToUuid` returns null, and
 * both `dashboardAreaUuids` (lib/dashboard/composition.ts) and the SSR section walk
 * (app/dashboard/[...slug]/page.tsx) `.filter()` nulls away. A raw uuid therefore does not error — it
 * DISAPPEARS, narrowing an authorization set rather than widening it (fail-closed, not a leak, but
 * also not visible). That is why the write paths must reject a non-`ar_` ref explicitly instead of
 * relying on decode to catch it: see `PATCH /api/dashboards/{id}`, which now 400s rather than
 * persisting a descriptor whose refs would later decode to nothing.
 *
 * ⚠️ **`areaRefToArId` REMAINS dual-accept, deliberately.** Three live producers still emit raw area
 * uuids into it, so making it strict would break working paths, not tighten them:
 *   1. `buildAreaStrategyForHandle` (lib/capabilities/server.ts) passes `area.id` — a raw uuid —
 *      straight into `section.areaId`; `GET /api/areas/{id}/default-section` launders it here.
 *   2. `lib/dashboard/v3-to-v4.ts`'s `pureAreaRef`, fed by those same descriptors.
 *   3. The helper-device `vendorSiteId` (`helper:area:<raw uuid>`), decoded client-side by the
 *      battery-provenance-history card. That one is the `/api/data` raw-uuid leak; it is NOT fixed
 *      here because the honest fixes are a `devices.vendor_site_id` data migration or a new wire
 *      field, and this PR is code-only.
 * Encoding is a widening operation and cannot lose information; decoding is where the guarantee has
 * to hold. Hence strict decode + tolerant encode.
 *
 * Client-safe (no server imports).
 */
import { Area, isCanonicalUuid, type AreaId } from "@/lib/ids";
import type { AreaSectionV3, DashboardV3 } from "@/lib/dashboard/v3";

/**
 * Decode an `ar_` TypeID to its raw uuid. **Strict** — a raw uuid is NOT accepted and yields null.
 * Callers that treat null as "skip" are narrowing a set silently; see the header.
 */
export function areaRefToUuid(ref: string): string | null {
  return Area.toUuidOrNull(ref);
}

/**
 * Normalize EITHER a raw uuid or an `ar_` TypeID to the `ar_` TypeID. Null if neither.
 * Intentionally still dual-accept — three live raw-uuid producers feed it (see the header).
 */
export function areaRefToArId(ref: string): AreaId | null {
  if (Area.is(ref)) return ref;
  return isCanonicalUuid(ref) ? Area.encode(ref) : null;
}

/** True iff every section's `areaId` in a v3 descriptor is already an `ar_` TypeID. */
export function descriptorAreaRefsAreStrict(d: DashboardV3): boolean {
  return d.sections.every((s: AreaSectionV3) => Area.is(s.areaId));
}

/**
 * Rewrite every section's `areaId` in a v3 descriptor to `ar_`, leaving a value neither a raw uuid
 * nor an `ar_` id untouched (there is no such producer left since Phase 14 stage 9 retired the
 * `/device` `device-<n>` sentinel; it was never persisted). Idempotent.
 *
 * Still used on the CREATE path (`POST /api/dashboards`), whose descriptor can come from
 * `buildAreaStrategyForHandle` and therefore still carry raw uuids. It is no longer used on read —
 * that read-normalize was `rowToDashboard`'s, and Phase 14 removed it.
 */
export function encodeDescriptorAreaRefs(d: DashboardV3): DashboardV3 {
  return {
    ...d,
    sections: d.sections.map((s: AreaSectionV3) => {
      const encoded = areaRefToArId(s.areaId);
      return encoded ? { ...s, areaId: encoded } : s;
    }),
  };
}
