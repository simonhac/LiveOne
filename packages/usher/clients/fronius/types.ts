/**
 * Fronius device + report types (ported from FroniusPusher `types/device.ts` + `types/fronius.ts`).
 */

// ── device info (from the Solar API) ────────────────────────────────────────

export interface BatteryInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  capacityWh?: number;
  enabled?: boolean;
}

export interface InverterInfo {
  manufacturer: string;
  model: string;
  pvPowerW: number;
  customName: string;
  serialNumber: string;
}

export interface MeterInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  location?: string;
  enabled?: boolean;
}

export interface DeviceInfo {
  inverter: InverterInfo;
  battery?: BatteryInfo;
  meter?: MeterInfo;
}

// ── the minutely report the fusher source produces ──────────────────────────
// Field names match the FUSHER_POINTS manifest keys (byte-for-byte continuity with the legacy
// /api/push/fusher shape). Only the subset in the manifest is pushed to gusher.

export interface FroniusMinutely {
  timestamp: string; // ISO 8601 (local, with offset)
  sequence: string; // "XXXX/N" — session id + incrementing counter
  solarW: number;
  solarWhInterval: number;

  solarLocalW: number;
  solarLocalWhInterval: number;

  solarRemoteW: number;
  solarRemoteWhInterval: number;

  loadW: number;
  loadWhInterval: number;

  batteryW: number;
  batteryInWhInterval: number;
  batteryOutWhInterval: number;

  gridW: number;
  gridInWhInterval: number;
  gridOutWhInterval: number;

  batterySOC: number | null;

  faultCode: string | number | null;
  faultTimestamp: string | null;

  generatorStatus: null; // Fronius has no generator
}
