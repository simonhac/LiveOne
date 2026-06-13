/**
 * Run-period recompute orchestration (run-tracking feature) — the analogue of
 * `lib/aggregation/daily-points.ts`. Drives the per-tracker PG recompute over a window, and
 * exposes the backfill/regenerate/delete range operations the cron uses.
 *
 * Decoupling invariant: this reads only the serving store (`point_readings`) and writes only
 * `device_run_periods`. It is never wired into the queue receiver / hot ingest path.
 */
import { and, gte, lte } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { deviceRunPeriods } from "@/lib/db/planetscale/schema";
import { recomputeRunPeriodsForWindow } from "@/lib/db/planetscale/run-periods-pg";
import { listEnabledTrackers } from "./resolve";

export const DEFAULT_TRAILING_MS = 6 * 60 * 60 * 1000; // 6h trailing window for the minutely cron

// Backfill chunk size. Each chunk is one bounded read + delete-and-reinsert transaction, so a
// multi-month backfill never loads the whole history at once. Must comfortably exceed the longest
// expected single run (a run that spans a chunk boundary is stitched by the next chunk's anchor).
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface RecomputeSummary {
  trackersProcessed: number;
  rowsDeleted: number;
  rowsInserted: number;
  openPeriods: number;
}

/** Recompute every enabled tracker over [winStartMs, winEndMs], "as of" nowMs. */
async function recomputeWindowAllTrackers(
  winStartMs: number,
  winEndMs: number,
  nowMs: number,
): Promise<RecomputeSummary> {
  const db = requirePlanetscaleDb();
  const trackers = await listEnabledTrackers();
  let rowsDeleted = 0;
  let rowsInserted = 0;
  let openPeriods = 0;

  for (const tracker of trackers) {
    try {
      const res = await recomputeRunPeriodsForWindow(
        db,
        tracker,
        winStartMs,
        winEndMs,
        nowMs,
      );
      rowsDeleted += res.deleted;
      rowsInserted += res.inserted;
      if (res.open) openPeriods += 1;
    } catch (err) {
      console.error(
        `[RunTracking] recompute failed for tracker ${tracker.id} (system=${tracker.systemId} role=${tracker.role}):`,
        err,
      );
    }
  }

  return {
    trackersProcessed: trackers.length,
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
  console.log(
    `[RunTracking] reconcile trailing ${Math.round(trailingMs / 3600000)}h: ` +
      `${summary.trackersProcessed} trackers, ${summary.rowsInserted} periods, ${summary.openPeriods} open`,
  );
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
): Promise<RecomputeSummary> {
  const db = requirePlanetscaleDb();
  const trackers = await listEnabledTrackers();
  let rowsDeleted = 0;
  let rowsInserted = 0;
  let openPeriods = 0;

  for (const tracker of trackers) {
    let trackerOpen = false;
    let cs = startMs;
    while (cs <= endMs) {
      const ce = Math.min(cs + CHUNK_MS, endMs);
      try {
        const res = await recomputeRunPeriodsForWindow(
          db,
          tracker,
          cs,
          ce,
          nowMs,
        );
        rowsDeleted += res.deleted;
        rowsInserted += res.inserted;
        trackerOpen = res.open;
        onProgress?.({
          tracker: `${tracker.systemId}/${tracker.role}`,
          chunkStartMs: cs,
          chunkEndMs: ce,
          inserted: res.inserted,
        });
      } catch (err) {
        console.error(
          `[RunTracking] recompute failed for tracker ${tracker.id} chunk ` +
            `${new Date(cs).toISOString()}..${new Date(ce).toISOString()}:`,
          err,
        );
      }
      if (ce >= endMs) break;
      cs = ce;
    }
    if (trackerOpen) openPeriods += 1;
  }

  const summary: RecomputeSummary = {
    trackersProcessed: trackers.length,
    rowsDeleted,
    rowsInserted,
    openPeriods,
  };
  console.log(
    `[RunTracking] recompute range ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}: ` +
      `${summary.trackersProcessed} trackers, ${summary.rowsInserted} periods`,
  );
  return summary;
}

/** Delete all run periods whose start_time falls in [startMs, endMs] (all trackers). */
export async function deleteRange(
  startMs: number,
  endMs: number,
): Promise<{ rowsDeleted: number }> {
  const deleted = await requirePlanetscaleDb()
    .delete(deviceRunPeriods)
    .where(
      and(
        gte(deviceRunPeriods.startTime, new Date(startMs)),
        lte(deviceRunPeriods.startTime, new Date(endMs)),
      ),
    )
    .returning({ startTime: deviceRunPeriods.startTime });
  console.log(
    `[RunTracking] deleted ${deleted.length} run periods in ` +
      `${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
  );
  return { rowsDeleted: deleted.length };
}
