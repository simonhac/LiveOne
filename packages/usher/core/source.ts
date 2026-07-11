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

/** A device source. Tiny by design: name + siteId + manifest + read(). */
export interface Source {
  /** short label for logs/sessions, e.g. "musher" */
  name: string;
  /** gusher vendorSiteId (identifies the LiveOne system) */
  siteId: string;
  manifest: Manifest;
  read(): Promise<Values>;
  /**
   * Optional: is the device "active" (e.g. a generator that's running)? Drives the run loop's
   * faster cadence. Given the just-read values; return false when unknown.
   */
  isRunning?(values: Values): boolean;
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
}

export type { PushReading };
