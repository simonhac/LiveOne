/**
 * Background spool drainer.
 *
 * `spool.drain` used to have exactly one caller — inside the poll loop, gated on `result.pushOk`.
 * That couples recovery of the ALREADY-COLLECTED backlog to the health of the loop that collects.
 * On 2026-09-11 the consequence was concrete: musher's loop wedged, so nothing ever called drain,
 * and 46 batches sat frozen on disk for 4 h 49 m even after the receiver came back. Kinkora's loop
 * was alive, so it drained itself — the asymmetry is entirely down to who was holding the trigger.
 *
 * A timer outside the loop closes that: a dead loop now costs live readings only, not the data
 * already safely on disk. The in-loop trigger stays, because it is the fast path — it fires the
 * instant the receiver acks rather than up to a minute later.
 *
 * Safe to run alongside it: Spool.drain holds a per-site re-entrancy guard and a concurrent call
 * for the same site returns immediately with `sent: 0`, so the two triggers cannot double-send.
 */

import { withTimeout } from "../lib/async";
import type { ScheduledEntry } from "./run";

const DRAIN_INTERVAL_MS = 60_000;
const DRAIN_TIMEOUT_MS = 60_000;

export interface DrainerOptions {
  intervalMs?: number;
  log?: (m: string) => void;
}

/** Drain every entry with a non-empty spool, once. Exported for tests; the timer calls it. */
export async function drainOnce(
  entries: ScheduledEntry[],
  log: (m: string) => void,
): Promise<void> {
  for (const entry of entries) {
    const spool = entry.spool;
    if (!spool) continue;
    // statsSync is a cached read, so the common case (nothing spooled) costs nothing.
    if (spool.statsSync().files === 0) continue;
    try {
      const r = await withTimeout(
        spool.drain(entry.source.siteId, (b) =>
          entry.pusher.store(b.readings, {
            sessionLabel: b.sessionLabel,
            measurementTime: b.measurementTime,
          }),
        ),
        DRAIN_TIMEOUT_MS,
        `background drain exceeded ${DRAIN_TIMEOUT_MS}ms`,
      );
      if (r.sent > 0 || r.dropped > 0) {
        log(
          `[${entry.source.siteId}] background drain: sent ${r.sent}, dropped ${r.dropped}, ${r.remaining} remaining`,
        );
      }
    } catch (e) {
      // Draining is best-effort by nature: the batches stay on disk and we try again next minute.
      log(
        `[${entry.source.siteId}] background drain failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export function startDrainer(
  entries: ScheduledEntry[],
  opts: DrainerOptions = {},
): { stop: () => void } {
  const log = opts.log ?? (() => {});
  const timer = setInterval(() => {
    void drainOnce(entries, log);
  }, opts.intervalMs ?? DRAIN_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
