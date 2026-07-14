/**
 * Pure round-trip-efficiency (η) estimator — NO database, NO clock, NO IO.
 *
 * η is measured from the battery's RAW charge/discharge energies (Σout/Σin), which are entirely
 * INDEPENDENT of the blend fold — so there is no circularity: raw energies → η(t) → fold. A single
 * window-global Σout/Σin is dominated by the window's net ΔSoC boundary term (a window that ends fuller
 * than it started reads η too high, emptier reads it too low), so instead we learn a slowly-moving,
 * time-varying η(t):
 *
 *   - group intervals into LOCAL days (the Area's fixed offset);
 *   - per day, raw η_d = Σdischarge_d / Σcharge_d, clamped to a physical band and only trusted when the
 *     day moved enough energy (thin days are noise and don't update the estimate);
 *   - smooth with a causal daily EWMA: the η applied to a day is the value LEARNED FROM PRIOR DAYS
 *     (day 0 uses the seed prior), so early intervals show the learning period and later ones track the
 *     slow drift (temperature / C-rate / ageing). A hardware step (e.g. a capacity change) shows up as a
 *     step in the per-day series.
 *
 * The caller seeds `prior` with the window-global measured η (falling back to a datasheet ~0.90 when the
 * window moved too little energy). That keeps a SHORT recompute window near its own measured value
 * (non-regressive vs. the old single-scalar η) while a LONG window gets the full learned trajectory.
 */

const DAY_MS = 86_400_000;

export interface EtaLearnOptions {
  /** Daily EWMA weight (0..1). Small = slow (time constant ≈ 1/alpha days). Default 0.1 (~10-day). */
  alpha?: number;
  /** Seed η (day-0 value + fallback). Default 0.90 (datasheet). Callers pass window-measured η. */
  prior?: number;
  /** A day must charge at least this many kWh for its raw η to update the EWMA. Default 1.0. */
  minDayChargeKwh?: number;
  /** Physical clamp band for a day's raw η. Defaults 0.70 .. 1.0. */
  clampMin?: number;
  clampMax?: number;
  /**
   * Local-day indexes whose raw η must NOT update the EWMA (BMS-recalibration days, where phantom SoC
   * energy skews the registers' meaning — see `losses.ts#detectRecalDayIndexes`). The applied η still
   * covers them (carried from prior days). Default: none (behaviour unchanged).
   */
  excludeDays?: ReadonlySet<number>;
}

/** Per-day η diagnostic (the "degradation trend" — a slow decline is ageing, a step is a hardware change). */
export interface EtaDayDiag {
  /** Local-day bucket index (days since local epoch; contiguous, comparable, not a calendar string). */
  dayIndex: number;
  chargeKwh: number;
  dischargeKwh: number;
  /** Raw Σout/Σin for the day (clamped), or null when the day moved too little energy to trust. */
  rawEta: number | null;
  /** The smoothed η actually APPLIED to this day's intervals (causal: learned from prior days). */
  eta: number;
}

export interface EtaLearnResult {
  /** η per interval, index-aligned to `timelineMs`. Feed each into its interval's fold. */
  etaSeries: number[];
  /** Per-day trend (ascending). */
  byDay: EtaDayDiag[];
  /** Throughput-weighted mean of `etaSeries` — a single summary η for reporting/diagnostics. */
  summary: number;
}

const clamp = (x: number, lo: number, hi: number) =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * Learn a per-interval η(t) from raw charge/discharge energies. `chargeKwh[i]` is the TOTAL charge
 * (solar + grid + other) into the battery at interval `i`; `dischargeKwh[i]` the discharge. Both are
 * fold-independent. Deterministic.
 */
export function learnEwmaEta(
  chargeKwh: number[],
  dischargeKwh: number[],
  timelineMs: number[],
  tzOffsetMin: number,
  opts: EtaLearnOptions = {},
): EtaLearnResult {
  const alpha = opts.alpha ?? 0.1;
  const prior = opts.prior ?? 0.9;
  const minDayCharge = opts.minDayChargeKwh ?? 1.0;
  const clampMin = opts.clampMin ?? 0.7;
  const clampMax = opts.clampMax ?? 1.0;
  const n = timelineMs.length;
  if (n === 0) return { etaSeries: [], byDay: [], summary: prior };

  const offMs = tzOffsetMin * 60_000;
  // End-exclusive local-day bucket: an interval ENDING exactly at local midnight belongs to the day
  // that just finished (matches the aggregation day boundaries).
  const dayOf = timelineMs.map((t) => Math.floor((t + offMs - 1) / DAY_MS));

  // Per-day sums, in ascending day order (timeline is ascending → dayOf is non-decreasing).
  const days: { dayIndex: number; chargeKwh: number; dischargeKwh: number }[] =
    [];
  for (let i = 0; i < n; i++) {
    const d = dayOf[i];
    const last = days[days.length - 1];
    if (!last || last.dayIndex !== d) {
      days.push({ dayIndex: d, chargeKwh: 0, dischargeKwh: 0 });
    }
    const cur = days[days.length - 1];
    cur.chargeKwh += chargeKwh[i] ?? 0;
    cur.dischargeKwh += dischargeKwh[i] ?? 0;
  }

  // Causal daily EWMA: apply the η learned from PRIOR days to the current day, then fold today's raw η in.
  let ewma = prior;
  const appliedByDay = new Map<number, number>();
  const byDay: EtaDayDiag[] = [];
  for (const d of days) {
    const applied = ewma;
    appliedByDay.set(d.dayIndex, applied);
    let rawEta: number | null = null;
    if (
      d.chargeKwh >= minDayCharge &&
      d.chargeKwh > 0 &&
      !opts.excludeDays?.has(d.dayIndex)
    ) {
      rawEta = clamp(d.dischargeKwh / d.chargeKwh, clampMin, clampMax);
      ewma = alpha * rawEta + (1 - alpha) * ewma;
    }
    byDay.push({
      dayIndex: d.dayIndex,
      chargeKwh: d.chargeKwh,
      dischargeKwh: d.dischargeKwh,
      rawEta,
      eta: applied,
    });
  }

  const etaSeries = dayOf.map((d) => appliedByDay.get(d) ?? prior);

  // Throughput-weighted summary (falls back to the prior when nothing charged).
  let wsum = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const c = chargeKwh[i] ?? 0;
    wsum += etaSeries[i] * c;
    w += c;
  }
  const summary = w > 0 ? wsum / w : prior;

  return { etaSeries, byDay, summary };
}
