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
  /** Station commissioning / "open" day, local, "YYYY-MM-DD" (from `stationOpenTime`, with fallbacks).
   *  This is the station's earliest-possible data date — used to floor the coverage-repair window so
   *  pre-commission days aren't flagged as phantom gaps and genuine pre-onboarding history stays in range. */
  openDate?: string;
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

/**
 * A day's energy statistics from `/data-process/sigen/station/statistics/energy` (dateFlag=1).
 * `totals` are the day's kWh totals; `intervals` is the 5-minute `itemList` whose energy fields are
 * CUMULATIVE-since-local-midnight kWh counters (reset at midnight; `dataTime` = interval START).
 */
export interface SigenergyEnergyTotals {
  powerGeneration: number | null; // PV generation (kWh)
  powerUse: number | null; // household consumption (kWh)
  powerToGrid: number | null; // export (kWh)
  powerFromGrid: number | null; // import (kWh)
  esCharging: number | null; // battery charge (kWh)
  esDischarging: number | null; // battery discharge (kWh)
}

export interface SigenergyEnergyInterval extends SigenergyEnergyTotals {
  /** Local wall-clock start of the 5-min interval, "YYYYMMDD HH:MM". */
  dataTime: string;
}

export interface SigenergyDayEnergy {
  /** The queried day, YYYYMMDD. */
  date: string;
  totals: SigenergyEnergyTotals;
  intervals: SigenergyEnergyInterval[];
  raw: unknown;
}
