/**
 * `precededByDataGap` — telling "the device stopped" apart from "we lost data".
 *
 * Fragmentation is otherwise invisible. A run split by a late poll is a perfectly well-formed run:
 * valid duration, valid statistics, valid close reason. So `inserted`, `open` and `failures` all
 * read healthy while a six-hour charge is reported as eighty pieces — the Kutis EV backfill returned
 * 408 "sessions" for 27 real charges and nothing in the summary objected.
 *
 * 🛑 `closeReason` is NOT the signal, and these tests assert that too. An off-sample does not close
 * a run (it is bridged; the gap clock closes it later), so every closed run reads "gap" whatever the
 * cause. The discriminator is what lies BETWEEN two runs: a device that stopped leaves samples below
 * the threshold, a late poll leaves nothing at all.
 */
import { describe, it, expect } from "@jest/globals";
import {
  detectRunPeriods,
  type DetectConfig,
  type Sample,
} from "@/lib/run-tracking/detect";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const FAR_FUTURE = T0 + 10_000_000;

const s = (tMs: number, value: number | null): Sample => ({ tMs, value });

/** On above 100 W. The floor is disabled throughout: these test the DETECTION of splits, not their
 *  prevention, and with the cadence floor on most of them would not split at all. */
function cfg(overrides: Partial<DetectConfig> = {}): DetectConfig {
  return {
    lowerW: null,
    upperW: 100,
    hysteresisW: 0,
    delayOnMs: 0,
    delayOffMs: 300 * SEC,
    delayOffCadenceMultiple: 0,
    nowMs: FAR_FUTURE,
    boundaryMode: "edge",
    ...overrides,
  };
}

describe("precededByDataGap", () => {
  it("flags a run split by a late poll, with nothing between", () => {
    // Two on-samples 10 minutes apart at a 300 s delayOff: the run closes and reopens, and no sample
    // in between ever showed the charger off. This is the Kutis shape.
    const periods = detectRunPeriods(
      [s(T0, 6800), s(T0 + 600 * SEC, 6800)],
      cfg(),
    );
    expect(periods).toHaveLength(2);
    expect(periods[0].precededByDataGap).toBe(false); // nothing precedes the first
    expect(periods[1].precededByDataGap).toBe(true);
    // …and closeReason cannot tell you any of that.
    expect(periods[0].closeReason).toBe("gap");
  });

  it("does NOT flag a run after the device was seen off", () => {
    // Same spacing, but a 0 W sample in the gap proves it genuinely stopped.
    const periods = detectRunPeriods(
      [s(T0, 6800), s(T0 + 300 * SEC, 0), s(T0 + 600 * SEC, 6800)],
      cfg(),
    );
    expect(periods).toHaveLength(2);
    expect(periods[1].precededByDataGap).toBe(false);
    // The close reason is identical to the flagged case above — which is the point.
    expect(periods[0].closeReason).toBe("gap");
  });

  it("treats a null sample as absence, not as evidence of stopping", () => {
    // A null is "the reading failed", which says nothing about whether the device was running. It
    // must not be allowed to launder a data gap into a genuine stop.
    const periods = detectRunPeriods(
      [s(T0, 6800), s(T0 + 300 * SEC, null), s(T0 + 600 * SEC, 6800)],
      cfg(),
    );
    expect(periods).toHaveLength(2);
    expect(periods[1].precededByDataGap).toBe(true);
  });

  it("counts every fragment of a shredded run", () => {
    // The failure this exists to surface: continuous charging, polled just slower than delayOff.
    const samples = Array.from({ length: 12 }, (_, i) =>
      s(T0 + i * 330 * SEC, 6800),
    );
    const periods = detectRunPeriods(samples, cfg());
    expect(periods).toHaveLength(12);
    expect(periods.filter((p) => p.precededByDataGap)).toHaveLength(11);
  });

  it("stays quiet on a healthy detector — none of many runs is flagged", () => {
    // Three charges separated by hours, each bracketed by real off-samples.
    const samples: Sample[] = [];
    for (let c = 0; c < 3; c++) {
      const base = T0 + c * 6 * 3600 * SEC;
      samples.push(s(base - 300 * SEC, 0));
      for (let i = 0; i < 10; i++) samples.push(s(base + i * 120 * SEC, 6800));
      samples.push(s(base + 10 * 120 * SEC + 300 * SEC, 0));
    }
    const periods = detectRunPeriods(samples, cfg());
    expect(periods).toHaveLength(3);
    expect(periods.every((p) => !p.precededByDataGap)).toBe(true);
  });

  it("does not flag a boundary split, which has an off-sample by construction", () => {
    // A control edge cuts a run only across an off stretch, so the device WAS seen off — this is a
    // deliberate split, not a data gap, and must not be reported as one.
    const samples = [
      s(T0, 1500),
      s(T0 + 60 * SEC, 0),
      s(T0 + 120 * SEC, 1500),
      s(T0 + 180 * SEC, 1500),
    ];
    const periods = detectRunPeriods(
      samples,
      cfg({ upperW: 500, boundaryEventsMs: [T0 + 90 * SEC] }),
    );
    expect(periods).toHaveLength(2);
    expect(periods[0].closeReason).toBe("boundary");
    expect(periods[1].precededByDataGap).toBe(false);
  });

  it("is prevented, not merely reported, once the cadence floor is on", () => {
    // The same shredded input with the floor enabled is one run — so a flagged pass on a live
    // detector now means an outage, which is the case worth an operator's attention.
    const samples = Array.from({ length: 12 }, (_, i) =>
      s(T0 + i * 330 * SEC, 6800),
    );
    const periods = detectRunPeriods(samples, {
      ...cfg(),
      delayOffCadenceMultiple: 3,
    });
    expect(periods).toHaveLength(1);
    expect(periods[0].precededByDataGap).toBe(false);
  });
});
