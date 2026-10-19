import { describe, expect, it } from "@jest/globals";
import {
  buildProfile,
  calibrateBattery,
  drainPctPerH,
  kWhPerPctAt,
  morningCoverSlot,
  nightNeed,
  nightSlot,
  segmentNights,
  slotOf,
  solveStopTime,
  type Sample5m,
} from "../model";
import {
  addDays,
  aest,
  flatProfile,
  LINEAR_BATTERY,
  makeSamples,
  TZ,
} from "./fixtures";

describe("nightSlot", () => {
  it("keys a night by its evening and counts wall-clock slots from noon", () => {
    expect(nightSlot(aest("2026-07-01", 12), TZ)).toEqual({
      night: "2026-07-01",
      slot: 0,
    });
    expect(nightSlot(aest("2026-07-02", 6), TZ)).toEqual({
      night: "2026-07-01",
      slot: slotOf(6),
    });
    expect(nightSlot(aest("2026-07-02", 11, 55), TZ).slot).toBe(287);
  });

  it("skips the missing hour on the DST night rather than shifting the clock", () => {
    // 2026-10-04 02:00 AEST → 03:00 AEDT.
    expect(nightSlot(Date.parse("2026-10-03T15:55:00Z"), TZ)).toEqual({
      night: "2026-10-03",
      slot: slotOf(1, 55),
    });
    expect(nightSlot(Date.parse("2026-10-03T16:00:00Z"), TZ)).toEqual({
      night: "2026-10-03",
      slot: slotOf(3),
    });
  });
});

describe("nights and the overnight need", () => {
  const [night] = segmentNights(makeSamples("2026-07-01", "2026-07-02"), TZ);

  it("finds the morning cover once solar beats the house for 15 minutes", () => {
    // Solar is 0/100/200/300 W at 07:00/05/10/15; the house is 300 W.
    expect(morningCoverSlot(night)).toBe(slotOf(7, 15));
  });

  it("integrates the deficit back from the cover, in kWh and in SoC%", () => {
    const need = nightNeed(night, LINEAR_BATTERY)!;
    // 21:00 → 07:00 at 0.3 kW = 3 kWh, plus the 07:00–07:15 ramp: (0.3 + 0.2 + 0.1) kW × 5 min.
    const kwh = 3 + (0.6 * 5) / 60;
    expect(need.needKwh[slotOf(21)]).toBeCloseTo(kwh, 6);
    expect(need.needPct[slotOf(21)]).toBeCloseTo(kwh / 0.3, 6);
    expect(need.needPct[slotOf(7, 15)]).toBe(0);
  });

  it("rejects a night with a hole between 15:00 and the cover", () => {
    const samples = makeSamples("2026-07-01", "2026-07-02").filter(
      (s) => s.t !== aest("2026-07-01", 23, 5),
    );
    expect(nightNeed(segmentNights(samples, TZ)[0], LINEAR_BATTERY)).toBeNull();
  });
});

describe("buildProfile", () => {
  // Night i (2026-07-01 + i) draws 200 + 100·i W all night.
  const samples: Sample5m[] = [];
  for (let i = 0; i < 9; i++) {
    const d = addDays("2026-07-01", i);
    samples.push(
      ...makeSamples(d, addDays(d, 1), { houseW: () => 200 + 100 * i }),
    );
  }
  const nights = segmentNights(samples, TZ);

  it("averages each night's own need over the last N nights strictly before the target", () => {
    const p = buildProfile(nights, "2026-07-09", LINEAR_BATTERY, 7)!;
    expect(p.nights).toEqual([
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
    const s21 = slotOf(21);
    const each = p.nights.map(
      (k) => nightNeed(nights.find((n) => n.key === k)!, LINEAR_BATTERY)!,
    );
    const mean = each.reduce((a, n) => a + n.needPct[s21], 0) / each.length;
    expect(p.needPct[s21]).toBeCloseTo(mean, 9);
    expect(p.houseW[s21]).toBeCloseTo(600, 9); // mean of 300…900
  });

  it("refuses with too few usable nights", () => {
    expect(buildProfile(nights, "2026-07-04", LINEAR_BATTERY, 7, 4)).toBeNull();
  });
});

describe("kWhPerPctAt", () => {
  it("is flat for a linear battery and dips at low load once there is standby", () => {
    expect(kWhPerPctAt(LINEAR_BATTERY.drain, 300)).toBeCloseTo(0.3, 9);
    expect(kWhPerPctAt(LINEAR_BATTERY.drain, 7000)).toBeCloseTo(0.3, 9);
    const withStandby = { c0: 0.6, c1: 100 / 30, c2: 0 };
    // 0.3 kW → 1 + 0.6 %/h → 0.1875 kWh/%; 7 kW → 23.33 + 0.6 %/h → 0.2925 kWh/%.
    expect(kWhPerPctAt(withStandby, 300)).toBeCloseTo(0.3 / 1.6, 9);
    expect(kWhPerPctAt(withStandby, 7000)).toBeCloseTo(7 / (70 / 3 + 0.6), 9);
  });
});

describe("calibrateBattery", () => {
  const truth = { c0: 0.6, c1: 2.8, c2: 0.06 };

  /** Hour-long blocks at a steady output, SoC integrated through `truth` and rounded to 0.1%. */
  function synth(): Sample5m[] {
    const out: Sample5m[] = [];
    const levels = [200, 400, 1000, 2500, 7000, 300, 9000, 600, 4000, 250];
    let t = aest("2026-07-01", 0);
    let soc = 95;
    for (let rep = 0; rep < 12; rep++)
      for (const w of levels)
        for (let i = 0; i < 12; i++) {
          if (soc < 20) {
            soc = 95; // a recharge we don't model: break the series
            t += 3_600_000;
          }
          soc -= drainPctPerH(truth, w) / 12;
          t += 300_000;
          const ev = w > 5000 ? 6800 : 0;
          out.push({
            t,
            soc: Math.round(soc * 10) / 10,
            batteryW: w,
            solarW: 0,
            gridW: 0,
            houseW: w - ev,
            evW: ev,
          });
        }
    // Sitting at the floor while the house imports.
    for (let i = 0; i < 20; i++) {
      t += 300_000;
      out.push({
        t,
        soc: 10,
        batteryW: 0,
        solarW: 0,
        gridW: 400,
        houseW: 400,
        evW: 0,
      });
    }
    // The inverter clipping.
    for (let i = 0; i < 3; i++) {
      t += 300_000;
      out.push({
        t,
        soc: 50,
        batteryW: 10_000,
        solarW: 0,
        gridW: 700,
        houseW: 3700,
        evW: 7000,
      });
    }
    return out;
  }

  it("recovers the floor, the cap and the drain curve", () => {
    const cal = calibrateBattery(synth(), { capacityKwh: 30, floorPct: 15 });
    expect(cal.floorPct).toBe(10);
    expect(cal.maxDischargeW).toBe(10_000);
    expect(cal.drain.c0).toBeCloseTo(truth.c0, 1);
    expect(cal.drain.c1).toBeCloseTo(truth.c1, 1);
    expect(cal.drain.c2).toBeCloseTo(truth.c2, 2);
    expect(Math.abs(cal.evBiasPct)).toBeLessThan(0.1);
  });

  it("rejects a window whose SoC rises while discharging (a BMS re-sync, not physics)", () => {
    const samples = synth();
    const clean = calibrateBattery(samples, { capacityKwh: 30, floorPct: 15 });
    // Jump SoC up by 5% mid-window, in every 7th window.
    const jumped = samples.map((s, i) =>
      i % 42 === 20 && s.soc !== null && s.soc > 20
        ? { ...s, soc: s.soc + 5 }
        : s,
    );
    const cal = calibrateBattery(jumped, { capacityKwh: 30, floorPct: 15 });
    expect(cal.fitWindows).toBeLessThan(clean.fitWindows);
    expect(cal.drain.c1).toBeCloseTo(truth.c1, 1);
  });

  it("falls back to the nameplate when there is nothing to fit", () => {
    const cal = calibrateBattery([], { capacityKwh: 32, floorPct: 12 });
    expect(cal.floorPct).toBe(12);
    expect(cal.drain).toEqual({ c0: 0, c1: 100 / 32, c2: 0 });
  });
});

describe("solveStopTime", () => {
  // Typical night: 300 W house, no sun, cover at 07:00 → need = 1%/h of night left (LINEAR_BATTERY).
  const profile = flatProfile();
  const base = {
    nowMs: aest("2026-07-01", 20),
    tz: TZ,
    battery: LINEAR_BATTERY,
    bufferPct: 3,
    profile,
  };

  it("stops where the draining battery meets what the rest of the night needs", () => {
    // Charging drains (6 + 0.3) kW × 3.33 %/kWh = 21 %/h; required = 13 + (11 − t). Margin
    // 60 − 21t − 24 + t = 0 at t = 1.8 h (21:48), rounded down to 21:45.
    const sol = solveStopTime({ ...base, socPct: 60, evW: 6000 });
    expect(sol.kind).toBe("stop-at");
    if (sol.kind !== "stop-at") return;
    expect(sol.stopAtMs).toBe(aest("2026-07-01", 21, 45));
    expect(sol.stopSocPct).toBeCloseTo(60 - 21 * 1.75, 6);
    expect(sol.evKwhFromNow).toBeCloseTo(6 * 1.75, 6);
    expect(sol.needKwh).toBeCloseTo(0.3 * 9.25, 6);
    expect(sol.coverAtMs).toBe(aest("2026-07-02", 7));
  });

  it("caps the battery's output at the inverter limit", () => {
    // 12.3 kW asked, 10 kW delivered → 33.3 %/h; margin 36 − 32.33t = 0 at 1.11 h → 21:05.
    const sol = solveStopTime({ ...base, socPct: 60, evW: 12_000 });
    expect(sol.kind === "stop-at" && sol.stopAtMs).toBe(
      aest("2026-07-01", 21, 5),
    );
  });

  it("says stop now, with the expected import, when the battery is already short", () => {
    const sol = solveStopTime({ ...base, socPct: 20, evW: 6000 });
    expect(sol.kind).toBe("stop-now");
    if (sol.kind !== "stop-now") return;
    expect(sol.requiredSocPct).toBeCloseTo(24, 6);
    // 3.3 kWh needed; 4 of the 11 needed % are missing.
    expect(sol.shortfallKwh).toBeCloseTo((3.3 * 4) / 11, 6);
  });

  it("needs no action when the battery lasts the whole night", () => {
    expect(solveStopTime({ ...base, socPct: 60, evW: 0 }).kind).toBe(
      "no-action",
    );
  });

  it("recognises a battery already at its floor", () => {
    expect(solveStopTime({ ...base, socPct: 10.2, evW: 6000 }).kind).toBe(
      "battery-empty",
    );
  });

  it("has nothing to say after the morning cover", () => {
    const sol = solveStopTime({
      ...base,
      nowMs: aest("2026-07-02", 8),
      socPct: 60,
      evW: 6000,
    });
    expect(sol.kind).toBe("no-action");
  });
});
