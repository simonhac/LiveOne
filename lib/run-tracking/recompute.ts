/**
 * Run-period recompute orchestration (run-tracking feature) — the analogue of
 * `lib/aggregation/daily-points.ts`. Drives the per-detector PG recompute over a window, and
 * exposes the backfill/regenerate/delete range operations the cron uses.
 *
 * Decoupling invariant: this reads only the serving store (`point_readings`) and writes only
 * `derived_intervals`. It is never wired into the queue receiver / hot ingest path.
 */
import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivedIntervals } from "@/lib/db/planetscale/schema";
import {
  withTransientPostgresRetry,
  type TransientPostgresRetryOptions,
} from "@/lib/db/planetscale/transient-retry";
import { recomputeIntervalsForWindow } from "@/lib/db/planetscale/derived-intervals-pg";
import {
  listEnabledRunDetectors,
  type RunDetectorFilter,
} from "@/lib/derivations/resolve";
import { resolveIntensityInputPoints } from "@/lib/run-tracking/intensity";
import { REHEAL_TRAILING_MS } from "@/lib/battery-provenance/recompute";
import { ReadingsDao } from "@/lib/readings";

export const DEFAULT_TRAILING_MS = 6 * 60 * 60 * 1000; // 6h trailing window for the minutely cron

// Backfill chunk size. Each chunk is one bounded read + delete-and-reinsert transaction, so a
// multi-month backfill never loads the whole history at once. Must comfortably exceed the longest
// expected single run (a run that spans a chunk boundary is stitched by the next chunk's anchor).
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * How far back a run must be to be a re-price candidate. Reuses the battery-provenance reheal's own
 * settlement window so the two agree on what "past settlement" means: everything newer is still
 * being rewritten by a contiguous pass (the minutely trailing reconcile, the daily heal over the
 * aggregation range, the nightly blend recompute), so re-pricing it here would only fight them.
 */
const REPRICE_FLOOR_MS = REHEAL_TRAILING_MS;
/** Per-pass cap on re-prices — a big backlog (a fleet-wide input rewrite) drains over nights. */
const REPRICE_MAX_RUNS_PER_PASS = 25;
/** Per-pass cap on staleness PROBES. Far higher than the re-price cap: a probe is one indexed
 *  MAX(updated_at), a re-price is a detect + energy + blend rebuild. */
const PROBE_MAX_RUNS_PER_PASS = 500;
/** The ±1-interval pad `resolveLoadIntensity` puts around a run's span, so the probe covers the
 *  same rows the pricing did (an edge interval rewritten at the boundary still counts as movement). */
const INTENSITY_PAD_MS = 5 * 60 * 1000;

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

export interface RecomputeRangeOptions {
  /** Called after each chunk (for a CLI progress bar). */
  onProgress?: (info: {
    tracker: string;
    chunkStartMs: number;
    chunkEndMs: number;
    inserted: number;
  }) => void;
  retry?: RecomputeRetryOptions;
  /**
   * Narrow the pass to ONE detector. Omitted = every enabled detector, which is correct for the
   * trailing reconcile and wrong for anything historical — see {@link RunDetectorFilter}.
   */
  filter?: RunDetectorFilter;
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

export interface RehealSummary {
  /** Detectors that had something to watch (a priced role with a resolvable input set). */
  detectorsProcessed: number;
  /** Runs whose inputs were probed individually (the coarse bucket gate skips the rest). */
  probed: number;
  /** Runs re-priced this pass. */
  repriced: number;
  /** A cap bit — more work was outstanding than this pass was allowed to do. */
  capped: boolean;
}

/** One candidate run: the identity (`derivation_id` + `start_time`) plus its pricing watermark. */
interface CandidateRun {
  startMs: number;
  endMs: number;
  /** When this row was last priced — `updated_at`, stamped by the delete-and-reinsert. */
  pricedAtMs: number;
}

/**
 * Bounded, oldest-first re-price of runs whose PRICING INPUTS have moved since they were priced.
 *
 * The problem this closes: `recomputeIntervalsForWindow` accumulates `cost_c` / `emissions_g` /
 * `renewable_kwh` ONCE and stores them, but their inputs keep moving — Amber settles over ~72h,
 * OpenElectricity revises, and the nightly heal re-materialises the `bidi.battery/*` blend. The
 * Sankey recomputes live and follows all of it; a stored run older than the contiguous passes' reach
 * does not, so the two surfaces disagree by however far the inputs drifted, permanently, per row.
 *
 * There is no version column and none is needed — both halves of the watermark already exist:
 * `derived_intervals.updated_at` IS "when was this priced" (every re-price is a delete-and-reinsert,
 * so it takes the column default), and `point_readings_agg_5m.updated_at` is bumped on every upsert.
 * So staleness is a QUERY:
 *
 * > A run is stale if any intensity point feeding it has an `agg_5m` row inside the run's span whose
 * > `updated_at` is later than the run's own.
 *
 * Shaped on `rehealStaleAttrDays` (lib/battery-provenance/recompute.ts) — bounded per invocation,
 * oldest-first, self-draining, best-effort per detector — and it runs LAST in the daily pass for the
 * same reason that one does: a hiccup here must never roll back the committed work above it, and
 * re-pricing before the day's blend has been rewritten would just re-stale every row it touched.
 *
 * COARSE GATE, THEN DRILL. Probing every candidate every night is O(all runs, forever) and the
 * backlog is normally empty, so the runs are bucketed by month and each bucket gets ONE probe over
 * its whole span first: if nothing in the bucket moved since its OLDEST row was priced, no run in it
 * can be stale and the whole month is skipped without a single per-run query.
 */
export async function rehealStaleRuns(
  nowMs: number,
  opts: { limit?: number; probeLimit?: number } = {},
): Promise<RehealSummary> {
  const db = requirePlanetscaleDb();
  const limit = opts.limit ?? REPRICE_MAX_RUNS_PER_PASS;
  const probeLimit = opts.probeLimit ?? PROBE_MAX_RUNS_PER_PASS;
  const floorMs = nowMs - REPRICE_FLOOR_MS;

  const detectors = await withTransientPostgresRetry(() =>
    listEnabledRunDetectors(),
  );
  const summary: RehealSummary = {
    detectorsProcessed: 0,
    probed: 0,
    repriced: 0,
    capped: false,
  };

  for (const det of detectors) {
    // No energy point ⇒ no counter to integrate provenance over ⇒ the columns were never written.
    if (!det.energyPoint) continue;
    try {
      const inputs = await resolveIntensityInputPoints(db, det);
      // Empty is "this role's price cannot drift" (the generator's configured constants) or "it was
      // never priced at all" — not "nothing moved". Either way there is nothing to watch.
      if (inputs.length === 0) continue;
      summary.detectorsProcessed += 1;

      // Closed runs only, and only past the settlement floor. An open run is by definition inside
      // the trailing reconcile's window, which re-prices it every minute.
      const rows = await withTransientPostgresRetry(() =>
        db
          .select({
            startTime: derivedIntervals.startTime,
            endTime: derivedIntervals.endTime,
            updatedAt: derivedIntervals.updatedAt,
          })
          .from(derivedIntervals)
          .where(
            and(
              eq(derivedIntervals.derivationId, det.id),
              isNotNull(derivedIntervals.endTime),
              lte(derivedIntervals.endTime, new Date(floorMs)),
            ),
          )
          .orderBy(asc(derivedIntervals.startTime)),
      );
      if (rows.length === 0) continue;

      const candidates: CandidateRun[] = rows.map((r) => ({
        startMs: r.startTime.getTime(),
        endMs: r.endTime!.getTime(),
        pricedAtMs: r.updatedAt.getTime(),
      }));

      const stale: CandidateRun[] = [];
      for (const bucket of bucketByMonth(candidates)) {
        if (summary.probed >= probeLimit) {
          summary.capped = true;
          break;
        }
        const spanStartMs = bucket[0].startMs;
        const spanEndMs = Math.max(...bucket.map((c) => c.endMs));
        const oldestPricedAtMs = Math.min(...bucket.map((c) => c.pricedAtMs));
        const bucketMax = await ReadingsDao.latestAgg5mUpdatedAtForPoints(
          inputs,
          {
            afterIntervalEndMs: spanStartMs - INTENSITY_PAD_MS,
            throughIntervalEndMs: spanEndMs + INTENSITY_PAD_MS,
          },
          db,
        );
        // Nothing in the month moved after its oldest row was priced ⇒ no row in it can be stale.
        if (bucketMax === null || bucketMax <= oldestPricedAtMs) continue;

        for (const run of bucket) {
          if (summary.probed >= probeLimit) {
            summary.capped = true;
            break;
          }
          summary.probed += 1;
          const movedAtMs = await ReadingsDao.latestAgg5mUpdatedAtForPoints(
            inputs,
            {
              afterIntervalEndMs: run.startMs - INTENSITY_PAD_MS,
              throughIntervalEndMs: run.endMs + INTENSITY_PAD_MS,
            },
            db,
          );
          if (movedAtMs !== null && movedAtMs > run.pricedAtMs) stale.push(run);
        }
      }

      if (stale.length > limit - summary.repriced) summary.capped = true;
      for (const run of stale) {
        if (summary.repriced >= limit) break;
        // The window is EXACTLY the run's own span, so the bounded delete-and-reinsert touches this
        // one row and nothing else. Never widen it to bracket neighbours: a window that ends
        // mid-run truncates that run and drops its continuation.
        await withTransientPostgresRetry(() =>
          recomputeIntervalsForWindow(db, det, run.startMs, run.endMs, nowMs),
        );
        summary.repriced += 1;
      }
    } catch (err) {
      console.error(
        `[RunTracking] reheal failed for derivation ${det.id} (handle=${det.legacyHandle} role=${det.role}):`,
        err,
      );
    }
  }

  if (summary.repriced > 0 || summary.capped) {
    console.log(
      `[RunTracking] reheal: ${summary.repriced} run(s) re-priced from ` +
        `${summary.probed} probe(s) across ${summary.detectorsProcessed} detector(s)` +
        `${summary.capped ? " — CAPPED, more outstanding (drains next pass)" : ""}`,
    );
  }
  return summary;
}

/** Split runs (already ordered oldest-first) into UTC-month buckets, preserving that order. */
function bucketByMonth(runs: CandidateRun[]): CandidateRun[][] {
  const byMonth = new Map<string, CandidateRun[]>();
  for (const run of runs) {
    const key = new Date(run.startMs).toISOString().slice(0, 7);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(run);
    else byMonth.set(key, [run]);
  }
  return [...byMonth.values()];
}

/**
 * Backfill/heal an explicit time range across all trackers, processed in bounded CHUNK_MS
 * sub-windows (oldest→newest) so even a multi-month range (data goes back to Aug 2025) never loads
 * the whole history in one transaction. Each chunk is its own bounded read + delete-and-reinsert;
 * a run spanning a chunk boundary is stitched by the next chunk's anchor/margin. Detection is "as
 * of" real now, so historical tails close correctly while a range ending at now keeps its open
 * period. `options.onProgress` is called after each chunk (for a CLI progress bar).
 *
 * 🛑 `options.filter` is not optional in spirit for a HISTORICAL range: this is delete-and-reinsert,
 * so an unscoped pass rebuilds every detector, and one whose signal has been re-pointed loses the
 * rows its current signal cannot reproduce. See {@link RunDetectorFilter}.
 */
export async function recomputeRange(
  startMs: number,
  endMs: number,
  nowMs: number,
  options: RecomputeRangeOptions = {},
): Promise<RecomputeSummary> {
  const { onProgress, filter } = options;
  const retryOptions = options.retry ?? {};
  const db = requirePlanetscaleDb();
  const trackers = await withTransientPostgresRetry(
    () => listEnabledRunDetectors(filter),
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
    `[RunTracking] recompute range ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}` +
      `${filter ? ` [scoped: ${describeFilter(filter)}]` : ""}: ` +
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

/** One-line rendering of a scope, for the log lines and the cron's JSON response. */
export function describeFilter(filter: RunDetectorFilter): string {
  return "derivationId" in filter
    ? filter.derivationId
    : `${filter.handle}/${filter.role}`;
}

/**
 * Delete derived intervals whose start_time falls in [startMs, endMs].
 *
 * Without a `filter` this is EVERY detector's intervals in the window — which is what the unscoped
 * `action=delete`/`action=regenerate` cron path has always meant, and why a historical range should
 * carry a filter. With one, only that detector's rows are touched.
 *
 * A filter that resolves to no enabled detector deletes NOTHING (and says so), rather than falling
 * back to the unfiltered delete.
 */
export async function deleteRange(
  startMs: number,
  endMs: number,
  filter?: RunDetectorFilter,
): Promise<{ rowsDeleted: number }> {
  const conds = [
    gte(derivedIntervals.startTime, new Date(startMs)),
    lte(derivedIntervals.startTime, new Date(endMs)),
  ];
  if (filter) {
    const ids = (await listEnabledRunDetectors(filter)).map((d) => d.id);
    if (ids.length === 0) {
      console.log(
        `[RunTracking] delete scoped to ${describeFilter(filter)} matched no enabled detector — nothing deleted`,
      );
      return { rowsDeleted: 0 };
    }
    conds.push(inArray(derivedIntervals.derivationId, ids));
  }
  const deleted = await requirePlanetscaleDb()
    .delete(derivedIntervals)
    .where(and(...conds))
    .returning({ startTime: derivedIntervals.startTime });
  console.log(
    `[RunTracking] deleted ${deleted.length} run periods in ` +
      `${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}` +
      `${filter ? ` [scoped: ${describeFilter(filter)}]` : ""}`,
  );
  return { rowsDeleted: deleted.length };
}
