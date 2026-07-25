/**
 * musher — the Modbus source (DeepSea DSE7410 → gusher).
 *
 * As small as it gets: a static point manifest + a read() that reuses the proven `dse-client`.
 * Everything else (build reading set, push with retry, schedule) lives in ../core.
 */

import path from "node:path";
import { DseClient, sentinelReason } from "../clients/dse-client";
import type { DumpResult } from "../clients/dse-client";
import type { Manifest, Source, Values } from "../core/source";
import { DiagJournal } from "../core/diag-journal";

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
  /** store root for the diagnostic journal (MUSHER_DIAGNOSTICS mode); no journal if omitted */
  dataDir?: string;
}

export function createMusher(opts: MusherOptions): Source {
  const dse = new DseClient({
    host: opts.host,
    port: opts.port,
    unitId: opts.unitId,
    log: opts.log,
  });
  // Retain the last read for the inspector (the generic all-values table).
  let lastValues: Values | null = null;
  let lastReadAt: string | null = null;

  // ── Diagnostics (temporary, env-gated) ──────────────────────────────────────
  // MUSHER_DIAGNOSTICS=1 durably captures the FULL register dump (all ~94 regs: raw words + decoded
  // value + sentinel reason) while the genset is running AND for the next MUSHER_DIAG_POSTRUN_TICKS
  // polls (a fine-resolution cool-down baseline). In diag mode isRunning() reports the whole window,
  // so the loop holds its fast (1-min) cadence across the post-run tail, then reverts to idle.
  const DIAG = process.env.MUSHER_DIAGNOSTICS === "1";
  const POSTRUN = Math.max(
    0,
    Number(process.env.MUSHER_DIAG_POSTRUN_TICKS) || 6,
  );
  const log = opts.log ?? (() => {});
  let holdRemaining = 0;
  let lastActive = false;
  // Kick off the durable journal (async); appends are fire-and-forget so a slow disk never delays a
  // tick's push. Missing the first tick or two before it resolves is fine — a run isn't imminent then.
  let journal: DiagJournal | null = null;
  if (DIAG && opts.dataDir) {
    void DiagJournal.create(path.join(opts.dataDir, "diag"), { log }).then(
      (j) => {
        journal = j;
      },
    );
  }

  /** Build the full-dump record, log a greppable live-tail line, and durably journal it. */
  function emitDiag(dump: DumpResult, running: boolean, hold: number): void {
    const fields: Record<string, unknown> = {};
    for (const r of dump.readings) {
      const e: Record<string, unknown> = {
        v: r.value,
        raw: r.rawWords,
        i: r.rawInt,
      };
      // value null + a raw code present = the device answered with a sentinel → say WHY.
      if (r.value == null && r.rawWords.length > 0) {
        const na = sentinelReason(r.field, r.rawInt);
        if (na) e.na = na;
      }
      if (r.error) e.e = r.error; // value null + no raw words = a read error (≠ a sentinel)
      fields[r.field.key] = e;
    }
    const record = {
      t: new Date().toISOString(),
      site: opts.siteId,
      unit: dump.unitId,
      running,
      hold,
      fields,
      pageErrors: dump.pageErrors,
    };
    log(`[musher-diag] ${JSON.stringify(record)}`); // secondary: ephemeral live-tail
    void journal?.append(record); // primary: durable /data/usher/diag/*.jsonl
  }

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
        lastValues = values;
        lastReadAt = new Date().toISOString();

        if (DIAG) {
          // Diagnostic window = running OR within POSTRUN polls of the run ending. Evaluated once per
          // tick (read() runs once per tick, before isRunning) so the post-run counter is exact.
          const running =
            Number(values.engineRpm ?? 0) > 0 ||
            Number(values.genFreqHz ?? 0) > 0;
          let inWindow: boolean;
          if (running) {
            holdRemaining = POSTRUN;
            inWindow = true;
          } else if (holdRemaining > 0) {
            inWindow = true;
            holdRemaining--; // consume one post-run slot
          } else {
            inWindow = false;
          }
          lastActive = inWindow;
          if (inWindow) emitDiag(dump, running, holdRemaining);
        }
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
    // Running when the engine is turning / producing — drives the loop's faster (1-min) cadence. In
    // diag mode this reports the whole capture window (run + post-run hold) so the fast cadence — and
    // thus the 1-min cool-down dump — extends across the post-run tail before reverting to idle.
    isRunning(values: Values): boolean {
      if (DIAG) return lastActive;
      return (
        Number(values.engineRpm ?? 0) > 0 || Number(values.genFreqHz ?? 0) > 0
      );
    },
    // Drop the socket after a failed/timed-out tick so the next read reconnects (the DSE client
    // otherwise reuses a `connected=true` handle whose socket may have silently died).
    async reset(): Promise<void> {
      await dse.close().catch(() => {});
    },
    // Live detail for the inspector — the last full register read (all mapped fields).
    snapshot() {
      return { values: lastValues, at: lastReadAt };
    },
  };
}
