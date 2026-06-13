import { describe, it, expect } from "@jest/globals";
import {
  modelHws,
  DEFAULT_HWS_MODEL_OPTIONS,
  type HwsSample,
} from "../hws-model";

const FIVE_MIN_MS = 5 * 60 * 1000;

function buildSeries(
  hours: number,
  powerW: number | null,
  startMs = 0,
): HwsSample[] {
  const steps = (hours * 60) / 5;
  const out: HwsSample[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push({ tsMs: startMs + i * FIVE_MIN_MS, powerW });
  }
  return out;
}

describe("modelHws", () => {
  it("heats from 30°C toward 50°C, reaching ~49°C in 5h with constant power", () => {
    const series = buildSeries(5, 800);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 30,
    });
    const final = steps[steps.length - 1];
    expect(final.tankC).toBeGreaterThan(48);
    expect(final.tankC).toBeLessThan(50);
  });

  it("cools from 50°C toward 30°C, reaching ~31°C in 8h with no power", () => {
    const series = buildSeries(8, 0);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 50,
    });
    const final = steps[steps.length - 1];
    expect(final.tankC).toBeLessThan(32);
    expect(final.tankC).toBeGreaterThan(30);
  });

  it("caps faucet temperature at the tempering valve limit (40°C)", () => {
    const series = buildSeries(5, 800);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 30,
    });
    const hot = steps.filter((s) => s.tankC > 40);
    expect(hot.length).toBeGreaterThan(0);
    for (const s of hot) {
      expect(s.faucetC).toBe(40);
    }
  });

  it("treats power below the on-threshold as off (cools)", () => {
    const series = buildSeries(2, 50);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 50,
    });
    expect(steps.every((s) => !s.on)).toBe(true);
    expect(steps[steps.length - 1].tankC).toBeLessThan(50);
  });

  it("treats null power as off", () => {
    const series = buildSeries(2, null);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 50,
    });
    expect(steps.every((s) => !s.on)).toBe(true);
    expect(steps[steps.length - 1].tankC).toBeLessThan(50);
  });

  it("returns empty for empty input", () => {
    expect(modelHws([])).toEqual([]);
  });

  it("first step has no time delta and stays at the initial temperature", () => {
    const series = buildSeries(0, 800);
    const steps = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 35,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].tankC).toBe(35);
    expect(steps[0].on).toBe(true);
  });
});

/**
 * The HWS recompute (lib/hws/recompute.ts) recomputes each window from a FIXED 2-day warmup lead-in
 * and UPSERTs only the window's intervals, relying on the result being independent of the seed
 * `tInitial` and of where the window boundary falls. These tests pin that property on the pure
 * model: after ~2 days the first-order model forgets its initial condition, so any window
 * recomputes to the same values regardless of anchor — which is what makes the recompute idempotent.
 */
describe("modelHws — warmup convergence (recompute idempotency)", () => {
  const WARMUP_MS = 2 * 24 * 60 * 60 * 1000;
  const WINDOW_HOURS = 24;

  // A deterministic, bounded on/off duty cycle: heat 30 min every 2 hours.
  function dutyCycleSeries(hours: number, startMs = 0): HwsSample[] {
    const steps = (hours * 60) / 5;
    const out: HwsSample[] = [];
    for (let i = 0; i <= steps; i++) {
      const minuteOfCycle = (i * 5) % 120; // 2-hour cycle
      out.push({
        tsMs: startMs + i * FIVE_MIN_MS,
        powerW: minuteOfCycle < 30 ? 800 : 0,
      });
    }
    return out;
  }

  it("forgets the seed tInitial after the 2-day warmup", () => {
    const series = dutyCycleSeries(48 + WINDOW_HOURS); // warmup + window
    const cold = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 30,
    });
    const hot = modelHws(series, {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      tInitial: 50,
    });

    const inWindow = (s: { tsMs: number }) => s.tsMs >= WARMUP_MS;
    const coldWin = cold.filter(inWindow);
    const hotWin = hot.filter(inWindow);
    expect(coldWin.length).toBe(hotWin.length);
    expect(coldWin.length).toBeGreaterThan(0);
    for (let i = 0; i < coldWin.length; i++) {
      expect(Math.abs(coldWin[i].tankC - hotWin[i].tankC)).toBeLessThan(1e-3);
    }
  });

  it("window values are independent of where the recompute window starts", () => {
    const full = dutyCycleSeries(72); // shared signal
    const byTs = new Map(full.map((s) => [s.tsMs, s.powerW] as const));
    const sliceFrom = (anchorMs: number): HwsSample[] =>
      full.filter((s) => s.tsMs >= anchorMs).map((s) => ({ ...s }));

    const winStartMs = WARMUP_MS; // the window we actually persist starts here
    const a = modelHws(sliceFrom(0), DEFAULT_HWS_MODEL_OPTIONS); // warmup from t=0
    const b = modelHws(sliceFrom(FIVE_MIN_MS * 6), DEFAULT_HWS_MODEL_OPTIONS); // warmup 30min later

    const aWin = a.filter((s) => s.tsMs >= winStartMs);
    const bWin = b.filter((s) => s.tsMs >= winStartMs);
    expect(aWin.length).toBe(bWin.length);
    for (let i = 0; i < aWin.length; i++) {
      expect(aWin[i].tsMs).toBe(bWin[i].tsMs);
      expect(byTs.get(aWin[i].tsMs)).toBe(byTs.get(bWin[i].tsMs)); // same input
      expect(Math.abs(aWin[i].faucetC - bWin[i].faucetC)).toBeLessThan(1e-3);
    }
  });
});
