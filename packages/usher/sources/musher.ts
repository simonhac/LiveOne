import { captureTrial } from "../core/trial-capture";
/**
 * musher — the Modbus source (DeepSea DSE7410 → gusher).
 *
 * As small as it gets: a static point manifest + a read() that reuses the proven `dse-client`.
 * Everything else (build reading set, push with retry, schedule) lives in ../core.
 */

import path from "node:path";
import {
  CONTROL_MODE,
  DseClient,
  ENGINE_STATE,
  SCF,
  scfSupports,
  sentinelReason,
} from "../clients/dse-client";
import type { DumpResult } from "../clients/dse-client";
import type {
  ControlOwnership,
  ControlPreflight,
  Manifest,
  Source,
  SourceControl,
  Values,
} from "../core/source";
import { DiagJournal } from "../core/diag-journal";
import { delay, withTimeout } from "../lib/async";

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

  // ── Digital I/O + mode, field-qualified by the Aug 2026 runs ─────────────
  // 🛑 EVERY point needs a UNIQUE (logicalPathStem, metricType) pair: LiveOne's `points` table has
  // a unique index on (device_id, logical_path, metric_type), and a collision fails the WHOLE
  // batch insert — the device silently stops delivering, not just the offending point. That is
  // why these five booleans each get their own stem instead of sharing a tidy-looking one.
  // Pinned by a test in core/__tests__/manifest-addressing.test.ts.
  // These are DERIVED keys (bits pulled out of digIn/digOutUnnamed1To16, enum text from 772) that
  // read() synthesises — they make run ownership visible in LiveOne, not just in a control 409:
  // remote_start_input is the SP-PRO's demand on input A; the relays are the DSE's OWN actions
  // (and the §6a re-crank evidence); control_mode catches someone putting the panel in Stop.
  {
    key: "remoteStartInput",
    physicalPathTail: "remote_start_input",
    logicalPathStem: "source.generator.remote_start",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Remote Start Input",
    subsystem: "generator",
  },
  {
    key: "fuelRelay",
    physicalPathTail: "fuel_relay",
    logicalPathStem: "source.generator.fuel_relay",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Fuel Relay",
    subsystem: "generator",
  },
  {
    key: "crankRelay",
    physicalPathTail: "crank_relay",
    logicalPathStem: "source.generator.crank_relay",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "Crank Relay",
    subsystem: "generator",
  },
  {
    key: "atSpeed",
    physicalPathTail: "at_speed",
    logicalPathStem: "source.generator.at_speed",
    metricType: "state",
    metricUnit: "bool",
    defaultName: "At Speed",
    subsystem: "generator",
  },
  {
    key: "controlModeName",
    physicalPathTail: "control_mode",
    logicalPathStem: "source.generator.mode",
    metricType: "state",
    metricUnit: "text",
    defaultName: "Control Mode",
    subsystem: "generator",
  },
];

/**
 * Pull the derived manifest keys out of a raw register read. Bit conventions per dse-client's
 * field notes: unnamed digital in/out words are 1 bit per channel with CHANNEL 1 AT THE MSB
 * (bit 15). Input A ≡ input 1 = the SP-PRO's start command (terminal 51). Output assignments
 * observed live 2026-08-12: out1 = fuel relay, out4 = at-speed/loading, out5 = crank (one pulse).
 */
export function deriveDigitalValues(values: Values): void {
  const digIn = values.digInUnnamed1To16;
  values.remoteStartInput =
    typeof digIn === "number" ? (digIn >> 15) & 1 : null;
  const digOut = values.digOutUnnamed1To16;
  if (typeof digOut === "number") {
    values.fuelRelay = (digOut >> 15) & 1; // out1
    values.atSpeed = (digOut >> 12) & 1; // out4
    values.crankRelay = (digOut >> 11) & 1; // out5
  } else {
    values.fuelRelay = null;
    values.atSpeed = null;
    values.crankRelay = null;
  }
  const mode = values.controlMode;
  values.controlModeName =
    typeof mode === "number" ? (CONTROL_MODE[mode] ?? String(mode)) : null;
}

export interface MusherOptions {
  siteId: string;
  host?: string;
  port?: number;
  unitId?: number;
  log?: (m: string) => void;
  /** store root for the diagnostic journal (MUSHER_DIAGNOSTICS mode); no journal if omitted */
  dataDir?: string;
  /** attach the write surface (Source.control); set only when usher.yaml carries a control block */
  enableControl?: boolean;
}

/** Lock-HOLD budgets: how long an op may keep the device once it has the lock. */
const READ_LOCK_MS = 28_000; // readAll's worst case (~68 per-field fallbacks over ~300ms RTT), just under the run loop's 30 s tick cap
const CONTROL_LOCK_MS = 12_000; // connect (5 s cap) + a handful of round trips
const RESET_LOCK_MS = 5_000;
/** Bound on the post-failure socket close inside the lock (DseClient.close is itself bounded). */
const CLOSE_LOCK_MS = 3_000;

/**
 * Lock-QUEUE budgets: how long an op will wait for its TURN. Timed from enqueue, so an op stuck
 * behind a slow predecessor is still bounded.
 */
const READ_QUEUE_MS = 5_000; // a poll that can't get the lock in 5 s is worthless — the next is 15 s away
const CONTROL_QUEUE_MS = READ_LOCK_MS + CLOSE_LOCK_MS + 2_000; // ~33 s: long enough to sit out one worst-case read
const RESET_QUEUE_MS = 2_000; // it sits on the run loop's error path — must not hold the tick

export function createMusher(opts: MusherOptions): Source {
  const dse = new DseClient({
    host: opts.host,
    port: opts.port,
    unitId: opts.unitId,
    log: opts.log,
  });
  // Retain the last read for the inspector (the generic all-values table).
  let lastValues: Values | null = null;
  let lastRaw: Record<string, number[]> = {};
  let lastReadAt: string | null = null;

  // ── the device mutex ────────────────────────────────────────────────────────
  // One Modbus target, two callers: the poll loop's read() and the control layer's writes. They
  // are serialised through this promise chain so a command can never interleave with a poll on the
  // same socket. CRITICAL PROPERTY: the chain must always advance. A read on a silently-dead
  // socket hangs FOREVER (modbus-serial's timeout doesn't fire), and a naive chain would then hold
  // the deadline STOP behind it indefinitely — a runaway engine.
  //
  // That property was asserted here but not actually upheld, and on 2026-09-11 the chain wedged
  // for 4 h 49 m. Three things were missing, all now fixed below:
  //   1. the recovery close() was unbounded — the one await that could (and did) never settle;
  //   2. `chain` was the op's own promise, so a never-settling op wedged every future caller;
  //   3. an op's timer started when its turn arrived, so a QUEUED op had no bound at all.
  // Each op therefore now has two budgets: `ms` to hold the device, `queueMs` to wait for it.
  let chain: Promise<unknown> = Promise.resolve();
  function withLock<T>(
    label: string,
    ms: number,
    queueMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Starts NOW, at enqueue — not when our turn arrives.
    let cancelled = false;
    let queueTimer: ReturnType<typeof setTimeout>;
    const queued = new Promise<never>((_, reject) => {
      queueTimer = setTimeout(() => {
        cancelled = true;
        reject(new Error(`${label} waited ${queueMs}ms for the device lock`));
      }, queueMs);
    });

    const run: Promise<T> = chain.then(async () => {
      // Our caller gave up while we sat in the queue — a late turn must not touch the device.
      if (cancelled)
        throw new Error(`${label} abandoned after ${queueMs}ms in the queue`);
      // Our turn arrived: stop the queue clock. From here `ms` is the only bound that applies —
      // queueMs must not also cap how long we may HOLD the device (a poll read waits 5 s for its
      // turn but is allowed 28 s once it has it).
      clearTimeout(queueTimer!);
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms}ms (hung Modbus op)`)),
          ms,
        );
      });
      const op = fn();
      op.catch(() => {}); // a post-timeout settlement must not become an unhandled rejection
      try {
        return await Promise.race([op, timeout]);
      } catch (e) {
        // Dead/suspect socket: force a reconnect next op. BOUNDED — an unbounded close() here is
        // precisely what wedged the chain. DseClient.close() is bounded too; this does not trust it.
        await withTimeout(
          dse.close(),
          CLOSE_LOCK_MS,
          `${label} close exceeded ${CLOSE_LOCK_MS}ms`,
        ).catch(() => {});
        throw e;
      } finally {
        clearTimeout(timer!);
      }
    });

    // The chain advances on a hard bound whatever the op does — including code added here later.
    // This is the invariant, not an optimisation: without it one never-settling await anywhere
    // inside the callback silently blocks every future read, reset AND deadline stop.
    chain = Promise.race([
      run.catch(() => {}),
      delay(ms + CLOSE_LOCK_MS + 1_000, { unref: true }),
    ]);

    return Promise.race([run, queued]).finally(() => clearTimeout(queueTimer!));
  }

  // ── Diagnostics (temporary, env-gated) ──────────────────────────────────────
  // MUSHER_DIAGNOSTICS=1 durably captures the FULL register dump (all ~94 regs: raw words + decoded
  // value + sentinel reason) on EVERY poll — idle included.
  //
  // MUSHER_DIAG_POSTRUN_SECONDS does not gate capture; it keeps the source reporting "active" for
  // that long after a run ends, holding the fast cadence to give a fine-resolution cool-down
  // baseline. It is a DURATION (it replaced MUSHER_DIAG_POSTRUN_TICKS, a tick count) precisely
  // because ticks are not one: changing the poll cadence silently rescaled the tail — at 60 s polls
  // 60 ticks meant an hour, and the move to 15 s quietly cut it to fifteen minutes.
  const DIAG = process.env.MUSHER_DIAGNOSTICS === "1";
  const POSTRUN_MS =
    Math.max(0, Number(process.env.MUSHER_DIAG_POSTRUN_SECONDS) || 3600) * 1000;
  const log = opts.log ?? (() => {});
  /** epoch ms until which a just-ended run keeps the source "active" (0 = not holding) */
  let holdUntil = 0;
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

  async function readInner(): Promise<Values> {
    try {
      // readAll() returns the whole mapped set; buildReadings pushes only the manifest fields.
      const dump = await dse.readAll();
      lastRaw = Object.fromEntries(
        dump.readings.map((r) => [r.field.key, r.rawWords]),
      );
      const values: Values = {};
      for (const r of dump.readings) values[r.field.key] = r.value;
      deriveDigitalValues(values); // remote_start_input, relays, control_mode text
      lastValues = values;
      lastReadAt = new Date().toISOString();

      if (DIAG) {
        // EVERY tick is journalled, idle included. The run/post-run window no longer gates capture,
        // only CADENCE: it is what isRunning() reports, so the loop samples at 1 min across a run
        // and its cool-down tail, and at the 5-min idle rate otherwise.
        //
        // Capturing idle ticks is the whole point. The previous running-gated capture could never
        // show WHY a start happened, because its first record was already running — a start is only
        // explicable from the state that PRECEDED it (control mode, status flags, start counter).
        // Evaluated once per tick (read() runs once per tick, before isRunning) so the post-run
        // counter stays exact.
        const running =
          Number(values.engineRpm ?? 0) > 0 ||
          Number(values.genFreqHz ?? 0) > 0;
        const nowMs = Date.now();
        if (running) {
          holdUntil = nowMs + POSTRUN_MS; // restart the tail on every running poll
          lastActive = true;
        } else if (nowMs < holdUntil) {
          lastActive = true; // still inside the cool-down tail
        } else {
          lastActive = false;
          holdUntil = 0;
        }
        // `hold` in the record is now SECONDS remaining, not ticks remaining.
        emitDiag(
          dump,
          running,
          Math.max(0, Math.ceil((holdUntil - nowMs) / 1000)),
        );
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
  }

  /**
   * The write surface (Source.control), built only when usher.yaml opts this device in. All ops go
   * through the same mutex as read() and follow its connect-per-op / close-in-finally discipline.
   *
   * start() verifies the SCF support map first (a start against an unsupported function must fail
   * loudly, not silently no-op). stop() deliberately does NOT re-verify: fn 33 was proven live
   * 2026-08-29, and adding a read dependency to the STOP path would be a new way for a stop to fail.
   */
  function makeControl(): SourceControl {
    return {
      start(): Promise<void> {
        return withLock(
          "control start",
          CONTROL_LOCK_MS,
          CONTROL_QUEUE_MS,
          async () => {
            try {
              await dse.writeControlKey(SCF.TELEMETRY_START, {
                verifySupport: true,
              });
            } finally {
              await dse.close().catch(() => {});
            }
          },
        );
      },
      stop(): Promise<void> {
        return withLock(
          "control stop",
          CONTROL_LOCK_MS,
          CONTROL_QUEUE_MS,
          async () => {
            try {
              await dse.writeControlKey(SCF.TELEMETRY_CANCEL, {
                verifySupport: false,
              });
            } finally {
              await dse.close().catch(() => {});
            }
          },
        );
      },
      readOwnership(): Promise<ControlOwnership> {
        return withLock(
          "control ownership read",
          CONTROL_LOCK_MS,
          CONTROL_QUEUE_MS,
          async () => {
            try {
              return await ownershipInner();
            } finally {
              await dse.close().catch(() => {});
            }
          },
        );
      },
      // FC3 ONLY. This function cannot reach writeControlKey, by construction.
      preflight(): Promise<ControlPreflight> {
        return withLock(
          "control preflight",
          CONTROL_LOCK_MS,
          CONTROL_QUEUE_MS,
          async () => {
            try {
              const ownership = await ownershipInner();
              const scfMap = await dse.readScfSupport();
              return {
                ownership,
                scfMap,
                scfSupported: {
                  selectAuto: scfSupports(scfMap, SCF.SELECT_AUTO),
                  telemetryStart: scfSupports(scfMap, SCF.TELEMETRY_START),
                  telemetryCancel: scfSupports(scfMap, SCF.TELEMETRY_CANCEL),
                },
              };
            } finally {
              await dse.close().catch(() => {});
            }
          },
        );
      },
    };
  }

  /** Is the engine turning / producing right now? The one definition, used by both cadences. */
  function engineTurning(values: Values): boolean {
    return (
      Number(values.engineRpm ?? 0) > 0 || Number(values.genFreqHz ?? 0) > 0
    );
  }

  /** The ownership reads themselves — callers hold the lock and own the close(). */
  async function ownershipInner(): Promise<ControlOwnership> {
    // 🛑 `engineState` rides along as a HINT, not a gate — see ControlOwnership. It is the DSE's
    // own word for what the engine is doing ("Cooling down"), which is the only way to tell a
    // cool-down tail from a run nobody here commanded. It is NOT in DEEPSEA_MANIFEST (not yet
    // field-qualified), so it is read for decisions and never published as a point; a sentinel or
    // an absent value degrades to exactly the behaviour that existed before it was read.
    const f = await dse.readFields([
      "controlMode",
      "digInUnnamed1To16",
      "engineRpm",
      "genFreqHz",
      "engineState",
    ]);
    const mode = f.controlMode;
    const digIn = f.digInUnnamed1To16;
    const engineState = f.engineState;
    return {
      mode,
      modeName: mode != null ? (CONTROL_MODE[mode] ?? String(mode)) : null,
      remoteStartInput:
        digIn == null ? "unknown" : (digIn >> 15) & 1 ? "closed" : "open",
      running: (f.engineRpm ?? 0) > 0 || (f.genFreqHz ?? 0) > 0,
      engineState,
      engineStateName:
        engineState != null ? (ENGINE_STATE[engineState] ?? null) : null,
    };
  }

  return {
    name: "musher",
    siteId: opts.siteId,
    manifest: DEEPSEA_MANIFEST,
    read(): Promise<Values> {
      return withLock("poll read", READ_LOCK_MS, READ_QUEUE_MS, () =>
        readInner(),
      );
    },
    // Running when the engine is turning / producing — drives the loop's faster (1-min) cadence. In
    // diag mode this reports run + post-run hold, so the fast cadence — and thus the 1-min
    // cool-down dump — extends across the post-run tail before reverting to the 5-min idle rate.
    // (Capture itself is unconditional in diag mode; this only sets the sampling rate.)
    isRunning(values: Values): boolean {
      if (DIAG) return lastActive;
      return engineTurning(values);
    },
    /**
     * What LiveOne's push cadence follows: the ENGINE, never the diagnostic hold.
     *
     * 🛑 The hold above (MUSHER_DIAG_POSTRUN_SECONDS, an hour by default) exists to keep the local
     * journal sampling finely through a cool-down. It was also reaching the push decision, so every
     * run was followed by an hour of active-rate deliveries to LiveOne — measured on prod, still
     * at the 1-minute cadence more than an hour after the engine stopped, for an engine reading a
     * flat zero the whole time. The extra resolution was always meant to stay on the Fly volume;
     * this is the line that keeps it there.
     */
    isDeliveryActive(values: Values): boolean {
      return engineTurning(values);
    },
    // Drop the socket after a failed/timed-out tick so the next read reconnects (the DSE client
    // otherwise reuses a `connected=true` handle whose socket may have silently died). Runs through
    // the mutex so it can never yank the socket out from under a control write in flight.
    async reset(): Promise<void> {
      await withLock("reset", RESET_LOCK_MS, RESET_QUEUE_MS, async () => {
        await dse.close().catch(() => {});
      }).catch(() => {});
    },
    control: opts.enableControl ? makeControl() : undefined,
    capture(at, expected) {
      captureTrial({
        source: "deepsea",
        pollerId: opts.siteId,
        vendorSiteId: opts.siteId,
        at,
        expectedAt: at,
        raw: lastRaw,
        harvest: true,
        expected,
      });
    },
    // Live detail for the inspector — the last full register read (all mapped fields).
    snapshot() {
      return { values: lastValues, at: lastReadAt };
    },
  };
}
