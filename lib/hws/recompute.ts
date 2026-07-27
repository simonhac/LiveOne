/**
 * Hot-water temperature recompute (HWS model).
 *
 * The modelled hot-tap temperature is a **derived point** in the generic readings system — NOT a
 * bespoke table. Each modelled system is an `output='point'` row in `derivations` (config-v4
 * Phase 11) naming its `load.hws/power` signal and its `load.hws/temperature` output point; this
 * reads the power point's `point_readings_agg_5m.avg`, runs the pure thermal model
 * (`lib/hws-model.ts`), and writes the faucet temperature into the temperature point's own
 * `point_readings_agg_5m` rows (plus the KV latest cache, so it shows on the dashboard like any
 * other point). Enablement used to be "a temperature point_info row exists"; it is now "an enabled
 * hws-model derivation exists" — the same mechanism that discovers a run detector.
 *
 * It reads only `point_readings_agg_5m` and writes only the derived point's `agg_5m`/KV — it is
 * never on the hot ingest path. The 5m aggregator skips points with no raw readings, so it never
 * clobbers these derived rows.
 *
 * Idempotency: the model needs a warmup lead-in (the first-order tank temperature converges in
 * ~3·tau ≈ 8h, so a 2-day warmup makes each window boundary-independent). We always read
 * `[winStart − WARMUP_MS, winEnd]`, model across it, and UPSERT only the window's intervals — so a
 * re-run / late data resolves to the same values with no deletes.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao, type Agg5mInsert } from "@/lib/readings";
import { modelHws, type HwsSample } from "@/lib/hws-model";
import {
  listEnabledHwsModels,
  type ResolvedHwsModel,
} from "@/lib/derivations/resolve";
import { updateLatestPointValue } from "@/lib/kv-cache-manager";

export const WARMUP_MS = 2 * 24 * 60 * 60 * 1000; // model warmup lead-in (≈6× convergence time)
export const DEFAULT_TRAILING_MS = 6 * 60 * 60 * 1000; // minutely-cron trailing window
const CHUNK_MS = 14 * 24 * 60 * 60 * 1000; // backfill chunk (≫ warmup)

export interface HwsRecomputeSummary {
  pairsProcessed: number;
  rowsWritten: number;
}

/**
 * Every enabled HWS model. Kept as a named export (rather than inlining
 * `listEnabledHwsModels`) because the backfill script and tests discover pairs through it.
 */
export async function listHwsPairs(): Promise<ResolvedHwsModel[]> {
  return listEnabledHwsModels();
}

/**
 * Recompute one pair's modelled temperature over [winStartMs, winEndMs] and UPSERT it into the
 * temperature point's agg_5m. With `updateLatest`, also refresh the KV latest from the newest step.
 */
async function recomputePairWindow(
  pair: ResolvedHwsModel,
  winStartMs: number,
  winEndMs: number,
  updateLatest: boolean,
): Promise<number> {
  const db = requirePlanetscaleDb();

  // agg_5m `avg` series for the power point over [winStart − WARMUP_MS, winEnd] (inclusive, ascending).
  const series = await ReadingsDao.read5m(
    [pair.powerPoint],
    { fromMs: winStartMs - WARMUP_MS, toMs: winEndMs },
    db,
  );
  const samples: HwsSample[] = (series.get(pair.powerPoint) ?? []).map((r) => ({
    tsMs: r.intervalEndMs,
    powerW: r.avg, // null avg → null power; the model carries tank state across the gap
  }));

  const steps = modelHws(samples, pair.options).filter(
    (s) => s.tsMs >= winStartMs && s.tsMs <= winEndMs,
  );
  if (steps.length === 0) return 0;

  const aggRows: Agg5mInsert[] = steps.map((s) => ({
    point: pair.tempPoint,
    intervalEndMs: s.tsMs,
    avg: s.faucetC,
    min: s.faucetC,
    max: s.faucetC,
    last: s.faucetC,
    delta: null,
    valueStr: null,
    sampleCount: 1,
    errorCount: 0,
    dataQuality: "good",
    sessionId: null,
  }));

  // The derived point is sole-writer here: own the value cols + `data_quality`, never
  // `session_id`/`value_str`. Byte-identical to the legacy upsert SET.
  await ReadingsDao.insert5m(
    aggRows,
    { upsert: true, preserveVendorMeta: true, writeDataQuality: true },
    db,
  );

  if (updateLatest) {
    const last = steps[steps.length - 1];
    await updateLatestPointValue(
      pair.systemId,
      pair.tempPointIndex,
      pair.tempPath,
      last.faucetC,
      last.tsMs,
      Date.now(),
      pair.tempUnit,
      pair.tempDisplayName,
    );
  }

  return steps.length;
}

/**
 * The minutely cron's pass: reconcile a trailing window so the current temperature stays fresh and
 * recent out-of-order power self-heals. Refreshes the KV latest. No-op when no HWS pairs exist.
 */
export async function reconcileTrailingWindow(
  nowMs: number,
  trailingMs: number = DEFAULT_TRAILING_MS,
): Promise<HwsRecomputeSummary> {
  const pairs = await listHwsPairs();
  let rowsWritten = 0;
  for (const pair of pairs) {
    try {
      rowsWritten += await recomputePairWindow(
        pair,
        nowMs - trailingMs,
        nowMs,
        true,
      );
    } catch (err) {
      console.error(`[HWS] reconcile failed for system ${pair.systemId}:`, err);
    }
  }
  if (pairs.length > 0) {
    console.log(
      `[HWS] reconcile trailing ${Math.round(trailingMs / 3600000)}h: ${pairs.length} pairs, ${rowsWritten} rows`,
    );
  }
  return { pairsProcessed: pairs.length, rowsWritten };
}

/**
 * Backfill/heal an explicit range across all pairs in bounded 14-day chunks (oldest→newest). Does
 * NOT touch the KV latest (the next trailing reconcile sets it). No-op when no HWS pairs exist.
 */
export async function recomputeRange(
  startMs: number,
  endMs: number,
  onProgress?: (info: {
    system: number;
    chunkStartMs: number;
    chunkEndMs: number;
    rows: number;
  }) => void,
): Promise<HwsRecomputeSummary> {
  const pairs = await listHwsPairs();
  let rowsWritten = 0;
  for (const pair of pairs) {
    let cs = startMs;
    while (cs <= endMs) {
      const ce = Math.min(cs + CHUNK_MS, endMs);
      try {
        const rows = await recomputePairWindow(pair, cs, ce, false);
        rowsWritten += rows;
        onProgress?.({
          system: pair.systemId,
          chunkStartMs: cs,
          chunkEndMs: ce,
          rows,
        });
      } catch (err) {
        console.error(
          `[HWS] recompute failed for system ${pair.systemId} chunk ` +
            `${new Date(cs).toISOString()}..${new Date(ce).toISOString()}:`,
          err,
        );
      }
      if (ce >= endMs) break;
      cs = ce;
    }
  }
  console.log(
    `[HWS] recompute range ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}: ${pairs.length} pairs, ${rowsWritten} rows`,
  );
  return { pairsProcessed: pairs.length, rowsWritten };
}
