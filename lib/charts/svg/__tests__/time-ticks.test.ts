import { describe, it, expect } from "@jest/globals";
import { buildShadingBands, buildTimeTicks } from "../time-ticks";

/**
 * A fixed LOCAL window, so day/weekday maths is deterministic whatever TZ the runner is in — the
 * same convention `scaffold.test.ts` uses, since both are asserting local-calendar behaviour.
 */
const END = new Date(2024, 7, 22, 12, 0, 0); // Thu 22 Aug 2024, local noon
const DAY_MS = 24 * 60 * 60 * 1000;
const back = (days: number) => new Date(END.getTime() - days * DAY_MS);

const labelled = (ticks: ReturnType<typeof buildTimeTicks>) =>
  ticks.filter((t) => t.label !== null);
const texts = (ticks: ReturnType<typeof buildTimeTicks>) =>
  labelled(ticks).map((t) => t.label!.join(" "));

describe("buildTimeTicks — D", () => {
  const ticks = buildTimeTicks("D", back(1), END);

  it("puts a gridline on every hour", () => {
    expect(ticks.length).toBeGreaterThanOrEqual(23);
    expect(ticks.length).toBeLessThanOrEqual(25);
    for (const t of ticks) expect(t.value.getMinutes()).toBe(0);
  });

  it("labels every second gridline, so labels read 2-hourly", () => {
    const l = labelled(ticks);
    expect(l.length).toBeCloseTo(ticks.length / 2, 0);
    const hours = l.map((t) => t.value.getHours());
    for (let i = 1; i < hours.length; i++) {
      const gap = (hours[i] - hours[i - 1] + 24) % 24;
      expect(gap).toBe(2);
    }
  });

  it("labels are single-line HH:mm", () => {
    for (const t of labelled(ticks)) {
      expect(t.label).toHaveLength(1);
      expect(t.label![0]).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("unlabelled ticks are null, not blank strings", () => {
    // The old implementation emitted a zero-width space to keep the gridline. Gridline and label are
    // separate concepts here, so an unlabelled tick says so.
    const unlabelled = ticks.filter((t) => t.label === null);
    expect(unlabelled.length).toBeGreaterThan(0);
    for (const t of unlabelled) expect(t.label).toBeNull();
  });
});

describe("buildTimeTicks — W", () => {
  const ticks = buildTimeTicks("W", back(7), END);

  it("puts a gridline on each local midnight and labels every one", () => {
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    expect(ticks.length).toBeLessThanOrEqual(8);
    for (const t of ticks) {
      expect(t.value.getHours()).toBe(0);
      expect(t.label).not.toBeNull();
    }
  });

  it("labels are two lines: weekday then date", () => {
    for (const t of ticks) {
      expect(t.label).toHaveLength(2);
      expect(t.label![0]).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
      expect(t.label![1]).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    }
  });
});

describe("buildTimeTicks — M", () => {
  const ticks = buildTimeTicks("M", back(30), END);

  it("puts a gridline on each local midnight", () => {
    expect(ticks.length).toBeGreaterThanOrEqual(29);
    for (const t of ticks) expect(t.value.getHours()).toBe(0);
  });

  it("thins labels to every 4th day at 30-day density", () => {
    // Matches what the current axis shows (Sun 17, Thu 21, Mon 25, Fri 29 …) — the >25-tick rung of
    // the skip ladder carried over from buildTimeScale.
    const l = labelled(ticks);
    const days = l.map((t) => t.value.getTime());
    for (let i = 1; i < days.length; i++) {
      expect(Math.round((days[i] - days[i - 1]) / DAY_MS)).toBe(4);
    }
    expect(l.length).toBeLessThan(ticks.length);
  });

  it("thins less aggressively over a shorter window", () => {
    // 18 days ⇒ ~19 ticks ⇒ the "<= 20" rung ⇒ every 2nd.
    const short = buildTimeTicks("M", back(18), END);
    const l = labelled(short);
    const gapDays = Math.round(
      (l[1].value.getTime() - l[0].value.getTime()) / DAY_MS,
    );
    expect(gapDays).toBe(2);
  });

  it("labels are two lines, like W", () => {
    for (const t of labelled(ticks)) expect(t.label).toHaveLength(2);
  });
});

describe("buildTimeTicks — Y", () => {
  const ticks = buildTimeTicks("Y", back(365), END);

  it("puts a gridline on each month start", () => {
    expect(ticks.length).toBeGreaterThanOrEqual(11);
    expect(ticks.length).toBeLessThanOrEqual(13);
    for (const t of ticks) {
      expect(t.value.getDate()).toBe(1);
      expect(t.label).not.toBeNull();
    }
  });

  it("carries the year on January and on the first tick, bare month elsewhere", () => {
    const all = texts(ticks);
    expect(all[0]).toMatch(/^[A-Z][a-z]{2} \d{2}$/); // first tick oriented
    const jan = ticks.find((t) => t.value.getMonth() === 0);
    expect(jan!.label![0]).toMatch(/^Jan \d{2}$/);
    const plainMonths = ticks.filter(
      (t, i) => i !== 0 && t.value.getMonth() !== 0,
    );
    for (const t of plainMonths) {
      expect(t.label![0]).toMatch(/^[A-Z][a-z]{2}$/);
    }
  });
});

describe("buildTimeTicks — degenerate windows", () => {
  it("returns nothing for an empty or inverted window", () => {
    expect(buildTimeTicks("D", END, END)).toEqual([]);
    expect(buildTimeTicks("D", END, back(1))).toEqual([]);
  });
});

describe("buildShadingBands", () => {
  it("D/W shade 07:00–22:00 of each local day, clipped to the window", () => {
    const start = back(1);
    const bands = buildShadingBands("D", start, END);
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) {
      expect(b.start).toBeGreaterThanOrEqual(start.getTime());
      expect(b.end).toBeLessThanOrEqual(END.getTime());
      expect(b.start).toBeLessThan(b.end);
    }
    // An unclipped band is exactly 15 hours.
    const full = bands.filter(
      (b) => b.start > start.getTime() && b.end < END.getTime(),
    );
    for (const b of full) expect(b.end - b.start).toBe(15 * 60 * 60 * 1000);
  });

  it("M shades whole weekdays and never a weekend", () => {
    const start = back(30);
    const bands = buildShadingBands("M", start, END);
    expect(bands.length).toBeGreaterThan(0);
    expect(bands.length).toBeLessThan(31); // weekends excluded
    for (const b of bands) {
      expect(b.start).toBeGreaterThanOrEqual(start.getTime());
      expect(b.end).toBeLessThanOrEqual(END.getTime());
      // A band that wasn't clipped by the window edge starts at a weekday midnight.
      if (b.start !== start.getTime()) {
        const dow = new Date(b.start).getDay();
        expect(dow).toBeGreaterThanOrEqual(1);
        expect(dow).toBeLessThanOrEqual(5);
      }
    }
  });

  it("Y has no shading — weekday striping is noise at year scale", () => {
    expect(buildShadingBands("Y", back(365), END)).toEqual([]);
  });

  it("bands never overlap each other", () => {
    for (const range of ["D", "W", "M"] as const) {
      const bands = buildShadingBands(range, back(30), END);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].start).toBeGreaterThanOrEqual(bands[i - 1].end);
      }
    }
  });
});
