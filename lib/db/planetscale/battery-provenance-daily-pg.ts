/**
 * Battery-provenance daily-state driver — owns everything that touches `battery_provenance_daily`
 * (one row per battery Area per local day; see the table doc in schema.ts).
 *
 * `learnAllForHandle` is THE learn: it replaces the old three `learnAndPersist{Eta,Capacity,Losses}`
 * passes (each of which re-read full history from agg_5m — 3× ~380k rows per handle per run). It
 * maintains the per-day reduced-input cache incrementally (append new days + re-reduce a trailing
 * window + agg_1d-probe-invalidated suffixes; O(days-changed) agg_5m reads), then runs the pure
 * day-level fits over the ~330 cached rows (microseconds) and persists the applied per-day params
 * (η / C / η_c / idle) onto the same rows. Ordering η → C → losses is structurally enforced here.
 *
 * The fits reproduce the old per-interval learners exactly (equivalence-tested in
 * lib/battery-provenance/__tests__/daily-{reduce,fits}.test.ts); the one deliberate change is the
 * recal-flag convention unification (window-scalar C everywhere — see daily.ts).
 */

import { and, asc, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  batteryProvenanceDaily,
  pointReadingsAgg1d,
  type BatteryProvenanceDailyRow,
} from "@/lib/db/planetscale/schema";
import {
  boundPoints,
  loadBatteryThroughput,
  type BoundPoint,
} from "@/lib/battery-provenance/load";
import {
  reduceThroughputToDays,
  sliceThroughput,
  dayIndexOf,
  dayIndexRangeMs,
  dayIndexToDayString,
  dayStringToDayIndex,
  EMPTY_CARRY,
  type BatteryDayReduction,
  type DayCarry,
} from "@/lib/battery-provenance/daily";
import { learnEtaFromDays } from "@/lib/battery-provenance/eta";
import {
  learnCapacityFromDays,
  measureWindowCapacity,
  measureWindowCapacityFromSums,
} from "@/lib/battery-provenance/capacity";
import { learnLossesFromDays } from "@/lib/battery-provenance/losses";

type PgDb = NonNullable<typeof planetscaleDb>;

/** Learn everything causally from this stable anchor (the LiveOne birthdate) — matches the old
 *  ETA/CAPACITY/LOSSES_ANCHOR_MS, so params stay reproducible run-over-run. */
export const LEARN_ANCHOR_MS = Date.parse("2025-08-16T00:00:00Z");
/** Fixed datasheet seed for the η EWMA — a CONSTANT (not window-measured) so η(day) is reproducible. */
const ETA_SEED = 0.9;
/** Fallback capacity seed (kWh) when the window's SoC swing is too thin to measure a slope. */
const CAPACITY_SEED = 15;
/** Reduce-algorithm version. Bump when the reduction semantics change (daily.ts) — a mismatch on any
 *  cached row triggers a full input rebuild. Distinct from the CHECKPOINT model version, which lives
 *  inside fold_state.v. */
export const BATTERY_DAILY_VERSION = 1;
/** Always re-reduce this many trailing local days (absorbs late-arriving data near the tip). */
const TRAILING_REREDUCE_DAYS = 3;
/** agg_1d probe: a cached day is dirty when its stored register baseline moved by more than this. */
const PROBE_TOLERANCE_KWH = 0.02;
/** SoC forward-fill limit in the throughput loader — the lead-in a bounded reduce read needs. */
const SOC_LEAD_IN_MS = 30 * 60 * 1000;

const toKwh = (v: number | null, unit: string | null) =>
  v === null ? null : unit === "Wh" ? v / 1000 : v;

/** In-memory working row: a reduction + probe baselines + the fitted params. */
interface DailyLearnRow extends BatteryDayReduction {
  probeChargeKwh: number | null;
  probeDischargeKwh: number | null;
  eta: number | null;
  capacityKwh: number | null;
  chargeEff: number | null;
  idleLossKwhDay: number | null;
}

function fromDbRow(r: BatteryProvenanceDailyRow): DailyLearnRow {
  return {
    dayIndex: dayStringToDayIndex(r.day),
    firstIntervalEndMs: r.firstIntervalEnd
      ? r.firstIntervalEnd.getTime()
      : Number.NaN,
    intervalCount: r.intervalCount,
    chargeKwh: r.chargeKwh,
    dischargeKwh: r.dischargeKwh,
    socFirst: r.socFirst,
    socLast: r.socLast,
    socSamples: r.socSamples,
    capDischargeKwh: r.capDischargeKwh,
    downSwingPct: r.downSwingPct,
    recal: r.recal,
    socLastSlotPct: r.socLastSlotPct,
    socCarryPct: r.socCarryPct,
    netAfterSocKwh: r.netAfterSocKwh,
    probeChargeKwh: r.probeChargeKwh,
    probeDischargeKwh: r.probeDischargeKwh,
    eta: r.eta,
    capacityKwh: r.capacityKwh,
    chargeEff: r.chargeEff,
    idleLossKwhDay: r.idleLossKwhDay,
  };
}

async function readAllDayRows(
  db: PgDb,
  areaId: string,
): Promise<BatteryProvenanceDailyRow[]> {
  return db
    .select()
    .from(batteryProvenanceDaily)
    .where(eq(batteryProvenanceDaily.areaId, areaId))
    .orderBy(asc(batteryProvenanceDaily.day));
}

/** Upsert full learn rows (inputs + carries + probes + params). NEVER touches fold_state/created_at —
 *  the Phase-B checkpoint column belongs to the blend recompute. */
async function upsertDayRows(
  db: PgDb,
  areaId: string,
  rows: DailyLearnRow[],
): Promise<number> {
  const values = rows.map((r) => ({
    areaId,
    day: dayIndexToDayString(r.dayIndex),
    firstIntervalEnd: Number.isNaN(r.firstIntervalEndMs)
      ? null
      : new Date(r.firstIntervalEndMs),
    intervalCount: r.intervalCount,
    chargeKwh: r.chargeKwh,
    dischargeKwh: r.dischargeKwh,
    socFirst: r.socFirst,
    socLast: r.socLast,
    socSamples: r.socSamples,
    capDischargeKwh: r.capDischargeKwh,
    downSwingPct: r.downSwingPct,
    recal: r.recal,
    socLastSlotPct: r.socLastSlotPct,
    socCarryPct: r.socCarryPct,
    netAfterSocKwh: r.netAfterSocKwh,
    probeChargeKwh: r.probeChargeKwh,
    probeDischargeKwh: r.probeDischargeKwh,
    eta: r.eta,
    capacityKwh: r.capacityKwh,
    chargeEff: r.chargeEff,
    idleLossKwhDay: r.idleLossKwhDay,
    version: BATTERY_DAILY_VERSION,
  }));
  const CHUNK = 1000;
  for (let off = 0; off < values.length; off += CHUNK) {
    await db
      .insert(batteryProvenanceDaily)
      .values(values.slice(off, off + CHUNK))
      .onConflictDoUpdate({
        target: [batteryProvenanceDaily.areaId, batteryProvenanceDaily.day],
        set: {
          firstIntervalEnd: sql`excluded.first_interval_end`,
          intervalCount: sql`excluded.interval_count`,
          chargeKwh: sql`excluded.charge_kwh`,
          dischargeKwh: sql`excluded.discharge_kwh`,
          socFirst: sql`excluded.soc_first`,
          socLast: sql`excluded.soc_last`,
          socSamples: sql`excluded.soc_samples`,
          capDischargeKwh: sql`excluded.cap_discharge_kwh`,
          downSwingPct: sql`excluded.down_swing_pct`,
          recal: sql`excluded.recal`,
          socLastSlotPct: sql`excluded.soc_last_slot_pct`,
          socCarryPct: sql`excluded.soc_carry_pct`,
          netAfterSocKwh: sql`excluded.net_after_soc_kwh`,
          probeChargeKwh: sql`excluded.probe_charge_kwh`,
          probeDischargeKwh: sql`excluded.probe_discharge_kwh`,
          eta: sql`excluded.eta`,
          capacityKwh: sql`excluded.capacity_kwh`,
          chargeEff: sql`excluded.charge_eff`,
          idleLossKwhDay: sql`excluded.idle_loss_kwh_day`,
          version: sql`excluded.version`,
          updatedAt: sql`now()`,
        },
      });
  }
  return values.length;
}

/** Delete cached rows in [fromDay, toDay] whose day vanished from the re-reduce (its agg_5m data was
 *  removed) — keeps the cache an honest mirror without touching rows outside the swept range. */
async function deleteVanishedDays(
  db: PgDb,
  areaId: string,
  fromDay: string,
  toDay: string,
  keepDays: string[],
): Promise<void> {
  const conds = [
    eq(batteryProvenanceDaily.areaId, areaId),
    gte(batteryProvenanceDaily.day, fromDay),
    lte(batteryProvenanceDaily.day, toDay),
  ];
  if (keepDays.length > 0)
    conds.push(notInArray(batteryProvenanceDaily.day, keepDays));
  await db.delete(batteryProvenanceDaily).where(and(...conds));
}

/** Read the agg_1d deltas of the bound charge/discharge energy registers for the given days (the
 *  invalidation-probe source — ~1 tiny indexed row per register per day). */
async function readAgg1dBaselines(
  db: PgDb,
  chargeBind: BoundPoint | undefined,
  dischargeBind: BoundPoint | undefined,
  fromDay: string,
): Promise<Map<string, { charge: number | null; discharge: number | null }>> {
  const out = new Map<
    string,
    { charge: number | null; discharge: number | null }
  >();
  if (!chargeBind || !dischargeBind) return out;
  for (const [bind, key] of [
    [chargeBind, "charge"],
    [dischargeBind, "discharge"],
  ] as const) {
    const rows = await db
      .select({ day: pointReadingsAgg1d.day, delta: pointReadingsAgg1d.delta })
      .from(pointReadingsAgg1d)
      .where(
        and(
          eq(pointReadingsAgg1d.systemId, bind.systemId),
          eq(pointReadingsAgg1d.pointId, bind.pointId),
          gte(pointReadingsAgg1d.day, fromDay),
        ),
      );
    for (const r of rows) {
      const cur = out.get(r.day) ?? { charge: null, discharge: null };
      cur[key] = toKwh(r.delta, bind.unit);
      out.set(r.day, cur);
    }
  }
  return out;
}

/** Days whose stored probe baseline disagrees with agg_1d now (late data / re-aggregation of a past
 *  day). Missing-vs-missing is clean; null↔number is a mismatch. */
function probeMismatchDays(
  rows: DailyLearnRow[],
  baselines: Map<string, { charge: number | null; discharge: number | null }>,
): number[] {
  const dirty: number[] = [];
  for (const r of rows) {
    const day = dayIndexToDayString(r.dayIndex);
    const b = baselines.get(day) ?? { charge: null, discharge: null };
    for (const [stored, now] of [
      [r.probeChargeKwh, b.charge],
      [r.probeDischargeKwh, b.discharge],
    ] as const) {
      if (stored === null && now === null) continue;
      if (
        stored === null ||
        now === null ||
        Math.abs(stored - now) > PROBE_TOLERANCE_KWH
      ) {
        dirty.push(r.dayIndex);
        break;
      }
    }
  }
  return dirty;
}

export interface LearnAllResult {
  areaId: string | null;
  mode: "rebuild" | "incremental" | "no-data";
  /** Days re-reduced from agg_5m this run (the O(Δ) part). */
  daysReduced: number;
  /** Total cached days the fits ran over. */
  daysTotal: number;
  /** Rows with η written (the old `learnedEtaDays` analogue). */
  etaDays: number;
  seedCapacityKwh: number | null;
  latest: {
    eta: number | null;
    capacityKwh: number | null;
    etaC: number | null;
    idleKwhPerDay: number | null;
  };
}

const NO_DATA: LearnAllResult = {
  areaId: null,
  mode: "no-data",
  daysReduced: 0,
  daysTotal: 0,
  etaDays: 0,
  seedCapacityKwh: null,
  latest: { eta: null, capacityKwh: null, etaC: null, idleKwhPerDay: null },
};

/**
 * THE battery-provenance learn for one Area: maintain the per-day input cache, fit η → C → losses over
 * it, persist the applied params. `rebuild: true` forces a from-scratch reduce (full-history activation,
 * deep backfills, reduce-algorithm changes); otherwise the cache is maintained incrementally and only
 * the suffix from the earliest dirty day (append ∪ trailing-K ∪ agg_1d-probe mismatches) is re-read
 * from agg_5m — re-reducing everything downstream of the earliest change makes the carry-cascade
 * automatic.
 */
export async function learnAllForHandle(
  db: PgDb,
  handle: number,
  nowMs: number,
  opts: { rebuild?: boolean } = {},
): Promise<LearnAllResult> {
  const [area] = await db
    .select({ id: areas.id, tz: areas.timezoneOffsetMin })
    .from(areas)
    .where(eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) return NO_DATA;
  const tz = area.tz;

  const bound = await boundPoints(db, area.id);
  if (!bound.some((b) => b.role === "battery" && b.metric === "power"))
    return { ...NO_DATA, areaId: area.id };
  const chargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.charge",
  );
  const dischargeBind = bound.find(
    (b) => b.metric === "energy" && b.stem === "bidi.battery.discharge",
  );
  const hasRegisters = !!chargeBind && !!dischargeBind;

  const cachedDb = await readAllDayRows(db, area.id);
  // Checkpoint-only rows (fold_state written before the learn ever filled the day) have no anchor —
  // they are not learn state; treat them as absent for reduce/fit purposes.
  const cached = cachedDb
    .filter((r) => r.firstIntervalEnd !== null)
    .map(fromDbRow);
  const rebuild =
    !!opts.rebuild ||
    cached.length === 0 ||
    cachedDb.some((r) => r.version !== BATTERY_DAILY_VERSION);

  const nowDay = dayIndexOf(nowMs, tz);

  // ── Plan the reduce: the contiguous suffix [fromDay, nowDay] that must be re-read from agg_5m ──
  let fromDay: number; // first day to re-reduce
  let baselines = new Map<
    string,
    { charge: number | null; discharge: number | null }
  >();
  if (rebuild) {
    fromDay = dayIndexOf(LEARN_ANCHOR_MS + 1, tz);
    if (hasRegisters)
      baselines = await readAgg1dBaselines(
        db,
        chargeBind,
        dischargeBind,
        dayIndexToDayString(fromDay),
      );
  } else {
    const maxCachedDay = cached[cached.length - 1].dayIndex;
    fromDay = Math.min(maxCachedDay + 1, nowDay - TRAILING_REREDUCE_DAYS + 1);
    if (hasRegisters) {
      baselines = await readAgg1dBaselines(
        db,
        chargeBind,
        dischargeBind,
        dayIndexToDayString(cached[0].dayIndex),
      );
      const dirty = probeMismatchDays(
        cached.filter((r) => r.dayIndex < fromDay),
        baselines,
      );
      if (dirty.length > 0) fromDay = Math.min(fromDay, ...dirty);
    }
    fromDay = Math.max(fromDay, dayIndexOf(LEARN_ANCHOR_MS + 1, tz));
  }

  // ── Reduce the suffix (ONE bounded throughput read; SoC lead-in keeps the fill exact) ──
  const [fromStartEx] = dayIndexRangeMs(fromDay, tz);
  const loadStartMs = rebuild
    ? LEARN_ANCHOR_MS
    : Math.max(LEARN_ANCHOR_MS, fromStartEx - SOC_LEAD_IN_MS);
  const tp = await loadBatteryThroughput(handle, {
    startMs: loadStartMs,
    endMs: nowMs,
  });
  const prefix = cached.filter((r) => r.dayIndex < fromDay);
  // Rebuild sweeps vanished days over the whole cached range (a rebuild is exactly when history may
  // have been rewritten); incremental sweeps only the re-reduced suffix.
  const sweepFromDay = rebuild
    ? Math.min(cached[0]?.dayIndex ?? fromDay, fromDay)
    : fromDay;
  if (!tp || tp.timeline.length < 2) {
    // No throughput in the suffix window. On a rebuild that means no data at all.
    if (rebuild || prefix.length === 0) return { ...NO_DATA, areaId: area.id };
    return fitAndPersist(db, area.id, prefix, [], sweepFromDay, nowDay, {
      mode: "incremental",
      soCBlind: prefix.every((r) => r.socSamples === 0),
    });
  }

  const slice = rebuild ? tp : sliceThroughput(tp, fromStartEx);
  const carryIn: DayCarry = rebuild
    ? EMPTY_CARRY
    : (prefix[prefix.length - 1] ?? EMPTY_CARRY);
  // Recal detection uses the WINDOW-GLOBAL capacity scalar (the recalDaysFor convention). Rebuild
  // measures it from the full window; incremental derives it from the cached sums (additive).
  const recalC = rebuild
    ? (measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? CAPACITY_SEED)
    : (measureWindowCapacityFromSums(
        prefix.reduce((a, r) => a + r.capDischargeKwh, 0),
        prefix.reduce((a, r) => a + r.downSwingPct, 0),
      ) ?? CAPACITY_SEED);

  const reductions = reduceThroughputToDays(slice, tz, carryIn, recalC);
  const reduced: DailyLearnRow[] = reductions.map((r) => {
    const b = baselines.get(dayIndexToDayString(r.dayIndex));
    return {
      ...r,
      probeChargeKwh: hasRegisters ? (b?.charge ?? null) : null,
      probeDischargeKwh: hasRegisters ? (b?.discharge ?? null) : null,
      eta: null,
      capacityKwh: null,
      chargeEff: null,
      idleLossKwhDay: null,
    };
  });

  const socBlind =
    prefix.every((r) => r.socSamples === 0) &&
    slice.soc.every((v) => v === null);

  return fitAndPersist(db, area.id, prefix, reduced, sweepFromDay, nowDay, {
    mode: rebuild ? "rebuild" : "incremental",
    soCBlind: socBlind,
  });
}

/** Fit η → C → losses over the merged rows, persist, and clean vanished days. */
async function fitAndPersist(
  db: PgDb,
  areaId: string,
  prefix: DailyLearnRow[],
  reduced: DailyLearnRow[],
  sweepFromDay: number,
  nowDay: number,
  info: { mode: "rebuild" | "incremental"; soCBlind: boolean },
): Promise<LearnAllResult> {
  const rows = [...prefix, ...reduced];
  if (rows.length === 0) return { ...NO_DATA, areaId, mode: info.mode };

  // Capacity seed from the summed rail-gated pair totals — identical (mod float associativity) to the
  // old measureWindowCapacity(tp) over the full anchor→now window.
  const seed =
    measureWindowCapacityFromSums(
      rows.reduce((a, r) => a + r.capDischargeKwh, 0),
      rows.reduce((a, r) => a + r.downSwingPct, 0),
    ) ?? CAPACITY_SEED;

  // η — learned even SoC-blind (matches the old learnAndPersistEta).
  const etaByDay = learnEtaFromDays(
    rows.map((r) => ({ ...r, excluded: r.recal })),
    { prior: ETA_SEED },
  ).byDay;

  // C + losses — no-ops for a SoC-blind battery (match the old guards: params stay null).
  let capByDay: { capacityKwh: number }[] | null = null;
  let lossByDay:
    | { etaC: number | null; idleKwhPerDay: number | null }[]
    | null = null;
  if (!info.soCBlind) {
    capByDay = learnCapacityFromDays(
      rows.map((r) => ({
        dayIndex: r.dayIndex,
        capDischargeKwh: r.capDischargeKwh,
        downSwingPct: r.downSwingPct,
        excluded: r.recal,
      })),
      { prior: seed },
    ).byDay;
    const losses = learnLossesFromDays(
      rows.map((r, i) => ({
        dayIndex: r.dayIndex,
        chargeKwh: r.chargeKwh,
        dischargeKwh: r.dischargeKwh,
        socFirst: r.socFirst,
        socLast: r.socLast,
        socSamples: r.socSamples,
        capacityKwh: capByDay![i].capacityKwh,
        recal: r.recal,
      })),
    );
    // While the fit is in warm-up nothing is persisted (the old summaryEtaC === null early-return).
    lossByDay = losses.summaryEtaC === null ? null : losses.byDay;
  }

  for (let i = 0; i < rows.length; i++) {
    rows[i].eta = etaByDay[i].eta;
    rows[i].capacityKwh = capByDay ? capByDay[i].capacityKwh : null;
    rows[i].chargeEff = lossByDay ? lossByDay[i].etaC : null;
    rows[i].idleLossKwhDay = lossByDay ? lossByDay[i].idleKwhPerDay : null;
  }

  await upsertDayRows(db, areaId, rows);
  if (reduced.length > 0) {
    await deleteVanishedDays(
      db,
      areaId,
      dayIndexToDayString(sweepFromDay),
      dayIndexToDayString(nowDay),
      reduced.map((r) => dayIndexToDayString(r.dayIndex)),
    );
  }

  const last = rows[rows.length - 1];
  return {
    areaId,
    mode: info.mode,
    daysReduced: reduced.length,
    daysTotal: rows.length,
    etaDays: rows.length,
    seedCapacityKwh: seed,
    latest: {
      eta: last.eta,
      capacityKwh: last.capacityKwh,
      etaC: last.chargeEff,
      idleKwhPerDay: last.idleLossKwhDay,
    },
  };
}

// ── Read-back helper (the monitor consumes this instead of the old param points; the loader reads
//    the param series inline in load.ts — importing this module there would be circular) ──

/**
 * The loss-model "armed" probe for the SoC↔meter monitor: the latest non-null η_c / idle / C from rows
 * within the trailing `maxAgeDays`. Null when any of the three is missing/stale ⇒ unarmed.
 */
export async function latestArmedDailyParams(
  db: PgDb,
  areaId: string,
  nowMs: number,
  tzOffsetMin: number,
  maxAgeDays = 7,
): Promise<{
  etaC: number;
  idleKwhPerDay: number;
  capacityKwh: number;
} | null> {
  const fromDay = dayIndexToDayString(
    dayIndexOf(nowMs, tzOffsetMin) - maxAgeDays,
  );
  const rows = await db
    .select({
      capacityKwh: batteryProvenanceDaily.capacityKwh,
      chargeEff: batteryProvenanceDaily.chargeEff,
      idleLossKwhDay: batteryProvenanceDaily.idleLossKwhDay,
    })
    .from(batteryProvenanceDaily)
    .where(
      and(
        eq(batteryProvenanceDaily.areaId, areaId),
        gte(batteryProvenanceDaily.day, fromDay),
      ),
    )
    .orderBy(asc(batteryProvenanceDaily.day));

  let etaC: number | null = null;
  let idle: number | null = null;
  let cap: number | null = null;
  for (const r of rows) {
    if (r.chargeEff !== null) etaC = r.chargeEff;
    if (r.idleLossKwhDay !== null) idle = r.idleLossKwhDay;
    if (r.capacityKwh !== null) cap = r.capacityKwh;
  }
  if (etaC === null || idle === null || cap === null) return null;
  return { etaC, idleKwhPerDay: idle, capacityKwh: cap };
}
