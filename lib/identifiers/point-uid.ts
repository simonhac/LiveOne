/**
 * Stable, vendor-derived point IDENTITY — the Home Assistant `unique_id` analog, distinct from the
 * renameable `(system_id, index)` ADDRESS. See docs/plans/identity-address-split-and-labels.md (Part 1).
 *
 * `derivePointUid` is a deterministic UUIDv5 over `(vendor_type, vendor_site_id, physical_path_tail)`,
 * so re-onboarding the same physical point (e.g. a vehicle re-added, a vendor swap that preserves the
 * site id) reproduces the SAME uid — config that cites the uid survives an address change. The rare
 * exception is the same vendor site added as two systems: both derive the same uid, so the second
 * collides on `pi_point_uid_unique` and the caller falls back to a random uid (still a valid identity,
 * just not reproducible — which is correct, since it's genuinely a distinct registry entry).
 *
 * UUIDv5 is implemented here with `node:crypto` (SHA-1) to avoid adding a `uuid` dependency. NOT
 * re-exported from `lib/identifiers/index.ts` — keep `node:crypto` out of client bundles; import this
 * module directly from server code.
 */
import { createHash } from "node:crypto";

/**
 * Fixed namespace anchoring every deterministic point identity. A one-off random UUID — NEVER change
 * it; doing so would re-mint every point's deterministic uid and break reproducibility/re-onboarding.
 */
export const POINT_UID_NAMESPACE = "a1e2c3d4-5f60-4a7b-8c9d-0e1f2a3b4c5d";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** RFC-4122 UUIDv5 (SHA-1, name-based) for `name` under `namespace`. */
export function uuidv5(
  name: string,
  namespace: string = POINT_UID_NAMESPACE,
): string {
  const ns = uuidToBytes(namespace);
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  return bytesToUuid(bytes);
}

/**
 * Deterministic point identity from vendor identity. Inputs are all non-null point/system columns
 * (`systems.vendor_type`, `systems.vendor_site_id`, `point_info.physical_path_tail`). The backfill and
 * `PointManager.ensurePointInfo` MUST use this same derivation so existing and new rows agree.
 */
export function derivePointUid(
  vendorType: string,
  vendorSiteId: string,
  physicalPathTail: string,
): string {
  return uuidv5(`${vendorType}:${vendorSiteId}:${physicalPathTail}`);
}
