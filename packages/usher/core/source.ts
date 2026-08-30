/**
 * Collector core — the Source contract.
 *
 * A "source" is a device reader kept as small as possible: a **manifest** (its points' metadata) plus
 * a **read()** that returns named values. Everything else (assemble self-describing readings, stamp
 * time+sequence, POST to gusher with retry/backoff, scheduling, heartbeat) is shared in core/.
 */

import type { PushReading } from "@liveone/protocol";

/** Metadata for one point a source produces (a PushReading without value/time, plus the values key). */
export interface PointDef {
  /** matches a key in the object returned by Source.read() */
  key: string;
  physicalPathTail: string;
  metricType: string;
  metricUnit: string;
  logicalPathStem?: string | null;
  defaultName?: string;
  subsystem?: string | null;
  transform?: string | null;
}

export type Manifest = PointDef[];

/** The named values a source reads at each tick. `null` = sensor n/a → dropped by buildReadings. */
export type Values = Record<string, number | string | null>;

/**
 * Fresh-at-command-time device state for a control decision. Never served from a cached poll —
 * a start/stop decision must not ride on values up to a poll period old.
 */
export interface ControlOwnership {
  /** control/operating mode (reg 772): 0 Stop, 1 Auto, 2 Manual…; null = read n/a */
  mode: number | null;
  modeName: string | null;
  /** the SP-PRO's remote-start command — configurable digital input A (reg 3089 bit 15) */
  remoteStartInput: "closed" | "open" | "unknown";
  /** engine turning / producing (rpm or frequency nonzero) */
  running: boolean;
  /**
   * The DSE's OWN engine operating state (page 5 offset 128 / reg 1408) — 4 = Cooling down,
   * 6 = Post-run, 3 = Running, 2 = Warming up. The controller's own word for what the engine is
   * doing, which is the only source that can distinguish a cool-down tail from a fresh run nobody
   * here commanded.
   *
   * 🛑 Nullable and treated as a HINT, never a gate. The register is not yet field-qualified (it is
   * deliberately absent from DEEPSEA_MANIFEST for that reason), so an unreadable value, a sentinel,
   * or a module that does not populate it must degrade to the behaviour that existed before it —
   * never to a refusal or an acceptance that depends on it.
   */
  engineState: number | null;
  engineStateName: string | null;
}

/** Result of a READ-ONLY control pre-flight — what a run would see before deciding. */
export interface ControlPreflight {
  ownership: ControlOwnership;
  /** which System Control Functions this module advertises (SCF map 4096–4103) */
  scfSupported: {
    selectAuto: boolean;
    telemetryStart: boolean;
    telemetryCancel: boolean;
  };
  /** raw SCF map words, for the record */
  scfMap: number[];
}

/**
 * Optional write surface for a device that can be commanded (musher only). All ops are serialised
 * with `read()` behind the source's internal mutex, and each is internally timeout-bounded so a
 * hung socket can never wedge the stop path (see sources/musher.ts).
 */
export interface SourceControl {
  /** assert the telemetry-start latch (fn 32). The engine runs until stop() clears it. */
  start(): Promise<void>;
  /** clear the telemetry-start latch (fn 33). Harmless when not latched. */
  stop(): Promise<void>;
  /** fresh pre-flight reads: mode, remote-start input, running */
  readOwnership(): Promise<ControlOwnership>;
  /**
   * READ-ONLY (FC3 only): everything a start decision consults — ownership + the SCF support map.
   * Backs the `probe` command, which exercises the whole chain (Access → passkey → registry →
   * supervisor → mutex → Modbus over WireGuard → the DSE) while being structurally incapable of
   * moving the engine.
   */
  preflight(): Promise<ControlPreflight>;
}

/** A device source. Tiny by design: name + siteId + manifest + read(). */
export interface Source {
  /** short label for logs/sessions, e.g. "musher" */
  name: string;
  /** gusher vendorSiteId (identifies the LiveOne device) */
  siteId: string;
  manifest: Manifest;
  read(): Promise<Values>;
  /**
   * Optional: is the device "active" (e.g. a generator that's running)? Drives the run loop's
   * faster cadence. Given the just-read values; return false when unknown.
   */
  isRunning?(values: Values): boolean;
  /**
   * Optional: is the device active for DELIVERY purposes? Defaults to `isRunning`.
   *
   * 🛑 The two are the same question for every source but musher, and musher is why the seam
   * exists. Its `isRunning` deliberately stays true for a diagnostic post-run hold (an hour by
   * default) so the local journal samples the cool-down finely — but that hold was also driving the
   * PUSH cadence, so LiveOne kept receiving active-rate deliveries for an hour after every run,
   * long after the engine had stopped and there was nothing left to see. Local resolution and what
   * we send upstream are different decisions; a source that wants them to differ says so here.
   */
  isDeliveryActive?(values: Values): boolean;
  /**
   * Optional: drop any cached connection so the next read() reconnects. Called by the run loop after
   * a failed/timed-out tick so a silently-dead socket can't keep hanging future reads.
   */
  reset?(): Promise<void> | void;
  /**
   * Optional: a live snapshot for the inspector dashboard — source-specific detail beyond the last
   * pushed values (e.g. the fusher site's 2 s power flow + minutely history + per-inverter state).
   * Read by the SSE route independently of the run-loop's push cadence. Not used by the run loop.
   */
  snapshot?(): unknown;
  /**
   * Optional: the device's write surface (remote start/stop). Present only when the source config
   * carries a `control` block; used exclusively by core/control.ts's RunSupervisor.
   */
  control?: SourceControl;
}

export type { PushReading };
