/**
 * Per-site delivery courier — the push, moved off the poll loop's critical path.
 *
 * The push used to be awaited inside the tick. `Pusher.store` is bounded, but its bound is ~74 s
 * (4 attempts x 15 s + 14 s of backoff), and the loop then sleeps `max(0, period - elapsed)`. So
 * whenever a push overran the poll period, the next poll simply did not happen: gusher's
 * availability silently controlled how fast we sampled the device.
 *
 * That is not hypothetical. Through the ~4 h receiver outage of 2026-09-11, sheephouse recorded 895
 * reads where its 15 s cadence should have produced 958 — **~45 readings lost to failing pushes
 * alone**, entirely separately from the wedge that killed the collector later that morning. Every
 * one of those was a reading the device would happily have given us.
 *
 * So: the tick reads, journals, and hands the batch to a courier, which owns everything after that.
 * Collection now proceeds at the device's cadence no matter what the receiver is doing.
 *
 * The design is deliberately small:
 *   - ONE worker per site, so batches are delivered in the order they were collected.
 *   - A bounded queue. At capacity the incoming batch is spooled instead of queued — the spool is
 *     already the durable, ordered, disk-capped overflow, so there is no reason to invent a second
 *     one, and memory cannot grow without limit behind a dead receiver.
 *   - The worker owns spool recovery too: a successful push is the signal that the receiver is
 *     healthy, which is exactly when the backlog should go. That trigger used to live in the run
 *     loop, where a wedged loop could strand it (it did, for 4 h 49 m).
 *
 * Nothing here is awaited by the collector, and nothing here can throw into it.
 *
 * ⚠️ The known cost: in-memory batches do not survive a process exit. At most the in-flight batch
 * plus whatever is queued (normally nothing — the worker keeps up) is lost on a restart. The
 * blackbox still holds them, but they will not reach LiveOne. The inline push had the same exposure
 * for its in-flight batch; the queued ones are the new part. If that ever matters, spool the queue
 * on SIGTERM — do not put the push back on the tick path.
 */

import type { PushReading } from "@liveone/protocol";
import type { PushOutcome } from "./pusher";
import type { Spool } from "./spool";
import { withTimeout } from "../lib/async";

const DEFAULT_MAX_DEPTH = 20;
const SPOOL_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 60_000;

export interface DeliveryJob {
  siteId: string;
  sessionLabel: string;
  measurementTime: string;
  readings: PushReading[];
  /**
   * Whether this batch contains real device readings, as opposed to only the synthetic
   * control-plane points a read-error tick still emits. The heartbeat turns on this distinction —
   * see core/heartbeat.ts — so it has to survive the hand-off.
   */
  hasDeviceReadings: boolean;
}

export interface DeliveryResult {
  job: DeliveryJob;
  outcome: PushOutcome;
  /** whether a transient failure's batch was durably spooled (undefined when not attempted) */
  spooled?: boolean;
}

export interface CourierOptions {
  siteId: string;
  store: (
    readings: PushReading[],
    meta: { sessionLabel: string; measurementTime: string },
  ) => Promise<PushOutcome>;
  spool?: Spool | null;
  log?: (m: string) => void;
  onResult?: (r: DeliveryResult) => void;
  maxDepth?: number;
}

export interface Courier {
  /** Hand over a batch. Returns immediately — this is the whole point. */
  submit(job: DeliveryJob): void;
  /** queued, not counting the one in flight */
  depth(): number;
  /** Resolve once the queue has drained. For --once and tests; the collector never awaits it. */
  idle(): Promise<void>;
}

export function createCourier(opts: CourierOptions): Courier {
  const log = opts.log ?? (() => {});
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const queue: DeliveryJob[] = [];
  let working = false;
  let idleWaiters: Array<() => void> = [];

  function releaseIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Put a batch on disk. Never throws: a failed spool is reported, not propagated. */
  async function spoolJob(job: DeliveryJob): Promise<boolean> {
    if (!opts.spool) return false;
    try {
      return (
        (await withTimeout(
          Promise.resolve(
            opts.spool.enqueue({
              siteId: job.siteId,
              sessionLabel: job.sessionLabel,
              measurementTime: job.measurementTime,
              readings: job.readings,
              spooledAt: new Date().toISOString(),
            }),
          ),
          SPOOL_TIMEOUT_MS,
          `spool enqueue exceeded ${SPOOL_TIMEOUT_MS}ms`,
        )) ?? false
      );
    } catch (e) {
      log(
        `spool enqueue failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  /** The receiver just acked, so flush whatever the last outage left behind. */
  async function drainBacklog(): Promise<void> {
    const spool = opts.spool;
    if (!spool || spool.statsSync().files === 0) return;
    try {
      const r = await withTimeout(
        spool.drain(opts.siteId, (b) =>
          opts.store(b.readings, {
            sessionLabel: b.sessionLabel,
            measurementTime: b.measurementTime,
          }),
        ),
        DRAIN_TIMEOUT_MS,
        `spool drain exceeded ${DRAIN_TIMEOUT_MS}ms`,
      );
      if (r.sent > 0 || r.dropped > 0) {
        log(
          `drained ${r.sent} spooled batch(es), dropped ${r.dropped}, ${r.remaining} remaining`,
        );
      }
    } catch (e) {
      // The batches stay on disk; the background drainer will try again.
      log(`spool drain failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function work(): Promise<void> {
    working = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        let outcome: PushOutcome;
        try {
          outcome = await opts.store(job.readings, {
            sessionLabel: job.sessionLabel,
            measurementTime: job.measurementTime,
          });
        } catch (e) {
          // Pusher.store is written never to throw; if that ever changes, a delivery failure must
          // still not kill the worker, or the site silently stops delivering.
          log(`push threw: ${e instanceof Error ? e.message : String(e)}`);
          outcome = "transient";
        }

        let spooled: boolean | undefined;
        if (outcome === "transient") {
          spooled = await spoolJob(job);
          if (!spooled)
            log("push failed and the spool is unavailable — batch dropped");
        } else if (outcome === "ok") {
          await drainBacklog();
        }

        try {
          opts.onResult?.({ job, outcome, spooled });
        } catch {
          /* an observer must never break delivery */
        }
      }
    } catch (e) {
      // Belt and braces: the loop above is fully guarded, so reaching here means a bug. Log it and
      // let the next submit() start a fresh worker rather than wedging delivery forever.
      log(
        `courier worker crashed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      working = false;
      releaseIdle();
    }
  }

  return {
    submit(job) {
      if (queue.length >= maxDepth) {
        // Overflow straight to disk rather than growing in memory. Ordering is not perfectly
        // preserved across this boundary — the drain will send it after whatever is queued — but
        // the receiver is idempotent and keyed by measurement time, and a spool drain has always
        // been able to arrive after newer live pushes.
        log(
          `delivery queue full (${maxDepth}) — spooling batch ${job.sessionLabel} instead`,
        );
        void spoolJob(job);
        return;
      }
      queue.push(job);
      if (!working) void work();
    },
    depth() {
      return queue.length;
    },
    idle() {
      if (!working && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
