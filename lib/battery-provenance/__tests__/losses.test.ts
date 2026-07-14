import { describe, it, expect } from "@jest/globals";
import { detectRecalDayIndexes, learnLosses } from "../losses";

const FIVE_MIN = 5 * 60 * 1000;
const DAY_IV = 288;

/**
 * Synthesize `days` local days (tz 0) of 5-min data obeying the three-term model exactly:
 *   ΔSoC/100·C = etaC·charge − discharge − idlePerDay·Δt
 * Charge runs 09:00–14:00, discharge 17:00–23:00; daily discharge is set so the net alternates ±2 kWh
 * (SoC oscillates instead of railing). Optionally injects a BMS-recal jump (+pp with no energy).
 */
function synth(
  days: number,
  {
    etaC = 0.93,
    idlePerDay = 0.5,
    C = 60,
    recal,
  }: {
    etaC?: number;
    idlePerDay?: number;
    C?: number;
    recal?: { day: number; jumpPp: number };
  } = {},
) {
  const n = days * DAY_IV;
  const timeline: number[] = new Array(n);
  const charge: number[] = new Array(n).fill(0);
  const discharge: number[] = new Array(n).fill(0);
  const soc: (number | null)[] = new Array(n).fill(null);
  const idlePerIv = idlePerDay / DAY_IV;

  let s = 50;
  for (let d = 0; d < days; d++) {
    const chgTot = 8 + (d % 5); // 8..12 kWh/day — enough variance to identify the slope
    const disTot = etaC * chgTot - idlePerDay + (d % 2 === 0 ? -2 : 2);
    for (let k = 0; k < DAY_IV; k++) {
      const i = d * DAY_IV + k;
      timeline[i] = (d * DAY_IV + k + 1) * FIVE_MIN; // interval ENDs, ascending
      if (k >= 108 && k < 168) charge[i] = chgTot / 60; // 09:00–14:00
      if (k >= 204 && k < 276) discharge[i] = disTot / 72; // 17:00–23:00
      s += (100 * (etaC * charge[i] - discharge[i] - idlePerIv)) / C;
      if (recal && d === recal.day && k === 150) s += recal.jumpPp;
      soc[i] = s;
    }
  }
  return { timeline, charge, discharge, soc, C };
}

describe("learnLosses", () => {
  it("recovers (η_c, idle) from data obeying the model", () => {
    const { timeline, charge, discharge, soc, C } = synth(30);
    const r = learnLosses(charge, discharge, soc, C, timeline, 0);
    expect(r.summaryEtaC).not.toBeNull();
    expect(r.summaryEtaC!).toBeCloseTo(0.93, 2);
    expect(r.summaryIdleKwhPerDay!).toBeCloseTo(0.5, 1);
    expect(r.recalDayIndexes).toHaveLength(0);
  });

  it("is causal with a warm-up: null before minQualifyingDays, values after", () => {
    const { timeline, charge, discharge, soc, C } = synth(20);
    const r = learnLosses(charge, discharge, soc, C, timeline, 0);
    expect(r.byDay[5].etaC).toBeNull(); // fit warm-up
    expect(r.byDay[13].etaC).toBeNull(); // day 13 sees only 13 prior qualifying days
    expect(r.byDay[15].etaC).not.toBeNull();
    // The interval series mirrors the day series.
    expect(r.etaCSeries[5 * DAY_IV + 10]).toBeNull();
    expect(r.etaCSeries[15 * DAY_IV + 10]).not.toBeNull();
  });

  it("flags a BMS-recal day, excludes it from the fit, and stays unbiased", () => {
    const { timeline, charge, discharge, soc, C } = synth(30, {
      recal: { day: 20, jumpPp: 8 }, // +8pp ≈ +4.8 kWh with no metered energy
    });
    const r = learnLosses(charge, discharge, soc, C, timeline, 0);
    const day20 = r.byDay[20];
    expect(day20.recal).toBe(true);
    expect(day20.qualified).toBe(false);
    expect(r.recalDayIndexes).toEqual([r.byDay[20].dayIndex]);
    // The phantom +4.8 kWh never enters the fit → the estimate stays on the true values.
    expect(r.summaryEtaC!).toBeCloseTo(0.93, 2);
    expect(r.summaryIdleKwhPerDay!).toBeCloseTo(0.5, 1);
  });

  it("clamps η_c to the physical band", () => {
    const { timeline, charge, discharge, soc, C } = synth(30, { etaC: 0.6 });
    const r = learnLosses(charge, discharge, soc, C, timeline, 0);
    expect(r.summaryEtaC).toBe(0.8); // clampMin
  });

  it("yields all-null for SoC-blind data (fold stays single-η)", () => {
    const { timeline, charge, discharge } = synth(20);
    const soc = new Array<number | null>(timeline.length).fill(null);
    const r = learnLosses(charge, discharge, soc, 60, timeline, 0);
    expect(r.summaryEtaC).toBeNull();
    expect(r.etaCSeries.every((v) => v === null)).toBe(true);
    expect(r.idleKwhPerDaySeries.every((v) => v === null)).toBe(true);
  });
});

describe("detectRecalDayIndexes", () => {
  it("finds the day of a SoC step with no matching metered energy", () => {
    const { timeline, charge, discharge, soc } = synth(10, {
      recal: { day: 6, jumpPp: 6 },
    });
    const days = detectRecalDayIndexes(charge, discharge, soc, 60, timeline, 0);
    expect(days.size).toBe(1);
  });

  it("stays silent when SoC tracks the meters", () => {
    const { timeline, charge, discharge, soc } = synth(10);
    const days = detectRecalDayIndexes(charge, discharge, soc, 60, timeline, 0);
    expect(days.size).toBe(0);
  });

  it("spans data gaps (nulls between observations) without false-positives", () => {
    // Charge 4.8 kWh during a SoC-dark hour; SoC re-appears higher by exactly the metered amount.
    const timeline = Array.from({ length: 36 }, (_, i) => (i + 1) * FIVE_MIN);
    const charge = new Array(36).fill(0);
    const discharge = new Array(36).fill(0);
    const soc: (number | null)[] = new Array(36).fill(50);
    for (let i = 12; i < 24; i++) {
      charge[i] = 0.4;
      soc[i] = null; // dark while charging
    }
    for (let i = 24; i < 36; i++) soc[i] = 58; // +8% of C=60 ⇒ +4.8 kWh, matches Σcharge
    const days = detectRecalDayIndexes(charge, discharge, soc, 60, timeline, 0);
    expect(days.size).toBe(0);
  });
});
