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

/** Station metadata (from /device/owner/station/home), used to provision a LiveOne device. */
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

/**
 * Raw energy-flow metrics (power in kW as returned by the API; SOC in %) — VENDOR signs, which are
 * "outflow positive" on both bidi channels. `sigenergyFlowToData` negates them into LiveOne's
 * canonical "inflow positive" convention; see the sign note there.
 */
export interface SigenergyEnergyFlow {
  pvKw: number | null;
  batteryKw: number | null; // + charge / − discharge
  // + export(sell) / − import(buy). NOT the reverse: the vendor's own balance identity
  // `pv = buySellPower + battery + load + ac` only closes under this reading (verified, n=2329).
  gridKw: number | null;
  loadKw: number | null;
  /** EV charging (a load; excluded from `loadKw` — the two are siblings, verified by the identity above). */
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

/**
 * The INSTANTANEOUS power + SoC an `itemList` row also carries (kW / %), vendor signs.
 *
 * The statistics endpoint is not energy-only: every row reports the same snapshot fields the live
 * `energyflow` endpoint does. Discovered 2026-08-31, having assumed for the life of this integration
 * that Sigenergy served no historical power — see
 * `docs/plans/sigenergy-counter-dropout-forensics.md`.
 *
 * These are a genuine measurement of the interval, and independent of the cumulative counters: at
 * the 2026-08-20 19:20 dropout, every energy counter collapsed to 0 while `loadPower` (2.219 kW)
 * and `batSoc` (55.1 %) stayed sane. Validated against our own polled samples for that day (n=268):
 * `pvTotalPower` matches `source.solar/power.avg` to a median 0.0 W, `batSoc` to 0.0 %.
 *
 * ⚠️ `load` is the site TOTAL and includes the EV — the same semantics as `powerUse`, and there is
 * no EV field. On EV-charging (>2 kW) intervals it misses rest-of-house alone by 6850 W and the sum
 * by 57.5 W.
 */
export interface SigenergyIntervalPower {
  solarKw: number | null;
  /** TOTAL site load, EV included. */
  loadKw: number | null;
  gridImportKw: number | null;
  gridExportKw: number | null;
  batteryChargeKw: number | null;
  batteryDischargeKw: number | null;
  socPct: number | null;
}

export interface SigenergyEnergyInterval
  extends SigenergyEnergyTotals,
    SigenergyIntervalPower {
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
