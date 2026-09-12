/**
 * APP-TIER metrics for the usher: the spool, and the volume it lives on.
 *
 * Deliberately NOT in runtime-metrics.ts. Everything here needs a handle on something this app
 * owns, and the moment runtime-metrics.ts needs a `Spool` it stops being portable to clara and
 * mrtippy — which is the one rule that keeps the shared dashboard shared. App-tier metrics do not
 * break fleet uniformity; they get their own chart below the uniform ones.
 *
 * 🛑 THESE ARE THE ONLY DATA-LOSS SIGNALS IN THE FLEET. Every other metric in this app describes
 * an observability gap: if it is wrong, you find out late. If `spool.drops` moves, readings that
 * were collected have been destroyed, and nothing else anywhere would have told you.
 *
 * Three failure shapes, three metrics:
 *
 *   spool.drops        the eviction in Spool.enforceCap — `while (bytes + incoming > maxBytes)`.
 *                      A counter, not a gauge: it is a discrete event that matters at the instant
 *                      it happens, and it records the REASON. Same shape as mrtippy's
 *                      process.memory.pressure_events.
 *   spool.oldest_age   a backlog that is not draining. Batches are deleted the moment a re-send is
 *                      acked, so in health this is either absent or seconds old. Hours old means
 *                      the receiver has been down that long and the eviction cap is approaching.
 *   disk.free_ratio    the upstream cause of every drop. The volume also holds the blackbox journal
 *                      and (while MUSHER_DIAGNOSTICS is on) ~52 MB/day of diag capture, so the
 *                      spool is not the only thing competing for it.
 */

import { diskSpace as defaultDiskSpace, type DiskSpaceFn } from "./disk";
import type { Spool } from "./spool";
import { getMeter } from "./telemetry";

/** Matches runtime-metrics.ts: resource attributes are not queryable in Better Stack, observation ones are. */
const ATTRS = { service: "liveone-usher" } as const;

export type SpoolDropReason = "disk_cap" | "rejected" | "unreadable";

export interface SpoolMetricsOptions {
  /** The filesystem to probe. The spool's own dir, so the probe follows a dataDir change. */
  dir: string;
  /**
   * Read lazily, because the gauges are registered BEFORE `Spool.create` runs — they have to be
   * able to report that the spool does not exist, and a value captured at registration time would
   * pin them to `null` forever. Returns null when the store could not be made writable.
   */
  getSpool: () => Spool | null;
  diskSpaceFn?: DiskSpaceFn;
}

/**
 * Register the spool gauges and return the drop hook to hand to `Spool.create`.
 *
 * The hook is returned rather than imported by spool.ts on purpose: spool.ts is unit-tested with
 * injected dependencies and has no business knowing telemetry exists.
 */
let registered: { onDrop: (reason: SpoolDropReason) => void } | null = null;

export function startSpoolMetrics(opts: SpoolMetricsOptions): {
  onDrop: (reason: SpoolDropReason) => void;
} {
  // `startUsher` can run more than once in a process (the CLI's --once, and the tests). Registering
  // the same instrument name twice on one meter is a duplicate-registration warning, not an error,
  // but the second set of callbacks would close over a stale getSpool and double every observation.
  if (registered) return registered;

  const meter = getMeter("spool");
  const space = opts.diskSpaceFn ?? defaultDiskSpace;
  const readSpool = opts.getSpool;

  const gauge = (
    name: string,
    description: string,
    unit: string,
    read: () => number | null,
  ) =>
    meter
      .createObservableGauge(name, { description, unit })
      .addCallback((obs) => {
        const v = read();
        if (v !== null) obs.observe(v, ATTRS);
      });

  /**
   * 1 when outage buffering is available, 0 when the data dir could not be made writable.
   *
   * Without this, `Spool.create` returning null looks exactly like a healthy empty spool: no files,
   * no bytes, no drops, no alert — while every transient push failure is silently discarded. That
   * is the same "absent looks identical to idle" trap as an unreported source.
   */
  gauge(
    "spool.available",
    "1 if the outage spool is writable, 0 if buffering is disabled",
    "1",
    () => (readSpool() ? 1 : 0),
  );

  // statsSync() is the cache refreshed by enqueue/drain. Between events it is stale by design —
  // which is correct here: with nothing enqueued and nothing drained, nothing has changed.
  gauge("spool.batches", "Undelivered batches on disk", "{batch}", () => {
    const spool = readSpool();
    return spool ? spool.statsSync().files : null;
  });
  gauge("spool.bytes", "Bytes of undelivered batches on disk", "By", () => {
    const spool = readSpool();
    return spool ? spool.statsSync().bytes : null;
  });
  gauge("spool.oldest_age", "Age of the oldest undelivered batch", "s", () => {
    const spool = readSpool();
    if (!spool) return null;
    const oldestAt = spool.statsSync().oldestAt;
    // Absent means an EMPTY spool, not a missing reading. Reporting 0 would be a lie of the
    // convenient kind — it is indistinguishable from a batch spooled this instant.
    if (!oldestAt) return null;
    const ms = Date.now() - Date.parse(oldestAt);
    return Number.isFinite(ms) ? Math.max(0, ms) / 1000 : null;
  });

  // Probed live rather than read off statsSync: free space changes because of the journal and the
  // diag capture too, neither of which touches the spool's cache.
  meter
    .createObservableGauge("disk.free_ratio", {
      description:
        "Free space on the volume holding the usher store, as a fraction of capacity",
      unit: "1",
    })
    .addCallback(async (obs) => {
      const s = await space(opts.dir);
      if (s) obs.observe(s.freeFrac, ATTRS);
    });

  const drops = meter.createCounter("spool.drops", {
    description: "Undelivered batches destroyed, by reason",
    unit: "{batch}",
  });

  registered = {
    onDrop: (reason: SpoolDropReason) => drops.add(1, { ...ATTRS, reason }),
  };
  return registered;
}

/** Test seam — drop the registration so a fresh one can be observed. */
export function __resetSpoolMetricsForTests(): void {
  registered = null;
}
