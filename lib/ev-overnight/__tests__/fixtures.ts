/**
 * Synthetic fixtures for the EV-overnight tests. July dates only, so Melbourne is a fixed +10:00 and
 * a local wall time maps to UTC by arithmetic — the one DST test builds its instants by hand.
 */
import {
  SLOT_MIN,
  SLOTS_PER_NIGHT,
  slotOf,
  type BatteryParams,
  type Profile,
  type Sample5m,
} from "../model";

export const TZ = "Australia/Melbourne";
const STEP_MS = SLOT_MIN * 60_000;

/** An AEST wall-clock instant. */
export const aest = (date: string, hh: number, mm = 0): number =>
  Date.parse(
    `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+10:00`,
  );

/** A linear battery: 30 kWh over 0–100% (0.3 kWh/%), no standby, no curvature. */
export const LINEAR_BATTERY: BatteryParams = {
  floorPct: 10,
  maxDischargeW: 10_000,
  drain: { c0: 0, c1: 100 / 30, c2: 0 },
};

export interface DayShape {
  houseW?: (localMin: number) => number;
  solarW?: (localMin: number) => number;
  evW?: (localMin: number) => number;
}

/** Solar ramps 0 → 20 W/min from 07:00 and back down to 0 at 17:00 (peaks ~6 kW at noon). */
export const rampSolar = (min: number): number =>
  min < 420 || min >= 1020 ? 0 : Math.min((min - 420) * 20, (1020 - min) * 20);

/**
 * Contiguous 5-minute samples from `fromDate` 12:00 to `toDate` 12:00 (local, AEST), each stamped at
 * its interval END and shaped by the interval's START minute. SoC is a placeholder (50).
 */
export function makeSamples(
  fromDate: string,
  toDate: string,
  shape: DayShape = {},
): Sample5m[] {
  const out: Sample5m[] = [];
  const end = aest(toDate, 12);
  for (let start = aest(fromDate, 12); start < end; start += STEP_MS) {
    const min =
      new Date(start + 10 * 3_600_000).getUTCHours() * 60 +
      new Date(start + 10 * 3_600_000).getUTCMinutes();
    const houseW = shape.houseW?.(min) ?? 300;
    const solarW = shape.solarW?.(min) ?? rampSolar(min);
    const evW = shape.evW?.(min) ?? 0;
    out.push({
      t: start + STEP_MS,
      soc: 50,
      batteryW: houseW + evW - solarW,
      solarW,
      gridW: 0,
      houseW,
      evW,
    });
  }
  return out;
}

/** Shift a YYYY-MM-DD by `days`. */
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * A hand-built typical night: constant house load, no sun, cover at 07:00, need computed for
 * `LINEAR_BATTERY` (0.3 kW for 1 h = 0.3 kWh = 1%).
 */
export function flatProfile(houseW = 300, coverSlot = slotOf(7)): Profile {
  const needPct = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  const needKwh = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  for (let k = 0; k < coverSlot; k++) {
    const hours = ((coverSlot - k) * SLOT_MIN) / 60;
    needKwh[k] = (houseW / 1000) * hours;
    needPct[k] = needKwh[k] * (100 / 30);
  }
  return {
    nights: [],
    houseW: new Array<number>(SLOTS_PER_NIGHT).fill(houseW),
    solarW: new Array<number>(SLOTS_PER_NIGHT).fill(0),
    needPct,
    needKwh,
    coverSlot,
    coverSlots: [coverSlot],
  };
}
