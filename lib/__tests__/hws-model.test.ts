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
