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
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lte,
  max,
  sql,
} from "drizzle-orm";
import { CalendarDate } from "@internationalized/date";
import { planetscaleDb } from "./index";
import {
  areaBindings,
  areas,
  batteryProvenanceDaily,
  pointReadingsAgg5m,
  pointReadingsFlowAttr1d,
} from "./schema";
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
  BATPROV_MODEL_VERSION,
  isPersistableFoldCheckpoint,
  localMidnightsInWindow,
  validateFoldCheckpointEnvelope,
  type FoldCheckpointEnvelope,
} from "@/lib/battery-provenance/checkpoint";
import {
  dayIndexOf,
  dayIndexToDayString,
} from "@/lib/battery-provenance/daily";
import {
  BLEND_POINTS,
  ensureBatteryProvenancePoints,
  ensureHelperBindings,
} from "@/lib/battery-provenance/register";
import { ensureHelperDevice } from "@/lib/areas/helper";
import type { ProvenanceConfig } from "@/lib/battery-provenance/types";
import type { FoldStep, FoldState } from "@/lib/battery-provenance/fold";
import type { LogicalSystem } from "@/lib/aggregation/logical-system";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Fold warm-up lead-in: enough to reach a reset (bottom-out) before the target window. */
export const WARMUP_MS = 7 * 24 * 3600 * 1000;

const BATTERY_STEM = "bidi.battery";
/** The blend value for a metricType from a fold step (null when the store is empty → not written).
 *  Exported for tests. */
export function blendValue(step: FoldStep, metricType: string): number | null {
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
      // The forgone-revenue component Qf/E, vended directly — the fold accumulates the delta natively
      // (forgoneC), no subtraction of full bases. The ≥ 0 the Contents card and device page present
      // comes from the producer pricing solar's forgone rate ≥ its actual cost, not a clamp here.
      return step.batteryPriceForgone;
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
  /** Fold checkpoints upserted into battery_provenance_daily (0 unless opts.writeCheckpoints). */
  checkpointsWritten: number;
}

/** True when every fold input came from PERSISTED (canonical, window-independent) series — a fold on
 *  any in-window learner is window-dependent and must never seed a checkpoint. SoC-dark areas need
 *  only η (the overlay/losses are inert there). */
function inputsAreCanonical(inputs: ProvenanceInputs): boolean {
  const socDark = inputs.soc.every((v) => v === null);
  return (
    inputs.etaSeries !== undefined &&
    (socDark ||
      (inputs.capacitySeries !== undefined &&
        inputs.chargeEfficiencySeries !== undefined &&
        inputs.idleLossKwhPerDaySeries !== undefined &&
        inputs.reserveFloorPctSeries !== undefined))
  );
}

/**
 * Recompute an Area's battery blend over [winStartMs, winEndMs] and UPSERT the three derived points'
 * agg_5m (+ KV latest when `updateLatest`). Registers the derived points if missing.
 *
 * With `writeCheckpoints` (the TRUSTED long-window paths only: the daily heal's recomputeRange and the
 * recompute-provenance API — never the minutely reconcile) it also persists the fold state at each
 * local midnight inside the write window into `battery_provenance_daily.fold_state`, enabling the
 * O(today) checkpoint-seeded reconcile. Checkpoints are skipped (best-effort, never aborts the blend)
 * when the inputs weren't canonical or a custom config was supplied.
 */
export async function recomputeBatteryProvenanceForWindow(
  db: PgDb,
  handle: number,
  winStartMs: number,
  winEndMs: number,
  opts: {
    updateLatest?: boolean;
    writeRollup?: boolean;
    writeCheckpoints?: boolean;
    config?: ProvenanceConfig;
  } = {},
): Promise<RecomputeResult> {
  const inputs = await loadProvenanceInputs(handle, {
    startMs: winStartMs - WARMUP_MS,
    endMs: winEndMs,
  });
  const empty = {
    rowsWritten: 0,
    helperSystemId: null,
    pointIds: {},
    attrRowsWritten: 0,
    checkpointsWritten: 0,
  };
  if (!inputs) return empty;
  const hasBattery = inputs.batterySystemId != null;
  // A battery-less Area has no blend/fold to materialise, but the rollup still records its (battery-
  // less) energy + grid/solar attribution so flow_attr_1d covers every logical system, not only battery
  // Areas (it is the sole per-(area, day) flow matrix since flow_1d was retired).
  const unifiedRollup = !!opts.writeRollup;
  if (!hasBattery && !unifiedRollup) return empty;

  // Midnights to checkpoint: strictly inside the WRITE window (a midnight at/before winStartMs falls in
  // the warm-up region — checkpoint quality == blend-row quality by construction). Gated on canonical
  // inputs + a pristine config (custom-config runs must not poison checkpoints). Battery-only: a
  // battery-less Area has no fold state worth persisting.
  const midnights =
    hasBattery &&
    opts.writeCheckpoints &&
    !opts.config &&
    inputsAreCanonical(inputs)
      ? localMidnightsInWindow(winStartMs, winEndMs, inputs.timezoneOffsetMin)
      : [];

  const result = computeBatteryProvenance(inputs, opts.config, {
    snapshotAtMs: midnights.map((m) => m.midnightMs),
  });

  // Blend outputs (helper agg_5m + KV latest) are battery-only — a battery-less Area has no helper
  // blend point, so skip them entirely (and never mint a helper device for a solar-only Area).
  const blend = hasBattery
    ? await writeBlendOutputs(db, inputs, result, winStartMs, winEndMs, {
        updateLatest: !!opts.updateLatest,
      })
    : {
        rowsWritten: 0,
        helperSystemId: null as number | null,
        pointIds: {} as Record<string, number>,
      };

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

  // Fold checkpoints (best-effort — never aborts the blend write above).
  let checkpointsWritten = 0;
  if (midnights.length > 0 && result.stateSnapshots?.length) {
    try {
      const dayByMidnight = new Map(
        midnights.map((m) => [m.midnightMs, m.day]),
      );
      const envs: { day: string; env: FoldCheckpointEnvelope }[] = [];
      for (const snap of result.stateSnapshots) {
        const day = dayByMidnight.get(snap.requestedMs);
        if (day === undefined) continue;
        envs.push({
          day,
          env: {
            v: BATPROV_MODEL_VERSION,
            midnightMs: snap.requestedMs,
            anchorMs: snap.anchorMs,
            reserveFloorPct: result.reserveUsed,
            etaFallback: result.etaUsed,
            state: snap.state,
          },
        });
      }
      checkpointsWritten = await upsertFoldCheckpoints(db, inputs.areaId, envs);
    } catch (e) {
      console.warn("[BatProv] checkpoint write failed:", e);
    }
  }

  return {
    rowsWritten: blend.rowsWritten,
    helperSystemId: blend.helperSystemId,
    pointIds: blend.pointIds,
    attrRowsWritten,
    checkpointsWritten,
  };
}

/**
 * The SHARED blend writer — the only code that materialises fold output into the serving store, used by
 * both the warm-up recompute above and the checkpoint-seeded reconcile (so the two paths can never
 * drift in write semantics: dq flag, stored-energy 0-vs-null, chunking, KV latest shape).
 *
 * The blend belongs to the AREA, not a physical child device — it lives on the Area's HELPER device.
 * Ensures the helper exists, registers the blend points on it, and binds them into the Area (so they
 * fan out to the Area's KV latest and appear in its resolved point set); rebuilds the KV subscription
 * registry only when bindings were newly created.
 */
async function writeBlendOutputs(
  db: PgDb,
  inputs: ProvenanceInputs,
  result: ProvenanceResult,
  winStartMs: number,
  winEndMs: number,
  opts: { updateLatest: boolean },
): Promise<{
  rowsWritten: number;
  helperSystemId: number;
  pointIds: Record<string, number>;
}> {
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

  return {
    rowsWritten: rows.length,
    helperSystemId,
    pointIds: ensure.pointIds,
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
    writeCheckpoints?: boolean;
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
      `[BatProv] handle=${handle} helper=${r.helperSystemId} rows=${r.rowsWritten}` +
        (opts.writeCheckpoints ? ` checkpoints=${r.checkpointsWritten}` : ""),
    );
  } catch (err) {
    console.error(`[BatProv] recompute failed for handle=${handle}:`, err);
  }
}

// ── Fold checkpoints + the O(today) seeded reconcile (see lib/battery-provenance/checkpoint.ts) ──

/** How far back the seeded reconcile will chain from (the heal writes TODAY's checkpoint just after
 *  local midnight; between midnight and heal completion — or on a failed heal night — yesterday's, or
 *  the day before's, still gives an O(≤2-day) fold). */
const SEED_LOOKBACK_DAYS = 2;
/** Hard cap on the seeded span; beyond it the warm-up fallback is the safer path. */
const MAX_SEED_SPAN_MS = 3.5 * 24 * 3600 * 1000;
/** The staleness probe looks this far back before the anchor for post-checkpoint agg_5m rewrites. */
const PROBE_LOOKBACK_MS = 12 * 3600 * 1000;

/** Upsert checkpoint envelopes into battery_provenance_daily, setting ONLY {fold_state, updated_at} on
 *  conflict — the learn owns every other column (a checkpoint-only insert leaves them at defaults with
 *  first_interval_end NULL, which the learn treats as absent). Refuses non-finite envelopes. */
async function upsertFoldCheckpoints(
  db: PgDb,
  areaId: string,
  envs: { day: string; env: FoldCheckpointEnvelope }[],
): Promise<number> {
  let written = 0;
  for (const { day, env } of envs) {
    if (!isPersistableFoldCheckpoint(env)) {
      console.warn(
        `[BatProv] non-persistable checkpoint (non-finite state) skipped: area=${areaId} day=${day}`,
      );
      continue;
    }
    await db
      .insert(batteryProvenanceDaily)
      .values({ areaId, day, foldState: env })
      .onConflictDoUpdate({
        target: [batteryProvenanceDaily.areaId, batteryProvenanceDaily.day],
        set: { foldState: env, updatedAt: sql`now()` },
      });
    written++;
  }
  return written;
}

/** The freshest trusted checkpoint ≤ `todayDay`, within the lookback: validated envelope with
 *  `v === BATPROV_MODEL_VERSION` (a model bump silently distrusts every stored checkpoint). */
async function loadLatestFoldCheckpoint(
  db: PgDb,
  areaId: string,
  todayDayIndex: number,
): Promise<{ env: FoldCheckpointEnvelope; writtenAt: Date } | null> {
  const rows = await db
    .select({
      foldState: batteryProvenanceDaily.foldState,
      updatedAt: batteryProvenanceDaily.updatedAt,
    })
    .from(batteryProvenanceDaily)
    .where(
      and(
        eq(batteryProvenanceDaily.areaId, areaId),
        gte(
          batteryProvenanceDaily.day,
          dayIndexToDayString(todayDayIndex - SEED_LOOKBACK_DAYS),
        ),
        lte(batteryProvenanceDaily.day, dayIndexToDayString(todayDayIndex)),
        isNotNull(batteryProvenanceDaily.foldState),
      ),
    )
    .orderBy(desc(batteryProvenanceDaily.day))
    .limit(SEED_LOOKBACK_DAYS + 1);
  for (const r of rows) {
    const env = validateFoldCheckpointEnvelope(r.foldState);
    if (env && env.v === BATPROV_MODEL_VERSION)
      return { env, writtenAt: r.updatedAt };
  }
  return null;
}

export type SeededReconcileOutcome =
  | { seeded: true; rowsWritten: number; anchorMs: number }
  | { seeded: false; reason: string };

/**
 * The O(today) blend reconcile: seed the fold with the freshest checkpoint and read only
 * (anchor → now] — ~1.5-5k agg_5m rows instead of the warm-up path's ~25k, bounded forever.
 * Re-folding from the ANCHOR each tick (not from the last tick) self-heals late intra-day data with
 * zero invalidation bookkeeping. Every guard failure returns `{seeded:false}` so the caller can run
 * the unchanged 12h+7d warm-up fallback — this path must NEVER be less safe than the old one.
 * Writes blend agg_5m + KV latest only (no rollup, no checkpoints).
 */
export async function reconcileBatteryProvenanceFromCheckpoint(
  db: PgDb,
  handle: number,
  nowMs: number,
  opts: { config?: ProvenanceConfig } = {},
): Promise<SeededReconcileOutcome> {
  // A custom config invalidates the checkpoint's assumptions (it was written config-pristine).
  if (opts.config && Object.keys(opts.config).length > 0)
    return { seeded: false, reason: "custom-config" };

  const [area] = await db
    .select({ id: areas.id, tz: areas.timezoneOffsetMin })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) return { seeded: false, reason: "no-area" };

  const cp = await loadLatestFoldCheckpoint(
    db,
    area.id,
    dayIndexOf(nowMs, area.tz),
  );
  if (!cp) return { seeded: false, reason: "no-checkpoint" };
  const { env } = cp;
  if (nowMs - env.anchorMs > MAX_SEED_SPAN_MS)
    return { seeded: false, reason: "span-too-long" };

  // Staleness probe: did anything rewrite the battery input's agg_5m at/just-before the anchor AFTER
  // the checkpoint was written (a backfill/repair of yesterday)? One bounded PK-range read on the
  // battery power point — the same input-watermark proxy blendIsCurrent uses. (Deliberately not probed:
  // pre-anchor rate/OE revisions — those heal at the nightly heal; see the PR notes.)
  const [powerBind] = await db
    .select({
      sys: areaBindings.pointSystemId,
      pid: areaBindings.pointId,
    })
    .from(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, area.id),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    .limit(1);
  if (!powerBind) return { seeded: false, reason: "no-battery-bind" };
  const [probe] = await db
    .select({ maxUpdated: max(pointReadingsAgg5m.updatedAt) })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, powerBind.sys),
        eq(pointReadingsAgg5m.pointId, powerBind.pid),
        gt(
          pointReadingsAgg5m.intervalEnd,
          new Date(env.anchorMs - PROBE_LOOKBACK_MS),
        ),
        lte(pointReadingsAgg5m.intervalEnd, new Date(env.anchorMs)),
      ),
    );
  if (probe?.maxUpdated && probe.maxUpdated > cp.writtenAt)
    return { seeded: false, reason: "pre-anchor-rewrite" };

  const inputs = await loadProvenanceInputs(handle, {
    startMs: env.anchorMs,
    endMs: nowMs,
  });
  if (!inputs || inputs.batterySystemId == null)
    return { seeded: false, reason: "no-inputs" };
  // The learners' params must still be persisted (canonical) — a fold on in-window learners cannot be
  // seeded reproducibly. The reserve floor is now persisted too (reserveFloorPctSeries, checked in
  // inputsAreCanonical), so the seeded fold reads it FRESH from the daily table — no env replay needed.
  if (!inputsAreCanonical(inputs))
    return { seeded: false, reason: "non-canonical-inputs" };

  const result = computeBatteryProvenance(
    inputs,
    {},
    { initialState: env.state, efficiencyFallback: env.etaFallback },
  );
  const blend = await writeBlendOutputs(
    db,
    inputs,
    result,
    env.anchorMs,
    nowMs,
    { updateLatest: true },
  );
  return {
    seeded: true,
    rowsWritten: blend.rowsWritten,
    anchorMs: env.anchorMs,
  };
}

/** Best-effort wrapper: null (→ caller falls back) on any throw. */
export async function reconcileFromCheckpointBestEffort(
  handle: number,
  nowMs: number,
  opts: { config?: ProvenanceConfig } = {},
): Promise<SeededReconcileOutcome | null> {
  if (!planetscaleDb) return null;
  try {
    return await reconcileBatteryProvenanceFromCheckpoint(
      planetscaleDb,
      handle,
      nowMs,
      opts,
    );
  } catch (err) {
    console.error(
      `[BatProv] seeded reconcile failed for handle=${handle}:`,
      err,
    );
    return null;
  }
}

export type ProvenanceSeedResult =
  | {
      seeded: true;
      inputs: ProvenanceInputs;
      initialState: FoldState;
      efficiencyFallback: number;
      anchorMs: number;
    }
  | { seeded: false; reason: string };

/**
 * Read-only counterpart to {@link reconcileBatteryProvenanceFromCheckpoint} for an arbitrary
 * caller-supplied `[targetStartMs, endMs]` window — no "now" requirement, never writes. Seeds the fold
 * from the freshest checkpoint at/before `targetStartMs`'s local day and loads provenance inputs from
 * the checkpoint's anchor instead of a full `WARMUP_MS` lead-in, so an on-the-fly compute (the Sankey
 * tooltip's attributed matrix, `buildAttributedFlowMatrix`) can skip the 7-day warm-up on every
 * sub-daily request. Reuses the exact guard sequence the checkpointed reconcile trusts (span cap,
 * pre-anchor staleness probe, canonical-inputs check) — every guard failure returns `{seeded:false}`
 * so the caller can fall back to the unseeded `WARMUP_MS` load; this path must never be less safe than
 * that fallback.
 */
export async function tryLoadSeededProvenanceInputs(
  db: PgDb,
  handle: number,
  targetStartMs: number,
  endMs: number,
  logicalSystem?: LogicalSystem,
): Promise<ProvenanceSeedResult> {
  const [area] = await db
    .select({ id: areas.id, tz: areas.timezoneOffsetMin })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) return { seeded: false, reason: "no-area" };

  const cp = await loadLatestFoldCheckpoint(
    db,
    area.id,
    dayIndexOf(targetStartMs, area.tz),
  );
  if (!cp) return { seeded: false, reason: "no-checkpoint" };
  const { env } = cp;
  if (env.anchorMs > targetStartMs)
    return { seeded: false, reason: "anchor-after-window-start" };
  if (endMs - env.anchorMs > MAX_SEED_SPAN_MS)
    return { seeded: false, reason: "span-too-long" };

  // Staleness probe: did anything rewrite the battery input's agg_5m at/just-before the anchor AFTER
  // the checkpoint was written (a backfill/repair)? Same input-watermark proxy the checkpointed
  // reconcile uses.
  const [powerBind] = await db
    .select({
      sys: areaBindings.pointSystemId,
      pid: areaBindings.pointId,
    })
    .from(areaBindings)
    .where(
      and(
        eq(areaBindings.areaId, area.id),
        eq(areaBindings.role, "battery"),
        eq(areaBindings.metricType, "power"),
      ),
    )
    .limit(1);
  if (!powerBind) return { seeded: false, reason: "no-battery-bind" };
  const [probe] = await db
    .select({ maxUpdated: max(pointReadingsAgg5m.updatedAt) })
    .from(pointReadingsAgg5m)
    .where(
      and(
        eq(pointReadingsAgg5m.systemId, powerBind.sys),
        eq(pointReadingsAgg5m.pointId, powerBind.pid),
        gt(
          pointReadingsAgg5m.intervalEnd,
          new Date(env.anchorMs - PROBE_LOOKBACK_MS),
        ),
        lte(pointReadingsAgg5m.intervalEnd, new Date(env.anchorMs)),
      ),
    );
  if (probe?.maxUpdated && probe.maxUpdated > cp.writtenAt)
    return { seeded: false, reason: "pre-anchor-rewrite" };

  const inputs = await loadProvenanceInputs(
    handle,
    { startMs: env.anchorMs, endMs },
    { logicalSystem },
  );
  if (!inputs) return { seeded: false, reason: "no-inputs" };
  if (!inputsAreCanonical(inputs))
    return { seeded: false, reason: "non-canonical-inputs" };

  return {
    seeded: true,
    inputs,
    initialState: env.state,
    efficiencyFallback: env.etaFallback,
    anchorMs: env.anchorMs,
  };
}
