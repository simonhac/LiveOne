/**
 * Pure usable-capacity (C) estimator — NO database, NO clock, NO IO. Structural twin of `eta.ts`.
 *
 * `C` is the battery's USABLE capacity in kWh across the full 0→100 % SoC span, measured from the RAW
 * charge/discharge energies against the SoC swing they produced — entirely INDEPENDENT of the blend fold
 * (raw energies + SoC → C(t) → fold; no circularity). It lets the fold pin its reset-relative inventory
 * `E` to the physical usable energy `targetE = (SoC − reserveFloor)/100 · C`, so a battery that never
 * empties still tracks physical stored energy instead of drifting until the backstop dumps it.
 *
 * Deliverable convention: `E` grows by `η·charge`, so `C` is measured in DELIVERABLE kWh — on a charging
 * move we credit `η·charge` per SoC-point risen; on a discharging move we credit `discharge` per point
 * dropped (discharge already IS the deliverable side). Aggregated per LOCAL day (the Area's fixed offset),
 * clamped to a physical band, trusted only when the day swung enough SoC, and smoothed with a causal daily
 * EWMA (the value APPLIED to a day is learned from PRIOR days) — so a mid-life capacity change appears as a
 * step in the per-day series, preserving the "no static nameplate" property (C is learned, never configured).
 */

const DAY_MS = 86_400_000;

export interface CapacityLearnOptions {
  /** Daily EWMA weight (0..1). Small = slow. Default 0.1 (~10-day time constant). */
  alpha?: number;
  /** Seed C (day-0 value + fallback), kWh. Callers pass the window-global slope. Default 15. */
  prior?: number;
  /** A day must swing at least this many SoC points (summed |ΔSoC| over trusted moves) to update. Default 20. */
  minDaySocSwingPct?: number;
  /** Physical clamp band for a day's raw C (kWh). Defaults 2 .. 100. */
  clampMin?: number;
  clampMax?: number;
  /**
   * Local-day indexes whose raw C must NOT update the EWMA (BMS-recalibration days — the phantom SoC
   * step corrupts the day's discharge÷down-swing slope; see `losses.ts#detectRecalDayIndexes`). The
   * applied C still covers them (carried from prior days). Default: none (behaviour unchanged).
   */
  excludeDays?: ReadonlySet<number>;
}

/** Per-day capacity diagnostic (the "usable-capacity trend"; a step is a hardware/capacity change). */
export interface CapacityDayDiag {
  /** Local-day bucket index (days since local epoch; contiguous, comparable). */
  dayIndex: number;
  /** Summed |ΔSoC| (pp) over the day's trusted charge/discharge moves. */
  swingPct: number;
  /** Raw deliverable-kWh-per-100pp for the day (clamped), or null when the day swung too little SoC. */
  rawC: number | null;
  /** The smoothed C actually APPLIED to this day's intervals (causal: learned from prior days), kWh. */
  capacityKwh: number;
}

export interface CapacityLearnResult {
  /** C per interval, index-aligned to `timelineMs` (the applied causal EWMA). */
  capacitySeries: number[];
  /** Per-day trend (ascending). */
  byDay: CapacityDayDiag[];
  /** Swing-weighted mean of `capacitySeries` — a single summary C for reporting/diagnostics. */
  summary: number;
}

const clamp = (x: number, lo: number, hi: number) =>
  x < lo ? lo : x > hi ? hi : x;

/** One local day's capacity-fit inputs: the RAIL-GATED pair sums (a per-day reduction — see `daily.ts`). */
export interface CapacityDayInput {
  dayIndex: number;
  /** Σdischarge over trusted pairs (both SoCs non-null & < 98) — NOT the day's ungated discharge. */
  capDischargeKwh: number;
  /** Σ max(0, ΔSoC↓) over the same trusted pairs (pp). */
  downSwingPct: number;
  /** Day must not update the EWMA (BMS-recal day) — the applied C still covers it. */
  excluded?: boolean;
}

/**
 * The causal daily-EWMA fit over per-day pair sums — THE single implementation of the C fold
 * ({@link learnEwmaCapacity} delegates here; the cached-day learn calls it directly). The C applied to
 * a day is the value learned from PRIOR days only. Deterministic.
 */
export function learnCapacityFromDays(
  days: CapacityDayInput[],
  opts: Omit<CapacityLearnOptions, "excludeDays"> = {},
): { byDay: CapacityDayDiag[] } {
  const alpha = opts.alpha ?? 0.1;
  const prior = opts.prior ?? 15;
  const minDaySwing = opts.minDaySocSwingPct ?? 20;
  const clampMin = opts.clampMin ?? 2;
  const clampMax = opts.clampMax ?? 100;

  // Causal daily EWMA: apply the C learned from PRIOR days to the current day, then fold today's raw C in.
  let ewma = prior;
  const byDay: CapacityDayDiag[] = [];
  for (const d of days) {
    const applied = ewma;
    let rawC: number | null = null;
    if (d.downSwingPct >= minDaySwing && d.downSwingPct > 0 && !d.excluded) {
      rawC = clamp(
        (100 * d.capDischargeKwh) / d.downSwingPct,
        clampMin,
        clampMax,
      );
      ewma = alpha * rawC + (1 - alpha) * ewma;
    }
    byDay.push({
      dayIndex: d.dayIndex,
      swingPct: d.downSwingPct,
      rawC,
      capacityKwh: applied,
    });
  }
  return { byDay };
}

/**
 * Learn a per-interval usable capacity C(t) from the battery's discharge energy + SoC. `dischargeKwh[i]`
 * is the deliverable energy leaving the battery at interval `i`; `socPct[i]` the SoC (%). Fold-independent
 * (SoC + discharge only — the charge side is deliberately unused; see the accumulation note). Deterministic.
 */
export function learnEwmaCapacity(
  dischargeKwh: number[],
  socPct: (number | null)[],
  timelineMs: number[],
  tzOffsetMin: number,
  opts: CapacityLearnOptions = {},
): CapacityLearnResult {
  const alpha = opts.alpha ?? 0.1;
  const prior = opts.prior ?? 15;
  const minDaySwing = opts.minDaySocSwingPct ?? 20;
  const clampMin = opts.clampMin ?? 2;
  const clampMax = opts.clampMax ?? 100;
  const n = timelineMs.length;
  if (n === 0) return { capacitySeries: [], byDay: [], summary: prior };

  const offMs = tzOffsetMin * 60_000;
  // End-exclusive local-day bucket (matches eta.ts / the aggregation day boundaries).
  const dayOf = timelineMs.map((t) => Math.floor((t + offMs - 1) / DAY_MS));

  // Per-day sums, in ascending day order. Capacity pairs the day's DELIVERABLE energy OUT (Σdischarge) with
  // the SoC it DROPPED (Σ down-swing): `C = 100 · Σdischarge / Σ max(0, ΔSoC↓)`. This is unbiased regardless
  // of the day's charge/discharge balance — a net-drain day and a net-charge day both measure the same C —
  // whereas dividing by the FULL |ΔSoC| (assuming balanced cycling) reads up to 2× high on a monotonic-drain
  // day. Rails skipped (SoC ≥ 98: near-full charge doesn't move SoC linearly). Robust to simultaneous
  // charge+discharge only at aggregate (day) scale.
  const days: { dayIndex: number; num: number; swing: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d = dayOf[i];
    const last = days[days.length - 1];
    if (!last || last.dayIndex !== d) {
      days.push({ dayIndex: d, num: 0, swing: 0 });
    }
    const cur = days[days.length - 1];
    if (i === 0) continue;
    const s0 = socPct[i - 1];
    const s1 = socPct[i];
    if (s0 === null || s1 === null || s0 >= 98 || s1 >= 98) continue;
    cur.num += dischargeKwh[i] ?? 0;
    if (s0 > s1) cur.swing += s0 - s1; // pair discharge with the DOWN-swing only
  }

  // Delegate the causal daily-EWMA fold to the single day-level implementation.
  const { byDay } = learnCapacityFromDays(
    days.map((d) => ({
      dayIndex: d.dayIndex,
      capDischargeKwh: d.num,
      downSwingPct: d.swing,
      excluded: opts.excludeDays?.has(d.dayIndex) ?? false,
    })),
    { alpha, prior, minDaySocSwingPct: minDaySwing, clampMin, clampMax },
  );
  const appliedByDay = new Map<number, number>();
  for (const d of byDay) appliedByDay.set(d.dayIndex, d.capacityKwh);

  const capacitySeries = dayOf.map((d) => appliedByDay.get(d) ?? prior);

  // Swing-weighted summary (falls back to the prior when nothing swung).
  let wsum = 0;
  let w = 0;
  for (let i = 1; i < n; i++) {
    const s0 = socPct[i - 1];
    const s1 = socPct[i];
    if (s0 === null || s1 === null) continue;
    const sw = Math.abs(s1 - s0);
    wsum += capacitySeries[i] * sw;
    w += sw;
  }
  const summary = w > 0 ? wsum / w : prior;

  return { capacitySeries, byDay, summary };
}

/** A window has to drop at least this much SoC (summed) before its capacity slope is trustworthy — guards
 *  the seed against a degenerate window (flat/stale SoC + a discharge burst) blowing up to ∞. */
const MIN_WINDOW_DOWN_SWING_PCT = 20;

/**
 * The seed math over ALREADY-SUMMED rail-gated pair totals: C₀ = 100·Σdischarge / Σ(down-swing), gated
 * and clamped. The gated sums are additive over days, so summing cached per-day reductions
 * (`daily.ts#BatteryDayReduction`) and calling this reproduces {@link measureWindowCapacity} exactly.
 */
export function measureWindowCapacityFromSums(
  capDischargeKwh: number,
  downSwingPct: number,
  clampMin = 2,
  clampMax = 100,
): number | null {
  if (downSwingPct < MIN_WINDOW_DOWN_SWING_PCT) return null;
  return clamp((100 * capDischargeKwh) / downSwingPct, clampMin, clampMax);
}

/**
 * Window-global usable-capacity slope C₀ = 100·Σdischarge / Σ(down-swing) — the self-calibrating seed for
 * {@link learnEwmaCapacity} (mirrors how η seeds from the window-global Σout/Σin). CLAMPED to the physical
 * band and gated on a minimum down-swing, so a pathological bootstrap window can never arm the SoC overlay
 * with an over-unity capacity. Returns null when SoC coverage is too thin (caller falls back to a constant).
 */
export function measureWindowCapacity(
  dischargeKwh: number[],
  socPct: (number | null)[],
  clampMin = 2,
  clampMax = 100,
): number | null {
  let num = 0;
  let swing = 0;
  for (let i = 1; i < socPct.length; i++) {
    const s0 = socPct[i - 1];
    const s1 = socPct[i];
    if (s0 === null || s1 === null || s0 >= 98 || s1 >= 98) continue;
    num += dischargeKwh[i] ?? 0;
    if (s0 > s1) swing += s0 - s1;
  }
  return measureWindowCapacityFromSums(num, swing, clampMin, clampMax);
}
