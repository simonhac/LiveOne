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
 * 🛑 **Strictness here is SILENT at the call sites that matter.** `areaRefToUuid` returns null and
 * `dashboardAreaUuids` (lib/dashboard/composition.ts) `.filter()`s nulls away. A raw uuid therefore
 * does not error — it DISAPPEARS, narrowing an authorization set rather than widening it (fail-closed,
 * not a leak, but also not visible). That is why the write paths must reject a non-`ar_` ref
 * explicitly instead of relying on decode to catch it.
 *
 * ⚠️ **`areaRefToArId` REMAINS dual-accept — but it is down to ONE producer** (config-v4 Phase 14,
 * reconciled at the stage-15 rebase). Of the three the original note listed, all three are now gone:
 *   * `buildAreaStrategyForHandle` died with **stage 13** (both legacy route trees deleted).
 *   * `lib/dashboard/v3-to-v4.ts`'s `pureAreaRef` lost its last caller in **stage 15** — nothing
 *     rewrites a v3 descriptor any more.
 *   * The helper-device `vendorSiteId` was retired at the source in **stage 17**: `helperSiteId`
 *     mints `helper:area:ar_…`, migration **0053** rewrote every stored row (applied to prod AND
 *     dev), and `parentAreaIdFromHelperSiteId` now always returns `ar_`.
 * The one that remains:
 *   1. `buildSeedDoc` (lib/dashboard/v4-seed.ts) passes the area's raw uuid straight in — a
 *      machine-built seed, so neither form is a user error.
 * So it **still cannot be tightened**: that one alone would break dashboard creation. Encoding is a
 * widening operation and cannot lose information; decoding is where the guarantee has to hold. Hence
 * strict decode + tolerant encode.
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
 * Intentionally still dual-accept — two live raw-uuid producers feed it (see the header).
 */
export function areaRefToArId(ref: string): AreaId | null {
  if (Area.is(ref)) return ref;
  return isCanonicalUuid(ref) ? Area.encode(ref) : null;
}

// `descriptorAreaRefsAreStrict` and `encodeDescriptorAreaRefs` were DELETED by config-v4 Phase 14
// stage 15. Both operated on `dashboards.descriptor`; nothing reads or writes that column any more,
// so the last thing either could normalize was a value no code produces.
