/**
 * Run-period recompute orchestration (run-tracking feature) — the analogue of
 * `lib/aggregation/daily-points.ts`. Drives the per-detector PG recompute over a window, and
 * exposes the backfill/regenerate/delete range operations the cron uses.
 *
 * Decoupling invariant: this reads only the serving store (`point_readings`) and writes only
 * `derived_intervals`. It is never wired into the queue receiver / hot ingest path.
 */
import { and, gte, lte } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivedIntervals } from "@/lib/db/planetscale/schema";
import {
  withTransientPostgresRetry,
  type TransientPostgresRetryOptions,
} from "@/lib/db/planetscale/transient-retry";
import { recomputeIntervalsForWindow } from "@/lib/db/planetscale/derived-intervals-pg";
import { listEnabledRunDetectors } from "@/lib/derivations/resolve";

export const DEFAULT_TRAILING_MS = 6 * 60 * 60 * 1000; // 6h trailing window for the minutely cron

// Backfill chunk size. Each chunk is one bounded read + delete-and-reinsert transaction, so a
// multi-month backfill never loads the whole history at once. Must comfortably exceed the longest
// expected single run (a run that spans a chunk boundary is stitched by the next chunk's anchor).
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface RecomputeSummary {
  trackersProcessed: number;
  /**
   * How many detectors FAILED this pass (their error was caught and logged, not thrown).
   *
   * 🛑 This exists because the swallow below made a broken pass indistinguishable from an idle one:
   * the minutely cron returned `success: true` with `rowsInserted: 0` — green while deriving
   * nothing — so the only evidence was a `console.error` nobody is watching. Any non-zero value here
   * means intervals are NOT being maintained right now, and the number is surfaced in the cron's
   * JSON response so the failure is visible without reading logs.
   *
   * The swallow itself is deliberate and stays: one broken detector must not cost every other
   * detector its reconcile. What was wrong was doing it silently.
   */
  trackersFailed: number;
  rowsDeleted: number;
  rowsInserted: number;
  openPeriods: number;
}

export interface RecomputeRetryOptions extends TransientPostgresRetryOptions {
  /** Surface exhausted tracker failures after processing the remaining trackers. */
  failOnError?: boolean;
}

/** Recompute every enabled run detector over [winStartMs, winEndMs], "as of" nowMs. */
async function recomputeWindowAllTrackers(
  winStartMs: number,
  winEndMs: number,
  nowMs: number,
): Promise<RecomputeSummary> {
  const db = requirePlanetscaleDb();
  const trackers = await withTransientPostgresRetry(() =>
    listEnabledRunDetectors(),
  );
  let rowsDeleted = 0;
  let rowsInserted = 0;
  let openPeriods = 0;
  let trackersFailed = 0;

  for (const tracker of trackers) {
    try {
      const res = await withTransientPostgresRetry(() =>
        recomputeIntervalsForWindow(db, tracker, winStartMs, winEndMs, nowMs),
      );
      rowsDeleted += res.deleted;
      rowsInserted += res.inserted;
      if (res.open) openPeriods += 1;
    } catch (err) {
      trackersFailed += 1;
      console.error(
        `[RunTracking] recompute failed for derivation ${tracker.id} (handle=${tracker.legacyHandle} role=${tracker.role}):`,
        err,
      );
    }
  }

  return {
    trackersProcessed: trackers.length,
    trackersFailed,
    rowsDeleted,
    rowsInserted,
    openPeriods,
  };
}

/**
 * The minutely cron's default pass: reconcile a trailing window so the open period and any
 * just-closed period stay fresh, and out-of-order raw within the window self-heals.
 */
export async function reconcileTrailingWindow(
  nowMs: number,
  trailingMs: number = DEFAULT_TRAILING_MS,
): Promise<RecomputeSummary> {
  const summary = await recomputeWindowAllTrackers(
    nowMs - trailingMs,
    nowMs,
    nowMs,
  );
  const line =
    `[RunTracking] reconcile trailing ${Math.round(trailingMs / 3600000)}h: ` +
    `${summary.trackersProcessed} trackers, ${summary.rowsInserted} periods, ${summary.openPeriods} open`;
  if (summary.trackersFailed > 0) {
    // Loud, and at error level: this pass derived nothing for those detectors.
    console.error(`${line}, ${summary.trackersFailed} FAILED`);
  } else {
    console.log(line);
  }
  return summary;
}

/**
 * Backfill/heal an explicit time range across all trackers, processed in bounded CHUNK_MS
 * sub-windows (oldest→newest) so even a multi-month range (data goes back to Aug 2025) never loads
 * the whole history in one transaction. Each chunk is its own bounded read + delete-and-reinsert;
 * a run spanning a chunk boundary is stitched by the next chunk's anchor/margin. Detection is "as
 * of" real now, so historical tails close correctly while a range ending at now keeps its open
 * period. `onProgress` is called after each chunk (for a CLI progress bar).
 */
export async function recomputeRange(
  startMs: number,
  endMs: number,
  nowMs: number,
  onProgress?: (info: {
    tracker: string;
    chunkStartMs: number;
    chunkEndMs: number;
    inserted: number;
  }) => void,
  retryOptions: RecomputeRetryOptions = {},
): Promise<RecomputeSummary> {
  const db = requirePlanetscaleDb();
  const trackers = await withTransientPostgresRetry(
    () => listEnabledRunDetectors(),
    retryOptions,
  );
  let rowsDeleted = 0;
  let rowsInserted = 0;
  let openPeriods = 0;
  const failures: Error[] = [];

  for (const tracker of trackers) {
    let trackerOpen = false;
    let cs = startMs;
    while (cs <= endMs) {
      const ce = Math.min(cs + CHUNK_MS, endMs);
      try {
        const res = await withTransientPostgresRetry(
          () => recomputeIntervalsForWindow(db, tracker, cs, ce, nowMs),
          retryOptions,
        );
        rowsDeleted += res.deleted;
        rowsInserted += res.inserted;
        trackerOpen = res.open;
        onProgress?.({
          tracker: `${tracker.legacyHandle}/${tracker.role}`,
          chunkStartMs: cs,
          chunkEndMs: ce,
          inserted: res.inserted,
        });
      } catch (err) {
        console.error(
          `[RunTracking] recompute failed for derivation ${tracker.id} chunk ` +
            `${new Date(cs).toISOString()}..${new Date(ce).toISOString()}:`,
          err,
        );
        failures.push(err instanceof Error ? err : new Error(String(err)));
      }
      if (ce >= endMs) break;
      cs = ce;
    }
    if (trackerOpen) openPeriods += 1;
  }

  const summary: RecomputeSummary = {
    trackersProcessed: trackers.length,
    // Chunked, so this counts FAILED CHUNKS rather than whole detectors — `failures` is per chunk.
    // Still the right signal (non-zero ⇒ some window was not rebuilt); `failOnError` below keeps its
    // existing throw-after-processing semantics on this explicit-range path, unchanged.
    trackersFailed: failures.length,
    rowsDeleted,
    rowsInserted,
    openPeriods,
  };
  console.log(
    `[RunTracking] recompute range ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}: ` +
      `${summary.trackersProcessed} trackers, ${summary.rowsInserted} periods`,
  );
  if (retryOptions.failOnError && failures.length > 0) {
    throw new AggregateError(
      failures,
      `run-period recompute failed for ${failures.length} detector window(s) after retries`,
    );
  }
  return summary;
}

/** Delete all derived intervals whose start_time falls in [startMs, endMs] (all detectors). */
export async function deleteRange(
  startMs: number,
  endMs: number,
): Promise<{ rowsDeleted: number }> {
  const deleted = await requirePlanetscaleDb()
    .delete(derivedIntervals)
    .where(
      and(
        gte(derivedIntervals.startTime, new Date(startMs)),
        lte(derivedIntervals.startTime, new Date(endMs)),
      ),
    )
    .returning({ startTime: derivedIntervals.startTime });
  console.log(
    `[RunTracking] deleted ${deleted.length} run periods in ` +
      `${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
  );
  return { rowsDeleted: deleted.length };
}
