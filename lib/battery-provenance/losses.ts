/**
 * Pure three-term loss estimator — NO database, NO clock, NO IO. Structural sibling of `eta.ts` /
 * `capacity.ts`.
 *
 * The single round-trip η (Σout/Σin) conflates three physically distinct loss terms. Reconciling the
 * SoC-implied stored energy against the metered charge/discharge registers day by day, a battery obeys
 *
 *   ΔSoC/100 · C  ≈  η_c · chargeKwh  −  dischargeKwh  −  idleKwhPerDay
 *
 * i.e. a CHARGE-side efficiency η_c (~0.94), a ~1:1 discharge (fixed ≡ 1 here — its small residual is
 * absorbed by the learned capacity C, avoiding the C/η_d degeneracy), and a constant IDLE/standby drain
 * (~0.5 kWh/day ≈ 20 W: BMS + balancing + self-discharge, proportional to TIME not throughput). This
 * module learns (η_c, idleKwhPerDay) with a causal expanding-window least-squares over per-local-day
 * sums: regress `y′ = ΔSoC·C/100 + discharge` on `charge` with an intercept — slope = η_c, intercept =
 * −idle. The pair APPLIED to a day is fitted from PRIOR qualifying days only (like the η/C EWMAs), so a
 * bounded re-fold reproduces a full-history run. Needs SoC + a capacity; SoC-blind history yields nulls
 * and the fold falls back to the single-η model, byte-identical.
 *
 * BMS RECALIBRATION days are excluded from the fit: a coulomb-counting BMS re-syncs SoC at full charge
 * (several pp in one interval with no matching metered energy — phantom energy that would bias every
 * estimator it touches). {@link detectRecalDayIndexes} finds them by tracking the metered net between
 * consecutive SoC observations; the same set should be passed to the η/C learners' `excludeDays`.
 */

const DAY_MS = 86_400_000;

export interface LossesLearnOptions {
  /** A day must charge at least this many kWh to enter the fit. Default 1. */
  minDayChargeKwh?: number;
  /** A day must have at least this many SoC-covered intervals to trust its ΔSoC. Default 200 (of 288). */
  minDaySocSamples?: number;
  /** Emit values only once this many qualifying days have accumulated (fit warm-up). Default 14. */
  minQualifyingDays?: number;
  /** Physical clamp band for η_c. Defaults 0.80 .. 1.0. */
  etaCClampMin?: number;
  etaCClampMax?: number;
  /** Clamp band for the idle drain (kWh/day). Defaults 0 .. 2. */
  idleClampMaxKwhPerDay?: number;
  /** Recal detection threshold (kWh) between consecutive SoC observations. Default 2. */
  recalThresholdKwh?: number;
}

/** Per-day losses diagnostic (the fit's inputs + the causally-applied pair). */
export interface LossesDayDiag {
  /** Local-day bucket index (days since local epoch; contiguous, comparable). */
  dayIndex: number;
  chargeKwh: number;
  dischargeKwh: number;
  /** SoC-implied stored-energy change for the day (ΔSoC/100·C, kWh), or null when SoC/C too thin. */
  socKwh: number | null;
  /** Day contains a BMS-recalibration event → excluded from the fit. */
  recal: boolean;
  /** Day entered the fit (throughput + SoC coverage + no recal). */
  qualified: boolean;
  /** The pair APPLIED to this day's intervals (causal: fitted from prior days), or null in warm-up. */
  etaC: number | null;
  idleKwhPerDay: number | null;
}

export interface LossesLearnResult {
  /** η_c per interval, index-aligned to `timelineMs` (null during warm-up / SoC-blind). */
  etaCSeries: (number | null)[];
  /** Idle drain per interval's DAY (kWh/day; the caller scales by Δt), aligned to `timelineMs`. */
  idleKwhPerDaySeries: (number | null)[];
  /** Per-day trend (ascending). */
  byDay: LossesDayDiag[];
  /** The latest applied pair (the current best estimate), or null when never enough data. */
  summaryEtaC: number | null;
  summaryIdleKwhPerDay: number | null;
  /** Local-day indexes containing a recal event — pass to the η/C learners' `excludeDays`. */
  recalDayIndexes: number[];
}

const clamp = (x: number, lo: number, hi: number) =>
  x < lo ? lo : x > hi ? hi : x;

/** End-exclusive local-day bucket (matches eta.ts / capacity.ts / the aggregation day boundaries). */
const dayBucketer = (tzOffsetMin: number) => {
  const offMs = tzOffsetMin * 60_000;
  return (t: number) => Math.floor((t + offMs - 1) / DAY_MS);
};

const capAt = (
  capacityKwh: number | (number | null)[],
  i: number,
): number | null =>
  typeof capacityKwh === "number" ? capacityKwh : (capacityKwh[i] ?? null);

/**
 * Local-day indexes containing a BMS-recalibration event: between two consecutive SoC OBSERVATIONS the
 * SoC-implied energy (ΔSoC/100·C) diverges from the metered net (Σcharge − Σdischarge; η-free — the
 * few-% η effect is far below the threshold) by more than `thresholdKwh`. Also catches SoC jumps across
 * data gaps (registers missed the energy → same phantom, same exclusion). Deterministic.
 */
export function detectRecalDayIndexes(
  chargeKwh: number[],
  dischargeKwh: number[],
  socPct: (number | null)[],
  capacityKwh: number | (number | null)[],
  timelineMs: number[],
  tzOffsetMin: number,
  thresholdKwh = 2,
): Set<number> {
  const dayOf = dayBucketer(tzOffsetMin);
  const out = new Set<number>();
  let prevSoc: number | null = null;
  let netSince = 0;
  for (let i = 0; i < timelineMs.length; i++) {
    netSince += (chargeKwh[i] ?? 0) - (dischargeKwh[i] ?? 0);
    const soc = socPct[i];
    const C = capAt(capacityKwh, i);
    if (soc === null || C === null || C <= 0) continue;
    if (prevSoc !== null) {
      const implied = ((soc - prevSoc) / 100) * C;
      if (Math.abs(implied - netSince) > thresholdKwh)
        out.add(dayOf(timelineMs[i]));
    }
    prevSoc = soc;
    netSince = 0;
  }
  return out;
}

/**
 * Learn (η_c, idleKwhPerDay) from per-interval charge/discharge energies + SoC + capacity. All inputs are
 * fold-independent (raw registers + the separately-learned C), so there is no circularity. Deterministic.
 */
export function learnLosses(
  chargeKwh: number[],
  dischargeKwh: number[],
  socPct: (number | null)[],
  capacityKwh: number | (number | null)[],
  timelineMs: number[],
  tzOffsetMin: number,
  opts: LossesLearnOptions = {},
): LossesLearnResult {
  const minDayCharge = opts.minDayChargeKwh ?? 1;
  const minSocSamples = opts.minDaySocSamples ?? 200;
  const minDays = opts.minQualifyingDays ?? 14;
  const clampMin = opts.etaCClampMin ?? 0.8;
  const clampMax = opts.etaCClampMax ?? 1.0;
  const idleMax = opts.idleClampMaxKwhPerDay ?? 2;
  const recalThreshold = opts.recalThresholdKwh ?? 2;
  const n = timelineMs.length;
  const empty: LossesLearnResult = {
    etaCSeries: new Array<number | null>(n).fill(null),
    idleKwhPerDaySeries: new Array<number | null>(n).fill(null),
    byDay: [],
    summaryEtaC: null,
    summaryIdleKwhPerDay: null,
    recalDayIndexes: [],
  };
  if (n === 0) return empty;

  const dayOf = dayBucketer(tzOffsetMin);
  const recalDays = detectRecalDayIndexes(
    chargeKwh,
    dischargeKwh,
    socPct,
    capacityKwh,
    timelineMs,
    tzOffsetMin,
    recalThreshold,
  );

  // Per-day sums, in ascending day order (timeline ascending → dayOf non-decreasing).
  interface DayAcc {
    dayIndex: number;
    chargeKwh: number;
    dischargeKwh: number;
    socFirst: number | null;
    socLast: number | null;
    socSamples: number;
    capacity: number | null;
  }
  const days: DayAcc[] = [];
  for (let i = 0; i < n; i++) {
    const d = dayOf(timelineMs[i]);
    const last = days[days.length - 1];
    if (!last || last.dayIndex !== d) {
      days.push({
        dayIndex: d,
        chargeKwh: 0,
        dischargeKwh: 0,
        socFirst: null,
        socLast: null,
        socSamples: 0,
        capacity: null,
      });
    }
    const cur = days[days.length - 1];
    cur.chargeKwh += chargeKwh[i] ?? 0;
    cur.dischargeKwh += dischargeKwh[i] ?? 0;
    const soc = socPct[i];
    if (soc !== null) {
      if (cur.socFirst === null) cur.socFirst = soc;
      cur.socLast = soc;
      cur.socSamples++;
    }
    if (cur.capacity === null) cur.capacity = capAt(capacityKwh, i);
  }

  // Causal expanding-window fit: the pair APPLIED to day d comes from qualifying days STRICTLY before d.
  // Regress y′ = socKwh + discharge on charge (normal equations with intercept), clamp the slope to the
  // physical band FIRST, then read the idle off the intercept (b = mean(y′) − η_c·mean(c); idle = −b) —
  // so a clamp never leaks charge-proportional loss into a bogus slope, only into the bounded idle term.
  let fN = 0;
  let fSc = 0;
  let fSy = 0;
  let fScc = 0;
  let fScy = 0;
  const appliedByDay = new Map<
    number,
    { etaC: number; idleKwhPerDay: number }
  >();
  const byDay: LossesDayDiag[] = [];
  let lastApplied: { etaC: number; idleKwhPerDay: number } | null = null;
  for (const d of days) {
    let applied: { etaC: number; idleKwhPerDay: number } | null = null;
    if (fN >= minDays) {
      const varC = fScc - (fSc * fSc) / fN;
      if (varC > 1e-9) {
        const slope = (fScy - (fSc * fSy) / fN) / varC;
        const etaC = clamp(slope, clampMin, clampMax);
        const b = (fSy - etaC * fSc) / fN;
        const idleKwhPerDay = clamp(-b, 0, idleMax);
        applied = { etaC, idleKwhPerDay };
      }
    }
    if (applied) {
      appliedByDay.set(d.dayIndex, applied);
      lastApplied = applied;
    }

    const recal = recalDays.has(d.dayIndex);
    const socKwh =
      d.socFirst !== null &&
      d.socLast !== null &&
      d.socSamples >= minSocSamples &&
      d.capacity !== null &&
      d.capacity > 0
        ? ((d.socLast - d.socFirst) / 100) * d.capacity
        : null;
    const qualified = socKwh !== null && d.chargeKwh >= minDayCharge && !recal;
    if (qualified) {
      const c = d.chargeKwh;
      const y = socKwh! + d.dischargeKwh;
      fN++;
      fSc += c;
      fSy += y;
      fScc += c * c;
      fScy += c * y;
    }

    byDay.push({
      dayIndex: d.dayIndex,
      chargeKwh: d.chargeKwh,
      dischargeKwh: d.dischargeKwh,
      socKwh,
      recal,
      qualified,
      etaC: applied?.etaC ?? null,
      idleKwhPerDay: applied?.idleKwhPerDay ?? null,
    });
  }

  const etaCSeries = new Array<number | null>(n).fill(null);
  const idleKwhPerDaySeries = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = appliedByDay.get(dayOf(timelineMs[i]));
    if (a) {
      etaCSeries[i] = a.etaC;
      idleKwhPerDaySeries[i] = a.idleKwhPerDay;
    }
  }

  return {
    etaCSeries,
    idleKwhPerDaySeries,
    byDay,
    summaryEtaC: lastApplied?.etaC ?? null,
    summaryIdleKwhPerDay: lastApplied?.idleKwhPerDay ?? null,
    recalDayIndexes: [...recalDays].sort((a, b) => a - b),
  };
}
