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
export {
  DeviceRegistry,
  UnknownDeviceIdError,
  type DeviceAddr,
  type DeviceRegistryExec,
} from "./device-registry";
// The device CONFIG registry — `devices` read as the primary config source (config-v4 Phase 12 slice
// K1). Deliberately separate from the ADDRESSING registry above; see device-config.ts's header.
// The four surviving `systems` WRITERS, relocated out of the deleted `lib/systems-manager.ts` in slice
// K3. Reads never come from here; see device-writer.ts's header.
export { DeviceWriter, type System } from "./device-writer";
export {
  DeviceConfigRegistry,
  ridOf,
  type DeviceRecord,
  type DevicePollingState,
  type VisibleDevice,
} from "./device-config";
