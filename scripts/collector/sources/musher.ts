/**
 * musher — the Modbus source (DeepSea DSE7410 → gusher).
 *
 * As small as it gets: a static point manifest + a read() that reuses the proven `dse-client`.
 * Everything else (build reading set, push with retry, schedule) lives in ../core.
 */

import { DseClient } from "../../deepsea/dse-client";
import type { Manifest, Source, Values } from "../core/source";

/**
 * The curated set musher pushes to gusher — the live-proven Page-4 engine points. `key` matches a
 * `RegField.key` from dse-client's REGISTERS. The full register map is read (readAll) for diagnostics
 * (see scripts/deepsea/poll.ts) but only the manifest fields are pushed; extend this list to push more.
 */
export const DEEPSEA_MANIFEST: Manifest = [
  {
    key: "oilPressureKpa",
    physicalPathTail: "oil_pressure_kpa",
    logicalPathStem: "source.generator.oil",
    metricType: "pressure",
    metricUnit: "kPa",
    defaultName: "Oil Pressure",
    subsystem: "generator",
  },
  {
    key: "coolantTempC",
    physicalPathTail: "coolant_temp_c",
    logicalPathStem: "source.generator.coolant",
    metricType: "temperature",
    metricUnit: "°C",
    defaultName: "Coolant Temp",
    subsystem: "generator",
  },
  {
    key: "oilTempC",
    physicalPathTail: "oil_temp_c",
    logicalPathStem: "source.generator.oil",
    metricType: "temperature",
    metricUnit: "°C",
    defaultName: "Oil Temp",
    subsystem: "generator",
  },
  {
    key: "fuelLevelPct",
    physicalPathTail: "fuel_level_pct",
    logicalPathStem: "source.generator.fuel",
    metricType: "level",
    metricUnit: "%",
    defaultName: "Fuel Level",
    subsystem: "generator",
  },
  {
    key: "chargeAltV",
    physicalPathTail: "charge_alt_v",
    logicalPathStem: "source.generator.charge_alt",
    metricType: "voltage",
    metricUnit: "V",
    defaultName: "Charge Alternator",
    subsystem: "generator",
  },
  {
    key: "batteryV",
    physicalPathTail: "battery_v",
    logicalPathStem: "source.generator.battery",
    metricType: "voltage",
    metricUnit: "V",
    defaultName: "Battery Voltage",
    subsystem: "generator",
  },
  {
    key: "engineRpm",
    physicalPathTail: "engine_rpm",
    logicalPathStem: "source.generator.engine",
    metricType: "speed",
    metricUnit: "rpm",
    defaultName: "Engine Speed",
    subsystem: "generator",
  },
  {
    key: "genFreqHz",
    physicalPathTail: "gen_freq_hz",
    logicalPathStem: "source.generator.output",
    metricType: "frequency",
    metricUnit: "Hz",
    defaultName: "Generator Frequency",
    subsystem: "generator",
  },
];

export interface MusherOptions {
  siteId: string;
  host?: string;
  port?: number;
  unitId?: number;
  log?: (m: string) => void;
}

export function createMusher(opts: MusherOptions): Source {
  const dse = new DseClient({
    host: opts.host,
    port: opts.port,
    unitId: opts.unitId,
    log: opts.log,
  });
  return {
    name: "musher",
    siteId: opts.siteId,
    manifest: DEEPSEA_MANIFEST,
    async read(): Promise<Values> {
      try {
        // readAll() returns the whole mapped set; buildReadings pushes only the manifest fields.
        const dump = await dse.readAll();
        const values: Values = {};
        for (const r of dump.readings) values[r.field.key] = r.value;
        return values;
      } finally {
        // Reconnect fresh every tick. A persistent Modbus/TCP connection left idle across the poll
        // interval (5 min) is silently dropped by the DSE / NAT / stateful firewall, and
        // modbus-serial's read timeout does NOT fire on the dead socket → the next read hangs
        // forever. Closing after each read makes every tick reconnect (connect() is timeout-bounded),
        // sidestepping the stale socket. (The run loop's per-tick timeout + reset is the backstop.)
        await dse.close().catch(() => {});
      }
    },
    // Running when the engine is turning / producing — drives the loop's faster (1-min) cadence.
    isRunning(values: Values): boolean {
      return (
        Number(values.engineRpm ?? 0) > 0 || Number(values.genFreqHz ?? 0) > 0
      );
    },
    // Drop the socket after a failed/timed-out tick so the next read reconnects (the DSE client
    // otherwise reuses a `connected=true` handle whose socket may have silently died).
    async reset(): Promise<void> {
      await dse.close().catch(() => {});
    },
  };
}
