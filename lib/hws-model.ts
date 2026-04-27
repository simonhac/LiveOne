export interface HwsModelOptions {
  onThresholdW: number;
  tMax: number;
  tFloor: number;
  tFaucetMax: number;
  tauHeatHours: number;
  tauCoolHours: number;
  tInitial: number;
}

export const DEFAULT_HWS_MODEL_OPTIONS: HwsModelOptions = {
  onThresholdW: 100,
  tMax: 50,
  tFloor: 30,
  tFaucetMax: 40,
  tauHeatHours: 5 / 3,
  tauCoolHours: 8 / 3,
  tInitial: 40,
};

export interface HwsSample {
  tsMs: number;
  powerW: number | null;
}

export interface HwsModelStep {
  tsMs: number;
  powerW: number | null;
  on: boolean;
  tankC: number;
  faucetC: number;
}

export function modelHws(
  series: HwsSample[],
  options: HwsModelOptions = DEFAULT_HWS_MODEL_OPTIONS,
): HwsModelStep[] {
  const out: HwsModelStep[] = [];
  let tank = options.tInitial;
  let prevTs: number | null = null;

  for (const sample of series) {
    const on = sample.powerW !== null && sample.powerW > options.onThresholdW;

    if (prevTs !== null) {
      const dtHours = (sample.tsMs - prevTs) / 3_600_000;
      if (dtHours > 0) {
        const target = on ? options.tMax : options.tFloor;
        const tau = on ? options.tauHeatHours : options.tauCoolHours;
        tank = tank + (target - tank) * (1 - Math.exp(-dtHours / tau));
      }
    }

    out.push({
      tsMs: sample.tsMs,
      powerW: sample.powerW,
      on,
      tankC: tank,
      faucetC: Math.min(tank, options.tFaucetMax),
    });

    prevTs = sample.tsMs;
  }

  return out;
}
