/**
 * Point identity registry — the uuid↔rid↔address bridge for the config-v4 readings seam.
 * See registry-cache.ts. Import `RegistryCache` (and the branded key types) from here.
 */
export {
  RegistryCache,
  UnknownIdError,
  type PointRid,
  type DeviceRid,
  type PointAddr,
} from "./registry-cache";
export { DeviceRegistry, type DeviceAddr } from "./device-registry";
// The device CONFIG registry — `devices` read as the primary config source (config-v4 Phase 12 slice
// K1). Deliberately separate from the ADDRESSING registry above; see device-config.ts's header.
// The four device WRITERS. Since slice 1a they write `devices` + `areas`; `systems` has no writer at all.
// Reads never come from here; see device-writer.ts's header.
export { DeviceConfigRegistry, type DeviceRecord } from "./device-config";
