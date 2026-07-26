/**
 * Dual-accept area-ref helpers for the config-v4 areas TypeID flip (Phase 9, PR2).
 *
 * The persisted v3 dashboard descriptor and the deployed code do not migrate in lockstep: these
 * helpers accept EITHER a raw uuid or an `ar_` TypeID, so a route/reader written against `ar_` still
 * resolves an unmigrated (raw-uuid) descriptor correctly, and the one-off data migration
 * (`scripts/config-v4/rewrite-descriptor-area-refs.ts`) can run after the code deploys rather than in
 * lockstep with it. `areaRefToUuid` is the decode primitive (below the seam); `areaRefToArId` is the
 * normalize primitive (above the seam, e.g. on read from the DB). Client-safe (no server imports).
 */
import { Area, isCanonicalUuid, type AreaId } from "@/lib/ids";
import type { AreaSectionV3, DashboardV3 } from "@/lib/dashboard/v3";

/** Decode EITHER an `ar_` TypeID or a raw uuid to the raw uuid. Null if neither. */
export function areaRefToUuid(ref: string): string | null {
  return Area.toUuidOrNull(ref) ?? (isCanonicalUuid(ref) ? ref : null);
}

/** Normalize EITHER a raw uuid or an `ar_` TypeID to the `ar_` TypeID. Null if neither. */
export function areaRefToArId(ref: string): AreaId | null {
  if (Area.is(ref)) return ref;
  return isCanonicalUuid(ref) ? Area.encode(ref) : null;
}

/**
 * Rewrite every section's `areaId` in a v3 descriptor to `ar_`, leaving a value neither a raw uuid
 * nor an `ar_` id (e.g. a `/device` `device-<n>` sentinel — never persisted) untouched. Idempotent.
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
