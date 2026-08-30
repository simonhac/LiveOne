/**
 * Area-ref helpers. **The decode leg is STRICT; the encode leg is not — and the asymmetry is the
 * whole content of this file.**
 *
 * Decode was dual-accept while stored documents and deployed code did not migrate in lockstep, so a
 * reader written against `ar_` still had to resolve an unmigrated raw-uuid ref. **That window is
 * closed.** Measured 2026-07-31 directly against prod `sydney` and `liveone-dev`: every stored area
 * ref is `ar_` on BOTH, zero raw uuids. So `areaRefToUuid` no longer accepts a raw uuid.
 *
 * 🛑 **Strictness here is SILENT at the call sites that matter.** `areaRefToUuid` returns null and
 * `dashboardAreaUuids` (lib/dashboard/composition.ts) `.filter()`s nulls away. A raw uuid therefore
 * does not error — it DISAPPEARS, narrowing an authorization set rather than widening it (fail-closed,
 * not a leak, but also not visible). That is why the write paths must reject a non-`ar_` ref
 * explicitly instead of relying on decode to catch it.
 *
 * ⚠️ **`areaRefToArId` REMAINS dual-accept, and has two raw-uuid producers,** both machine-fed, so
 * neither form is a user error:
 *   1. `buildSeedDoc` (lib/dashboard/v4-seed.ts) passes the area's raw uuid straight in.
 *   2. `helperSiteId` (lib/areas/helper-site-id.ts) mints from the raw `areas.id` every server
 *      caller holds. Its INVERSE is dual-accept for a different reason — pre-0053 stored rows.
 * So it **cannot be tightened**: either producer alone would break. Encoding is a widening operation
 * and cannot lose information; decoding is where the guarantee has to hold. Hence strict decode +
 * tolerant encode.
 *
 * Client-safe (no server imports).
 */
import { Area, isCanonicalUuid, type AreaId } from "@/lib/ids";

/**
 * Decode an `ar_` TypeID to its raw uuid. **Strict** — a raw uuid is NOT accepted and yields null.
 * Callers that treat null as "skip" are narrowing a set silently; see the header.
 */
export function areaRefToUuid(ref: string): string | null {
  return Area.toUuidOrNull(ref);
}

/**
 * Normalize EITHER a raw uuid or an `ar_` TypeID to the `ar_` TypeID. Null if neither.
 * Intentionally still dual-accept — ONE live raw-uuid producer feeds it (see the header).
 */
export function areaRefToArId(ref: string): AreaId | null {
  if (Area.is(ref)) return ref;
  return isCanonicalUuid(ref) ? Area.encode(ref) : null;
}

// `descriptorAreaRefsAreStrict` / `encodeDescriptorAreaRefs` are gone: both operated on
// `dashboards.descriptor`, which migration 0054 dropped.
