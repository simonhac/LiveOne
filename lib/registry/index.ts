/**
 * Point identity registry — the uuid↔rid↔address bridge for the config-v4 readings seam.
 * See registry-cache.ts. Import `RegistryCache` (and the branded key types) from here.
 */
export {
  RegistryCache,
  UnknownIdError,
  type PointRid,
  type DeviceRid,
  type Rid,
  type PointAddr,
  type UnknownIdKind,
} from "./registry-cache";
