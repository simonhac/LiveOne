/**
 * Sigenergy point metadata — maps the normalized `SigenergyData` snapshot onto `point_info`.
 *
 * Sigenergy is a raw snapshot vendor (like Selectronic): each 5-minute poll yields one
 * instantaneous sample per point, and Postgres computes the 5m/1d aggregates. All power points
 * are stored in **Watts** (the API returns kW → we ×1000), SOC in %.
 */

import type { PointMetadata } from "@/lib/point/point-manager";
import type { PointReadingInput } from "../types";
import type { SigenergyData, SigenergyEnergyFlow } from "./types";

export interface SigenergyPointConfig {
  field: Exclude<keyof SigenergyData, "timestamp">;
  metadata: PointMetadata;
}

export const SIGENERGY_POINTS: SigenergyPointConfig[] = [
  {
    field: "solarW",
    metadata: {
      physicalPathTail: "solar_w",
      logicalPathStem: "source.solar",
      defaultName: "Solar",
      subsystem: "solar",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },
  {
    field: "batteryW",
    metadata: {
      physicalPathTail: "battery_w",
      logicalPathStem: "bidi.battery",
      defaultName: "Battery",
      subsystem: "battery",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },
  {
    field: "batterySOC",
    metadata: {
      physicalPathTail: "battery_soc",
      logicalPathStem: "bidi.battery",
      defaultName: "Battery",
      subsystem: "battery",
      metricType: "soc",
      metricUnit: "%",
      transform: null,
    },
  },
  {
    field: "gridW",
    metadata: {
      physicalPathTail: "grid_w",
      logicalPathStem: "bidi.grid",
      defaultName: "Grid",
      subsystem: "grid",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },
  {
    field: "loadW",
    metadata: {
      physicalPathTail: "load_w",
      logicalPathStem: "load",
      defaultName: "Load",
      subsystem: "load",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },
  {
    field: "evW",
    metadata: {
      physicalPathTail: "ev_w",
      logicalPathStem: "ev.charge",
      defaultName: "EV Charger",
      subsystem: "ev",
      metricType: "power",
      metricUnit: "W",
      transform: null,
    },
  },
];

/** Convert a raw energy-flow response (kW / %) into the normalized snapshot (W / %). */
export function sigenergyFlowToData(
  flow: SigenergyEnergyFlow,
  timestamp: Date,
): SigenergyData {
  const toW = (kw: number | null) =>
    kw == null ? null : Math.round(kw * 1000);
  return {
    timestamp,
    solarW: toW(flow.pvKw),
    batteryW: toW(flow.batteryKw), // + charge / − discharge (vendor sign)
    batterySOC: flow.batterySoc,
    gridW: toW(flow.gridKw), // + import / − export (vendor sign)
    loadW: toW(flow.loadKw),
    evW: toW(flow.evKw),
  };
}

/** Build the point readings array for a snapshot, skipping null-valued points. */
export function buildSigenergyReadings(
  data: SigenergyData,
  measurementTime: number,
): PointReadingInput[] {
  const readings: PointReadingInput[] = [];
  for (const { field, metadata } of SIGENERGY_POINTS) {
    const rawValue = data[field];
    if (rawValue == null) continue;
    readings.push({
      pointMetadata: metadata,
      rawValue,
      measurementTime,
      dataQuality: "good",
      error: null,
    });
  }
  return readings;
}

/**
 * ENERGY points, fed from the daily statistics endpoint's 5-minute `itemList` (NOT the live poll).
 *
 * The `itemList` carries cumulative-since-local-midnight kWh counters; the statistics collector
 * (`statistics.ts`) differences consecutive samples into per-interval energy (Wh) and writes them as
 * 5m-native aggregates. So these are `metricType:"energy", transform:null` (interval energy, summed —
 * the Enphase `enwh` model), NOT `transform:"d"` counters — the collector has already differenced and
 * tail-reconciled, sidestepping the midnight reset. Stems mirror Selectronic's energy points so the
 * energy-mode chart globs in `lib/charts/lines-data.ts` (solar / load / grid `energy.delta`) resolve.
 *
 * `counterField` is the cumulative-counter key in each `itemList` row / the daily-total key.
 */
export type SigenergyEnergyCounterField =
  | "powerGeneration"
  | "powerUse"
  | "powerToGrid"
  | "powerFromGrid"
  | "esCharging"
  | "esDischarging";

export interface SigenergyEnergyPointConfig {
  counterField: SigenergyEnergyCounterField;
  metadata: PointMetadata;
}

const energyMeta = (
  physicalPathTail: string,
  logicalPathStem: string,
  defaultName: string,
  subsystem: string,
): PointMetadata => ({
  physicalPathTail,
  logicalPathStem,
  defaultName,
  subsystem,
  metricType: "energy",
  metricUnit: "Wh",
  transform: null,
});

export const SIGENERGY_ENERGY_POINTS: SigenergyEnergyPointConfig[] = [
  {
    counterField: "powerGeneration",
    metadata: energyMeta("solar_interval_wh", "source.solar", "Solar", "solar"),
  },
  {
    counterField: "powerUse",
    metadata: energyMeta("load_interval_wh", "load", "Load", "load"),
  },
  {
    counterField: "powerFromGrid",
    metadata: energyMeta(
      "grid_import_interval_wh",
      "bidi.grid.import",
      "Import",
      "grid",
    ),
  },
  {
    counterField: "powerToGrid",
    metadata: energyMeta(
      "grid_export_interval_wh",
      "bidi.grid.export",
      "Export",
      "grid",
    ),
  },
  {
    counterField: "esCharging",
    metadata: energyMeta(
      "battery_charge_interval_wh",
      "bidi.battery.charge",
      "Battery Charge",
      "battery",
    ),
  },
  {
    counterField: "esDischarging",
    metadata: energyMeta(
      "battery_discharge_interval_wh",
      "bidi.battery.discharge",
      "Battery Discharge",
      "battery",
    ),
  },
];
