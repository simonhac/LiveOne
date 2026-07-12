/**
 * Postgres-side battery-provenance recompute — the PROD DRIVER. It calls the SAME shared engine the
 * offline harness does (`loadProvenanceInputs` + `computeBatteryProvenance`) and WRITES the battery's
 * blended intensities into the three derived points' own `agg_5m` + KV latest (the HWS derived-point
 * pattern). Off the ingest hot path; best-effort so it can never break the aggregation it trails.
 *
 * The blend fold is STATEFUL, so the load window is extended back by WARMUP_MS to reach a reset (a
 * bottom-out) before the target window — only the target window's rows are written. This mirrors HWS's
 * warm-up lead-in; the exact segment-anchor is a refinement (see the Phase-2 plan). With `writeRollup`
 * (the daily/range pass) it ALSO materialises the per-day attribution rollup (point_readings_flow_attr_1d)
 * from the SAME accounting, sliced per local day — the source of the "cost/carbon/renewable over a period"
 * questions.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import { pointReadingsAgg5m, pointReadingsFlowAttr1d } from "./schema";
import { computeFlowAccounting } from "@/lib/aggregation/flow-matrix-core";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import type {
  ProvenanceInputs,
  ProvenanceResult,
} from "@/lib/battery-provenance/types";
import {
  buildSubscriptionRegistry,
  updateLatestPointValue,
} from "@/lib/kv-cache-manager";
import { loadProvenanceInputs } from "@/lib/battery-provenance/load";
import { computeBatteryProvenance } from "@/lib/battery-provenance/compute";
import {
  BLEND_POINTS,
  ensureBatteryProvenancePoints,
  ensureHelperBindings,
} from "@/lib/battery-provenance/register";
import { ensureHelperDevice } from "@/lib/areas/helper";
import type { ProvenanceConfig } from "@/lib/battery-provenance/types";
import type { FoldStep } from "@/lib/battery-provenance/fold";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Fold warm-up lead-in: enough to reach a reset (bottom-out) before the target window. */
export const WARMUP_MS = 7 * 24 * 3600 * 1000;

const BATTERY_STEM = "bidi.battery";

/** The blend value for a metricType from a fold step (null when the store is empty → not written). */
function blendValue(step: FoldStep, metricType: string): number | null {
  switch (metricType) {
    case "carbon-intensity":
      return step.batteryEmissionsIntensity;
    case "renewable-fraction":
      return step.batteryRenewableFraction === null
        ? null
        : step.batteryRenewableFraction * 100;
    case "price":
      return step.batteryPrice;
    default:
      return null;
  }
}

const FLOW_ATTR_VERSION = 1;
const MIN_ATTR_KWH = 0.001;

/** Local calendar days (Area tz) whose interval-ends fall in [startMs, endMs]. */
function localDaysInRange(
  startMs: number,
  endMs: number,
  tzOffsetMin: number,
): CalendarDate[] {
  const toDay = (ms: number) => {
    const d = new Date(ms + tzOffsetMin * 60000);
    return new CalendarDate(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
    );
  };
  let day = toDay(startMs);
  const last = toDay(endMs);
  const days: CalendarDate[] = [];
  while (day.compare(last) <= 0) {
    days.push(day);
    day = day.add({ days: 1 });
  }
  return days;
}

/**
 * Materialise the per-day attribution rollup (`point_readings_flow_attr_1d`) for every local day the
 * window covers — energy + attributed emissions/renewable/cost per source→load edge, keyed exactly like
 * `flow_1d`. Runs the SAME `computeFlowAccounting` the window used, sliced to each local day (the fold ran
 * over the whole window for anchoring). Delete-then-insert per (area, day), idempotent like flow_1d.
 */
async function writeAttrRollup(
  db: PgDb,
  inputs: ProvenanceInputs,
  result: ProvenanceResult,
  winStartMs: number,
  winEndMs: number,
): Promise<number> {
  let total = 0;
  for (const day of localDaysInRange(
    winStartMs,
    winEndMs,
    inputs.timezoneOffsetMin,
  )) {
    const [startUnix, endUnix] = dayToUnixRangeForAggregation(
      day,
      inputs.timezoneOffsetMin,
    );
    const acc = computeFlowAccounting({
      timestamps: inputs.timeline,
      sources: inputs.sources,
      loads: inputs.loads,
      sourceIntensities: result.sourceIntensities,
      window: { startMs: startUnix * 1000, endMs: endUnix * 1000 },
    });
    const rows: (typeof pointReadingsFlowAttr1d.$inferInsert)[] = [];
    for (let s = 0; s < acc.sources.length; s++) {
      for (let l = 0; l < acc.loads.length; l++) {
        const e = acc.energyKwh[s][l];
        if (e <= MIN_ATTR_KWH) continue;
        rows.push({
          areaId: inputs.areaId,
          day: day.toString(),
          sourcePath: acc.sources[s],
          loadPath: acc.loads[l],
          energyKwh: e,
          // null = the source's intensity was unknown for this edge/day.
          emissionsG:
            acc.emissionsKnownKwh[s][l] > 0 ? acc.emissionsG[s][l] : null,
          renewableKwh:
            acc.renewableKnownKwh[s][l] > 0 ? acc.renewableKwh[s][l] : null,
          costC: acc.priceKnownKwh[s][l] > 0 ? acc.costC[s][l] : null,
          estimatedKwh: acc.estimatedKwh[s][l],
          sampleCount: acc.intervalsUsed,
          version: FLOW_ATTR_VERSION,
        });
      }
    }
    const dayFilter = and(
      eq(pointReadingsFlowAttr1d.areaId, inputs.areaId),
      eq(pointReadingsFlowAttr1d.day, day.toString()),
    );
    await db.transaction(async (tx) => {
      await tx.delete(pointReadingsFlowAttr1d).where(dayFilter);
      if (rows.length > 0)
        await tx.insert(pointReadingsFlowAttr1d).values(rows);
    });
    total += rows.length;
  }
  return total;
}

export interface RecomputeResult {
  rowsWritten: number;
  /** The Area's helper device the blend was written to (null if the Area has no battery). */
  helperSystemId: number | null;
  pointIds: Record<string, number>;
  /** Rollup rows written to point_readings_flow_attr_1d (0 unless opts.writeRollup). */
  attrRowsWritten: number;
}

/**
 * Recompute an Area's battery blend over [winStartMs, winEndMs] and UPSERT the three derived points'
 * agg_5m (+ KV latest when `updateLatest`). Registers the derived points if missing.
 */
export async function recomputeBatteryProvenanceForWindow(
  db: PgDb,
  handle: number,
  winStartMs: number,
  winEndMs: number,
  opts: {
    updateLatest?: boolean;
    writeRollup?: boolean;
    config?: ProvenanceConfig;
  } = {},
): Promise<RecomputeResult> {
  const inputs = await loadProvenanceInputs(handle, {
    startMs: winStartMs - WARMUP_MS,
    endMs: winEndMs,
  });
  if (!inputs || inputs.batterySystemId == null) {
    return {
      rowsWritten: 0,
      helperSystemId: null,
      pointIds: {},
      attrRowsWritten: 0,
    };
  }

  const result = computeBatteryProvenance(inputs, opts.config);
  // The blend belongs to the AREA, not a physical child device — it lives on the Area's HELPER device.
  // Ensure the helper exists, register the 3 blend points on it, and bind them into the Area (so they
  // fan out to the Area's KV latest and appear in its resolved point set). Rebuild the KV subscription
  // registry only when bindings were newly created.
  const helperSystemId = await ensureHelperDevice(inputs.areaId);
  const ensure = await ensureBatteryProvenancePoints(helperSystemId, true, {
    requireBatteryPoint: false,
  });
  const bind = await ensureHelperBindings(
    inputs.areaId,
    helperSystemId,
    ensure.pointIds,
  );
  if (bind.created > 0) {
    // Best-effort — the KV registry rebuild (fan-out wiring) must never abort the agg_5m write, and it
    // degrades gracefully when KV isn't configured (dev/local). It only matters once per new binding set.
    try {
      await buildSubscriptionRegistry();
    } catch (e) {
      console.warn("[BatProv] subscription registry rebuild skipped:", e);
    }
  }
  const { timeline } = inputs;

  // Build agg_5m rows for each blend point over the TARGET window only (step i → interval end t[i+1]).
  const rows: (typeof pointReadingsAgg5m.$inferInsert)[] = [];
  const latest = new Map<string, { value: number; tsMs: number }>();
  for (const spec of BLEND_POINTS) {
    const pointId = ensure.pointIds[spec.metricType];
    if (pointId === undefined) continue;
    for (let i = 0; i < result.steps.length; i++) {
      const tsMs = timeline[i + 1];
      if (tsMs < winStartMs || tsMs > winEndMs) continue;
      const value = blendValue(result.steps[i], spec.metricType);
      if (value === null) continue;
      const dq = result.steps[i].estimatedFraction > 0 ? "estimated" : "good";
      rows.push({
        systemId: helperSystemId,
        pointId,
        intervalEnd: new Date(tsMs),
        avg: value,
        min: value,
        max: value,
        last: value,
        delta: null,
        sampleCount: 1,
        errorCount: 0,
        dataQuality: dq,
      });
      const cur = latest.get(spec.metricType);
      if (!cur || tsMs >= cur.tsMs)
        latest.set(spec.metricType, { value, tsMs });
    }
  }

  // Chunk the upsert — a single multi-thousand-row insert overflows drizzle's recursive query builder.
  const CHUNK = 1000;
  for (let off = 0; off < rows.length; off += CHUNK) {
    await db
      .insert(pointReadingsAgg5m)
      .values(rows.slice(off, off + CHUNK))
      .onConflictDoUpdate({
        target: [
          pointReadingsAgg5m.systemId,
          pointReadingsAgg5m.pointId,
          pointReadingsAgg5m.intervalEnd,
        ],
        set: {
          avg: sql`excluded.avg`,
          min: sql`excluded.min`,
          max: sql`excluded.max`,
          last: sql`excluded.last`,
          delta: sql`excluded.delta`,
          sampleCount: sql`excluded.sample_count`,
          errorCount: sql`excluded.error_count`,
          dataQuality: sql`excluded.data_quality`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (opts.updateLatest) {
    for (const spec of BLEND_POINTS) {
      const pointId = ensure.pointIds[spec.metricType];
      const l = latest.get(spec.metricType);
      if (pointId === undefined || !l) continue;
      await updateLatestPointValue(
        helperSystemId,
        pointId,
        `${BATTERY_STEM}/${spec.metricType}`,
        l.value,
        l.tsMs,
        Date.now(),
        spec.metricUnit,
        spec.displayName,
      );
    }
  }

  // Per-day attribution rollup (daily heal / backfill only — not every minute). Best-effort so a rollup
  // hiccup never loses the blend write above.
  let attrRowsWritten = 0;
  if (opts.writeRollup) {
    try {
      attrRowsWritten = await writeAttrRollup(
        db,
        inputs,
        result,
        winStartMs,
        winEndMs,
      );
    } catch (e) {
      console.warn("[BatProv] attr rollup write failed:", e);
    }
  }

  return {
    rowsWritten: rows.length,
    helperSystemId,
    pointIds: ensure.pointIds,
    attrRowsWritten,
  };
}

/**
 * Best-effort wrapper — no-op if PG isn't configured; swallows/logs errors so a fold hiccup can never
 * break the aggregation it trails. Awaited so the write completes before the serverless function freezes.
 */
export async function recomputeBatteryProvenanceForWindowBestEffort(
  handle: number,
  winStartMs: number,
  winEndMs: number,
  opts: {
    updateLatest?: boolean;
    writeRollup?: boolean;
    config?: ProvenanceConfig;
  } = {},
): Promise<void> {
  if (!planetscaleDb) return;
  try {
    const r = await recomputeBatteryProvenanceForWindow(
      planetscaleDb,
      handle,
      winStartMs,
      winEndMs,
      opts,
    );
    console.log(
      `[BatProv] handle=${handle} helper=${r.helperSystemId} rows=${r.rowsWritten}`,
    );
  } catch (err) {
    console.error(`[BatProv] recompute failed for handle=${handle}:`, err);
  }
}
