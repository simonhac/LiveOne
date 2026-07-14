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
import {
  loadProvenanceInputs,
  loadBatteryThroughput,
} from "@/lib/battery-provenance/load";
import { computeBatteryProvenance } from "@/lib/battery-provenance/compute";
import { learnEwmaEta } from "@/lib/battery-provenance/eta";
import {
  learnEwmaCapacity,
  measureWindowCapacity,
} from "@/lib/battery-provenance/capacity";
import {
  detectRecalDayIndexes,
  learnLosses,
} from "@/lib/battery-provenance/losses";
import {
  BLEND_POINTS,
  ensureBatteryProvenancePoints,
  ensureHelperBindings,
  ensureEfficiencyPoint,
  ensureEfficiencyBinding,
  ensureCapacityPoint,
  ensureCapacityBinding,
  ensureParamPoint,
  ensureParamBinding,
  CHARGE_EFFICIENCY_POINT,
  IDLE_LOSS_POINT,
} from "@/lib/battery-provenance/register";
import type { BatteryThroughput } from "@/lib/battery-provenance/load";
import { ensureHelperDevice } from "@/lib/areas/helper";
import type { ProvenanceConfig } from "@/lib/battery-provenance/types";
import type { FoldStep } from "@/lib/battery-provenance/fold";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Fold warm-up lead-in: enough to reach a reset (bottom-out) before the target window. */
export const WARMUP_MS = 7 * 24 * 3600 * 1000;

const BATTERY_STEM = "bidi.battery";

/** Fixed datasheet seed for the η EWMA — a CONSTANT (not window-measured) so η(day) is reproducible. */
const ETA_SEED = 0.9;
/** Learn η causally from this stable anchor every run, so η(day D) never depends on the recompute window. */
const ETA_ANCHOR_MS = Date.parse("2025-08-16T00:00:00Z");
const ETA_METRIC = "round-trip-efficiency";
const ETA_UNIT = "%";
const ETA_DISPLAY = "Battery Round-trip Efficiency";

/** Fallback seed (kWh) for the capacity EWMA when the window's SoC swing is too thin to measure a slope.
 *  On a cycling battery the daily EWMA fully overrides it; on a barely-cycling one the measured window seed
 *  (clamped) anchors it to a plausible C instead of this constant. */
const CAPACITY_SEED = 15;
const CAPACITY_ANCHOR_MS = ETA_ANCHOR_MS;
const CAPACITY_METRIC = "usable-capacity";
const CAPACITY_UNIT = "kWh";
const CAPACITY_DISPLAY = "Battery Usable Capacity";

const LOSSES_ANCHOR_MS = ETA_ANCHOR_MS;

/** BMS-recalibration local days for a throughput window (phantom SoC energy — excluded from every
 *  learner, matching the fold's `recal` snap events). Empty for a SoC-blind battery. */
function recalDaysFor(tp: BatteryThroughput): Set<number> {
  return detectRecalDayIndexes(
    tp.chargeKwh,
    tp.dischargeKwh,
    tp.soc,
    measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? CAPACITY_SEED,
    tp.timeline,
    tp.timezoneOffsetMin,
  );
}

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
    case "price-opportunity":
      return step.batteryPriceOpportunity;
    case "stored-energy":
      // Usable stored energy E. Unlike the intensities this is 0 (not null) when the store is empty —
      // but 0 kWh is written so the Contents card reads "empty" rather than a stale value.
      return step.storedKwh;
    default:
      return null;
  }
}

const FLOW_ATTR_VERSION = 1;
const MIN_ATTR_KWH = 0.001;

/**
 * Local calendar days (Area tz) that a `[startMs, endMs]` window covers, where `endMs` is the INCLUSIVE
 * last interval-end of the final day. For `dayToUnixRangeForAggregation` that boundary is 00:00 of the
 * NEXT calendar day, so mapping it with `toDay(endMs)` would roll to `newest+1` — making the rollup
 * write an extra trailing day BEYOND the loaded/folded window. In the backward batch loop of
 * `recompute-provenance` that extra day is the previous batch's OLDEST; recomputing it with no timeline
 * coverage yields an empty matrix whose delete-then-insert WIPES the correct rows (one lost day per
 * batch seam). Stepping back 1 ms keeps the range on the day that owns the boundary interval.
 */
export function localDaysInRange(
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
  const last = toDay(endMs - 1);
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

/**
 * Learn η(t) for an Area's battery from its RAW charge/discharge over a STABLE window (fixed anchor → now)
 * and persist it as the helper's round-trip-efficiency point (per local-day step: agg_5m + KV). Learning
 * from a fixed anchor + fixed seed makes η(day) reproducible — any later bounded re-fold READS the same
 * η(t) (via inputs.etaSeries) instead of re-learning it, so repair-convergence holds. Fold-independent (η
 * is a function of raw throughput, not the blend). The best-effort caller (recompute.ts) wraps this.
 */
export async function learnAndPersistEta(
  db: PgDb,
  handle: number,
  nowMs: number,
): Promise<{ pointId: number | null; daysWritten: number }> {
  const tp = await loadBatteryThroughput(handle, {
    startMs: ETA_ANCHOR_MS,
    endMs: nowMs,
  });
  if (!tp || tp.timeline.length < 2) return { pointId: null, daysWritten: 0 };

  const learned = learnEwmaEta(
    tp.chargeKwh,
    tp.dischargeKwh,
    tp.timeline,
    tp.timezoneOffsetMin,
    { prior: ETA_SEED, excludeDays: recalDaysFor(tp) },
  );

  const helperSystemId = await ensureHelperDevice(tp.areaId);
  const pointId = await ensureEfficiencyPoint(helperSystemId, true);
  if (pointId == null) return { pointId: null, daysWritten: 0 };
  const bind = await ensureEfficiencyBinding(
    tp.areaId,
    helperSystemId,
    pointId,
  );
  if (bind.created > 0) {
    try {
      await buildSubscriptionRegistry();
    } catch (e) {
      console.warn("[BatProv:eta] subscription registry rebuild skipped:", e);
    }
  }

  // Persist η as a per-local-day STEP: write each day's η at the FIRST interval_end of that day so a
  // forward-fill on read (load.ts) carries it across the day.
  const offMs = tp.timezoneOffsetMin * 60_000;
  const dayOf = (t: number) => Math.floor((t + offMs - 1) / 86_400_000);
  const firstTsByDay = new Map<number, number>();
  for (const t of tp.timeline) {
    const d = dayOf(t);
    if (!firstTsByDay.has(d)) firstTsByDay.set(d, t);
  }

  const rows: (typeof pointReadingsAgg5m.$inferInsert)[] = [];
  let latest: { value: number; tsMs: number } | null = null;
  for (const day of learned.byDay) {
    const ts = firstTsByDay.get(day.dayIndex);
    if (ts === undefined) continue;
    const pct = day.eta * 100; // stored as % (η×100); the loader ÷100 → the ratio the fold consumes
    rows.push({
      systemId: helperSystemId,
      pointId,
      intervalEnd: new Date(ts),
      avg: pct,
      min: pct,
      max: pct,
      last: pct,
      delta: null,
      sampleCount: 1,
      errorCount: 0,
      dataQuality: "good",
    });
    if (!latest || ts >= latest.tsMs) latest = { value: pct, tsMs: ts };
  }

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
          sampleCount: sql`excluded.sample_count`,
          dataQuality: sql`excluded.data_quality`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (latest) {
    await updateLatestPointValue(
      helperSystemId,
      pointId,
      `${BATTERY_STEM}/${ETA_METRIC}`,
      latest.value,
      latest.tsMs,
      Date.now(),
      ETA_UNIT,
      ETA_DISPLAY,
    );
  }

  return { pointId, daysWritten: rows.length };
}

/**
 * Learn usable capacity C(t) for an Area's battery from its discharge vs SoC over a STABLE window (fixed
 * anchor → now) and persist it as the helper's usable-capacity point (per local-day step: agg_5m + KV). Twin
 * of {@link learnAndPersistEta}: the fixed anchor + fixed seed make C(day) reproducible, so any later bounded
 * re-fold READS the same C(t) (via inputs.capacitySeries) instead of re-learning it — repair-convergence
 * holds and the minutely reconcile agrees with the daily heal. Fold-independent (C is measured from raw
 * discharge + SoC). Best-effort caller in recompute.ts. No-op (pointId null) for a SoC-blind battery.
 */
export async function learnAndPersistCapacity(
  db: PgDb,
  handle: number,
  nowMs: number,
): Promise<{ pointId: number | null; daysWritten: number }> {
  const tp = await loadBatteryThroughput(handle, {
    startMs: CAPACITY_ANCHOR_MS,
    endMs: nowMs,
  });
  if (!tp || tp.timeline.length < 2) return { pointId: null, daysWritten: 0 };
  // SoC-blind battery → no capacity to learn; the fold falls back to the pure power model.
  if (tp.soc.every((v) => v === null)) return { pointId: null, daysWritten: 0 };

  // Seed the EWMA from the window-global measured C (clamped), so a low-cycling battery whose days never
  // reach the per-day swing floor is still anchored to a plausible capacity rather than the constant.
  const seed = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? CAPACITY_SEED;
  const learned = learnEwmaCapacity(
    tp.dischargeKwh,
    tp.soc,
    tp.timeline,
    tp.timezoneOffsetMin,
    { prior: seed, excludeDays: recalDaysFor(tp) },
  );

  const helperSystemId = await ensureHelperDevice(tp.areaId);
  const pointId = await ensureCapacityPoint(helperSystemId, true);
  if (pointId == null) return { pointId: null, daysWritten: 0 };
  const bind = await ensureCapacityBinding(tp.areaId, helperSystemId, pointId);
  if (bind.created > 0) {
    try {
      await buildSubscriptionRegistry();
    } catch (e) {
      console.warn(
        "[BatProv:capacity] subscription registry rebuild skipped:",
        e,
      );
    }
  }

  // Persist C as a per-local-day STEP: write each day's C at the FIRST interval_end of that day so a
  // forward-fill on read (load.ts) carries it across the day.
  const offMs = tp.timezoneOffsetMin * 60_000;
  const dayOf = (t: number) => Math.floor((t + offMs - 1) / 86_400_000);
  const firstTsByDay = new Map<number, number>();
  for (const t of tp.timeline) {
    const d = dayOf(t);
    if (!firstTsByDay.has(d)) firstTsByDay.set(d, t);
  }

  const rows: (typeof pointReadingsAgg5m.$inferInsert)[] = [];
  let latest: { value: number; tsMs: number } | null = null;
  for (const day of learned.byDay) {
    const ts = firstTsByDay.get(day.dayIndex);
    if (ts === undefined) continue;
    const c = day.capacityKwh; // stored as kWh directly (no scaling, unlike η)
    rows.push({
      systemId: helperSystemId,
      pointId,
      intervalEnd: new Date(ts),
      avg: c,
      min: c,
      max: c,
      last: c,
      delta: null,
      sampleCount: 1,
      errorCount: 0,
      dataQuality: "good",
    });
    if (!latest || ts >= latest.tsMs) latest = { value: c, tsMs: ts };
  }

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
          sampleCount: sql`excluded.sample_count`,
          dataQuality: sql`excluded.data_quality`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (latest) {
    await updateLatestPointValue(
      helperSystemId,
      pointId,
      `${BATTERY_STEM}/${CAPACITY_METRIC}`,
      latest.value,
      latest.tsMs,
      Date.now(),
      CAPACITY_UNIT,
      CAPACITY_DISPLAY,
    );
  }

  return { pointId, daysWritten: rows.length };
}

/**
 * Learn the three-term loss model (charge-side η_c + constant idle drain; see `losses.ts`) for an Area's
 * battery over the STABLE window (fixed anchor → now) and persist it as the helper's charge-efficiency
 * (η_c×100, %) + idle-loss (kWh/day) points — per local-day steps, exactly like η/C. Runs AFTER the η and
 * C passes in the shell (it reads the same learned C convention). No-op for a SoC-blind battery or while
 * the fit is still in warm-up (nothing to persist → the fold stays on the single-η model).
 */
export async function learnAndPersistLosses(
  db: PgDb,
  handle: number,
  nowMs: number,
): Promise<{
  etaCPointId: number | null;
  idlePointId: number | null;
  daysWritten: number;
}> {
  const none = { etaCPointId: null, idlePointId: null, daysWritten: 0 };
  const tp = await loadBatteryThroughput(handle, {
    startMs: LOSSES_ANCHOR_MS,
    endMs: nowMs,
  });
  if (!tp || tp.timeline.length < 2) return none;
  if (tp.soc.every((v) => v === null)) return none;

  // The SAME deterministic C(t) the capacity pass persisted (same inputs, seed, and exclusions) — the
  // losses fit needs C to convert ΔSoC to kWh.
  const recalDays = recalDaysFor(tp);
  const seed = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? CAPACITY_SEED;
  const capacitySeries = learnEwmaCapacity(
    tp.dischargeKwh,
    tp.soc,
    tp.timeline,
    tp.timezoneOffsetMin,
    { prior: seed, excludeDays: recalDays },
  ).capacitySeries;

  const learned = learnLosses(
    tp.chargeKwh,
    tp.dischargeKwh,
    tp.soc,
    capacitySeries,
    tp.timeline,
    tp.timezoneOffsetMin,
  );
  if (learned.summaryEtaC === null) return none; // fit still in warm-up — nothing to persist

  const helperSystemId = await ensureHelperDevice(tp.areaId);
  const etaCPointId = await ensureParamPoint(
    helperSystemId,
    CHARGE_EFFICIENCY_POINT,
    true,
  );
  const idlePointId = await ensureParamPoint(
    helperSystemId,
    IDLE_LOSS_POINT,
    true,
  );
  if (etaCPointId == null || idlePointId == null) return none;
  const bindA = await ensureParamBinding(
    tp.areaId,
    helperSystemId,
    etaCPointId,
    CHARGE_EFFICIENCY_POINT,
    112,
  );
  const bindB = await ensureParamBinding(
    tp.areaId,
    helperSystemId,
    idlePointId,
    IDLE_LOSS_POINT,
    113,
  );
  if (bindA.created + bindB.created > 0) {
    try {
      await buildSubscriptionRegistry();
    } catch (e) {
      console.warn(
        "[BatProv:losses] subscription registry rebuild skipped:",
        e,
      );
    }
  }

  // Persist both as per-local-day STEPS at the first interval_end of each day (the η/C convention), only
  // for days the fit had values (warm-up days stay unwritten → the loader yields null → single-η there).
  const offMs = tp.timezoneOffsetMin * 60_000;
  const dayOf = (t: number) => Math.floor((t + offMs - 1) / 86_400_000);
  const firstTsByDay = new Map<number, number>();
  for (const t of tp.timeline) {
    const d = dayOf(t);
    if (!firstTsByDay.has(d)) firstTsByDay.set(d, t);
  }

  const rows: (typeof pointReadingsAgg5m.$inferInsert)[] = [];
  let latestEtaC: { value: number; tsMs: number } | null = null;
  let latestIdle: { value: number; tsMs: number } | null = null;
  for (const day of learned.byDay) {
    const ts = firstTsByDay.get(day.dayIndex);
    if (ts === undefined || day.etaC === null || day.idleKwhPerDay === null)
      continue;
    const pct = day.etaC * 100; // stored as % (η_c×100); the loader ÷100
    const idle = day.idleKwhPerDay;
    for (const [pointId, value] of [
      [etaCPointId, pct],
      [idlePointId, idle],
    ] as const) {
      rows.push({
        systemId: helperSystemId,
        pointId,
        intervalEnd: new Date(ts),
        avg: value,
        min: value,
        max: value,
        last: value,
        delta: null,
        sampleCount: 1,
        errorCount: 0,
        dataQuality: "good",
      });
    }
    if (!latestEtaC || ts >= latestEtaC.tsMs)
      latestEtaC = { value: pct, tsMs: ts };
    if (!latestIdle || ts >= latestIdle.tsMs)
      latestIdle = { value: idle, tsMs: ts };
  }

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
          sampleCount: sql`excluded.sample_count`,
          dataQuality: sql`excluded.data_quality`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (latestEtaC) {
    await updateLatestPointValue(
      helperSystemId,
      etaCPointId,
      `${BATTERY_STEM}/${CHARGE_EFFICIENCY_POINT.metricType}`,
      latestEtaC.value,
      latestEtaC.tsMs,
      Date.now(),
      CHARGE_EFFICIENCY_POINT.metricUnit,
      CHARGE_EFFICIENCY_POINT.displayName,
    );
  }
  if (latestIdle) {
    await updateLatestPointValue(
      helperSystemId,
      idlePointId,
      `${BATTERY_STEM}/${IDLE_LOSS_POINT.metricType}`,
      latestIdle.value,
      latestIdle.tsMs,
      Date.now(),
      IDLE_LOSS_POINT.metricUnit,
      IDLE_LOSS_POINT.displayName,
    );
  }

  return { etaCPointId, idlePointId, daysWritten: rows.length / 2 };
}
