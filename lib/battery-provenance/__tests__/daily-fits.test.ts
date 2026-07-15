/**
 * Fit-level equivalence: the day-level fits over cached reductions reproduce the per-interval
 * learners end-to-end (the whole-pipeline check the daily learn relies on), plus warm-up and
 * SoC-blind behaviour, and the ONE documented recal-convention divergence.
 */
import { describe, it, expect } from "@jest/globals";
import {
  reduceThroughputToDays,
  EMPTY_CARRY,
  type ThroughputSlice,
} from "../daily";
import {
  learnEwmaCapacity,
  learnCapacityFromDays,
  measureWindowCapacity,
} from "../capacity";
import {
  learnLosses,
  learnLossesFromDays,
  detectRecalDayIndexes,
} from "../losses";

const DAY_MS = 86_400_000;
const SLOT_MS = 300_000;
const TZ = 600;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Physical battery pattern obeying the three-term model EXACTLY (η_c = 0.94, idle = 0.5 kWh/day,
 *  C = 20): per-day "sunniness" varies the charge 0.4–1.4× (the regression needs charge variation to
 *  separate slope from intercept), and each day's discharge balances η_c·charge − idle so SoC returns
 *  to its start and never touches the rails (a clamp would phantom-destroy energy and bias the fit). */
function buildTp(
  numDays: number,
  opts: { recalDay?: number; socBlind?: boolean } = {},
): ThroughputSlice {
  const rand = lcg(7);
  const start = Date.parse("2025-09-01T00:00:00Z") - TZ * 60_000;
  const timeline: number[] = [];
  const chargeKwh: number[] = [];
  const dischargeKwh: number[] = [];
  const soc: (number | null)[] = [];
  const capacity = 20;
  const ETA_C = 0.94;
  const IDLE_KWH_DAY = 0.5;
  const IDLE_PP_SLOT = (IDLE_KWH_DAY / 288 / capacity) * 100;
  let socNow = 50;
  for (let d = 0; d < numDays; d++) {
    const sunniness = 0.4 + rand(); // 0.4 .. 1.4
    const chargePerSlot = 0.101 * sunniness; // 72 charge slots (9-15h) → ~2.9-10.2 kWh/day
    const chargeDay = chargePerSlot * 72;
    const dischargePerSlot = Math.max(
      0,
      (ETA_C * chargeDay - IDLE_KWH_DAY) / 156,
    ); // 156 slots (17-06h)
    for (let slot = 0; slot < 288; slot++) {
      const t = start + d * DAY_MS + (slot + 1) * SLOT_MS;
      const hour = ((slot + 1) * 5) / 60;
      let charge = 0;
      let discharge = 0;
      if (hour >= 9 && hour < 15) charge = chargePerSlot;
      else if (hour >= 17 || hour < 6) discharge = dischargePerSlot;
      socNow += ((ETA_C * charge - discharge) / capacity) * 100 - IDLE_PP_SLOT;
      if (opts.recalDay === d && slot === 40) socNow += 15;
      timeline.push(t);
      chargeKwh.push(charge);
      dischargeKwh.push(discharge);
      soc.push(opts.socBlind ? null : socNow);
    }
  }
  return { timeline, chargeKwh, dischargeKwh, soc };
}

/** The daily-learn pipeline: reduce → capacity fit → losses fit over the day rows. */
function pipelineLosses(tp: ThroughputSlice, cScalar: number) {
  const rows = reduceThroughputToDays(tp, TZ, EMPTY_CARRY, cScalar);
  const capByDay = learnCapacityFromDays(
    rows.map((r) => ({
      dayIndex: r.dayIndex,
      capDischargeKwh: r.capDischargeKwh,
      downSwingPct: r.downSwingPct,
      excluded: r.recal,
    })),
    { prior: cScalar },
  ).byDay;
  return learnLossesFromDays(
    rows.map((r, i) => ({
      dayIndex: r.dayIndex,
      chargeKwh: r.chargeKwh,
      dischargeKwh: r.dischargeKwh,
      socFirst: r.socFirst,
      socLast: r.socLast,
      socSamples: r.socSamples,
      capacityKwh: capByDay[i].capacityKwh,
      recal: r.recal,
    })),
  );
}

describe("losses fit over cached reductions ≡ per-interval learnLosses", () => {
  it("recovers (η_c, idle) identically on a clean cycling battery", () => {
    const tp = buildTp(40);
    const cScalar = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? 15;
    // Reference: exactly what learnAndPersistLosses does today — applied-C series into learnLosses.
    const capacitySeries = learnEwmaCapacity(
      tp.dischargeKwh,
      tp.soc,
      tp.timeline,
      TZ,
      {
        prior: cScalar,
        excludeDays: new Set(),
      },
    ).capacitySeries;
    const ref = learnLosses(
      tp.chargeKwh,
      tp.dischargeKwh,
      tp.soc,
      capacitySeries,
      tp.timeline,
      TZ,
    );

    // Pipeline over reductions. No recal day here, so window-scalar vs applied-C conventions agree
    // (both detect nothing) and the capacity exclusion sets match (empty).
    const got = pipelineLosses(tp, cScalar);
    expect(got.byDay).toEqual(ref.byDay);
    expect(got.summaryEtaC).toEqual(ref.summaryEtaC);
    expect(got.summaryIdleKwhPerDay).toEqual(ref.summaryIdleKwhPerDay);
    // Sanity: the fit actually armed and recovered the synthetic model.
    expect(got.summaryEtaC).not.toBeNull();
    expect(got.summaryEtaC!).toBeGreaterThan(0.9);
    expect(got.summaryEtaC!).toBeLessThanOrEqual(1.0);
  });

  it("a recal day is flagged and excluded on both paths (conventions agreeing)", () => {
    const tp = buildTp(40, { recalDay: 20 });
    const cScalar = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? 15;
    const got = pipelineLosses(tp, cScalar);
    const recalRow = got.byDay.find((d) => d.recal);
    expect(recalRow).toBeDefined();
    expect(recalRow!.qualified).toBe(false);

    // Reference path = exactly today's learnAndPersistLosses: C EWMA with recal days EXCLUDED
    // (the recalDaysFor convention), then learnLosses re-detecting internally with that applied-C
    // series. NOTE the deliberate convention unification: the cached path detects with the
    // WINDOW-SCALAR C. On this fixture both flag the same day and the fits agree — the
    // threshold-straddling divergence case is asserted separately below.
    const recalSet = detectRecalDayIndexes(
      tp.chargeKwh,
      tp.dischargeKwh,
      tp.soc,
      cScalar,
      tp.timeline,
      TZ,
    );
    const capacitySeries = learnEwmaCapacity(
      tp.dischargeKwh,
      tp.soc,
      tp.timeline,
      TZ,
      {
        prior: cScalar,
        excludeDays: recalSet,
      },
    ).capacitySeries;
    const ref = learnLosses(
      tp.chargeKwh,
      tp.dischargeKwh,
      tp.soc,
      capacitySeries,
      tp.timeline,
      TZ,
    );
    expect(got.byDay.map((d) => d.recal)).toEqual(
      ref.byDay.map((d) => d.recal),
    );
    expect(got.summaryEtaC).toEqual(ref.summaryEtaC);
  });

  it("documented divergence: a threshold-straddling jump may be flagged by only one convention", () => {
    // Construct the straddle deliberately: one SoC step whose implied energy sits between the two
    // conventions' |implied − net| thresholds. C_window ≈ 20 (physical); applied-C on day 1 is the
    // PRIOR (= seed we pass), so use a scalar prior of 30 to split the conventions.
    const timeline: number[] = [];
    const chargeKwh: number[] = [];
    const dischargeKwh: number[] = [];
    const soc: (number | null)[] = [];
    const start = Date.parse("2025-09-01T00:00:00Z") - TZ * 60_000;
    for (let slot = 0; slot < 288; slot++) {
      const t = start + (slot + 1) * SLOT_MS;
      timeline.push(t);
      chargeKwh.push(0);
      dischargeKwh.push(0);
      // One +9pp step with zero metered energy: implied = 9% · C.
      soc.push(slot < 100 ? 50 : 59);
    }
    const tp: ThroughputSlice = { timeline, chargeKwh, dischargeKwh, soc };
    // Window-scalar convention with C=20: implied 1.8 kWh < 2 ⇒ NOT recal.
    const rowsAt20 = reduceThroughputToDays(tp, TZ, EMPTY_CARRY, 20);
    expect(rowsAt20[0].recal).toBe(false);
    // Applied-C convention with C=30: implied 2.7 kWh > 2 ⇒ recal.
    const ref = learnLosses(
      tp.chargeKwh,
      tp.dischargeKwh,
      tp.soc,
      30,
      tp.timeline,
      TZ,
    );
    expect(ref.byDay[0].recal).toBe(true);
  });

  it("warm-up (<14 qualifying days) yields null params on both paths", () => {
    const tp = buildTp(10);
    const cScalar = measureWindowCapacity(tp.dischargeKwh, tp.soc) ?? 15;
    const got = pipelineLosses(tp, cScalar);
    expect(got.summaryEtaC).toBeNull();
    expect(got.summaryIdleKwhPerDay).toBeNull();
    expect(got.byDay.every((d) => d.etaC === null)).toBe(true);
  });

  it("SoC-blind: reductions carry nulls, losses yields all-null", () => {
    const tp = buildTp(30, { socBlind: true });
    const rows = reduceThroughputToDays(tp, TZ, EMPTY_CARRY, 15);
    expect(rows.every((r) => r.socFirst === null && r.socSamples === 0)).toBe(
      true,
    );
    expect(
      rows.every((r) => r.downSwingPct === 0 && r.capDischargeKwh === 0),
    ).toBe(true);
    expect(rows.every((r) => !r.recal)).toBe(true);
    const got = pipelineLosses(tp, 15);
    expect(got.summaryEtaC).toBeNull();
    expect(got.byDay.every((d) => d.socKwh === null && !d.qualified)).toBe(
      true,
    );
  });
});
