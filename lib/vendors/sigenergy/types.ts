/**
 * Sigenergy (mySigen) integration — shared types.
 *
 * Field names and units confirmed against a live account (station 102026062300090):
 * the cloud energy-flow endpoint returns instantaneous power in **kW** and battery SOC in **%**.
 */

export type SigenRegion = "aus" | "eu" | "apac" | "us" | "cn";

/** Per-user credentials stored in Clerk private metadata for a Sigenergy system. */
export interface SigenergyCredentials {
  username: string;
  password: string;
  region?: SigenRegion; // default "aus"
}

/** Station metadata (from /device/owner/station/home), used to provision a LiveOne system. */
export interface SigenergyStationInfo {
  stationId: string;
  name?: string;
  timeZoneName?: string; // e.g. "Australia/Sydney"
  pvCapacityKw?: number | null;
  batteryCapacityKwh?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  hasAcCharger?: boolean;
  acSnList?: string[];
  raw: unknown;
}

/** Raw energy-flow metrics (power in kW as returned by the API; SOC in %). */
export interface SigenergyEnergyFlow {
  pvKw: number | null;
  batteryKw: number | null; // + charge / − discharge
  gridKw: number | null; // + import(buy) / − export(sell)
  loadKw: number | null;
  evKw: number | null;
  batterySoc: number | null; // %
  raw: unknown;
}

/**
 * Normalized snapshot the adapter maps onto points — all power in **Watts**, SOC in %.
 * Keys (minus `timestamp`) line up 1:1 with `SIGENERGY_POINTS` in point-metadata.ts.
 */
export interface SigenergyData {
  timestamp: Date;
  solarW: number | null;
  batteryW: number | null;
  batterySOC: number | null;
  gridW: number | null;
  loadW: number | null;
  evW: number | null;
}
