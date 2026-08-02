import { describe, it, expect } from "@jest/globals";
import { buildShadingBands, buildTimeTicks } from "../time-ticks";

/**
 * A fixed LOCAL window, so day/weekday maths is deterministic whatever TZ the runner is in — the
 * same convention `scaffold.test.ts` uses, since both are asserting local-calendar behaviour.
 */
const END = new Date(2024, 7, 22, 12, 0, 0); // Thu 22 Aug 2024, local noon
const DAY_MS = 24 * 60 * 60 * 1000;
const back = (days: number) => new Date(END.getTime() - days * DAY_MS);

/** A desktop-ish plot width; the existing suites assert density at this size. */
const WIDE = 812;
/** A phone-ish plot width — the case the old count-based ladder ignored entirely. */
const NARROW = 300;

const labelled = (ticks: ReturnType<typeof buildTimeTicks>) =>
  ticks.filter((t) => t.label !== null);
const texts = (ticks: ReturnType<typeof buildTimeTicks>) =>
  labelled(ticks).map((t) => t.label!.join(" "));

describe("buildTimeTicks — D", () => {
  const ticks = buildTimeTicks("D", back(1), END, WIDE);

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

  it("labels are single-line 12-hour times, with no ':00' on the hour", () => {
    for (const t of labelled(ticks)) {
      expect(t.label).toHaveLength(1);
      expect(t.label![0]).toMatch(/^([1-9]|1[0-2])(am|pm)$/);
    }
    // Midnight is "12am", not "0am" — the case a naive hour % 12 gets wrong.
    const midnight = labelled(ticks).find((t) => t.value.getHours() === 0);
    if (midnight) expect(midnight.label![0]).toBe("12am");
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
  const ticks = buildTimeTicks("W", back(7), END, WIDE);

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
  const ticks = buildTimeTicks("M", back(30), END, WIDE);

  it("emits only labelled ticks — no bare gridlines, unlike D", () => {
    // 🛑 Measured, not assumed. Against the Chart.js baselines a 30-day window drew ~15 gridlines,
    // and keeping all 31 daily ones rendered visibly noisier than what it replaces. D is the
    // opposite case and keeps its unlabelled gridlines, because there the canvas genuinely draws
    // them (24 gridlines to 12 labels).
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.value.getHours()).toBe(0);
      expect(t.label).not.toBeNull();
    }
  });

  it("spaces them every 4th day at 30 days on a desktop-width plot", () => {
    // The spacing the canvas axis showed: Sun 17, Thu 21, Mon 25, Fri 29 … Now arrived at by fitting
    // the width rather than by a count ladder, and calibrated to land on the same answer here.
    const days = ticks.map((t) => t.value.getTime());
    expect(days.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < days.length; i++) {
      expect(Math.round((days[i] - days[i - 1]) / DAY_MS)).toBe(4);
    }
  });

  it("thins less aggressively over a shorter window", () => {
    // Fewer days in the same width ⇒ more room each ⇒ tighter spacing.
    const short = buildTimeTicks("M", back(18), END, WIDE);
    const gapDays = Math.round(
      (short[1].value.getTime() - short[0].value.getTime()) / DAY_MS,
    );
    expect(gapDays).toBeLessThan(4);
  });

  it("labels are two lines, like W", () => {
    for (const t of ticks) expect(t.label).toHaveLength(2);
  });
});

describe("buildTimeTicks — Y", () => {
  const ticks = buildTimeTicks("Y", back(365), END, WIDE);

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
    expect(buildTimeTicks("D", END, END, WIDE)).toEqual([]);
    expect(buildTimeTicks("D", END, back(1), WIDE)).toEqual([]);
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

/**
 * Density is fitted to the available width, not to how many days are in the window.
 *
 * The old ladder (`>25 ticks → every 4th`) produced identical spacing on a 900 px desktop and a
 * 360 px phone, where two-line `[weekday, date]` labels overlap. These assert the property that
 * matters — labels never claim more room than there is — rather than a specific skip number, so
 * tuning the width estimate does not invalidate them.
 */
describe("tick density fits the plot width", () => {
  /** Rough px a labelled tick needs, matching the module's own estimate. */
  const slotPx = (lines: string[]) =>
    Math.max(...lines.map((l) => l.length)) * 6 + 30 * lines.length;

  const labelledCount = (
    w: number,
    range: "D" | "W" | "M" | "Y",
    days: number,
  ) =>
    buildTimeTicks(range, back(days), END, w).filter((t) => t.label !== null)
      .length;

  it("thins M further on a narrow plot than a wide one", () => {
    expect(labelledCount(NARROW, "M", 30)).toBeLessThan(
      labelledCount(WIDE, "M", 30),
    );
  });

  it.each([
    ["D", 1, ["12am"]],
    ["W", 7, ["Wed", "30 Jun"]],
    ["M", 30, ["Wed", "30 Jun"]],
    ["Y", 365, ["MMM"]],
  ] as const)(
    "%s labels always fit the width they were given",
    (range, days, sample) => {
      for (const w of [NARROW, 500, WIDE, 1400]) {
        const n = labelledCount(w, range, days);
        expect(n * slotPx([...sample])).toBeLessThanOrEqual(
          w + slotPx([...sample]),
        );
      }
    },
  );

  it("keeps D's unlabelled gridlines while thinning its labels", () => {
    // D is the exception: the canvas drew hourly gridlines with 2-hourly labels, so narrowing must
    // drop labels, never lines.
    const wide = buildTimeTicks("D", back(1), END, WIDE);
    const narrow = buildTimeTicks("D", back(1), END, NARROW);
    expect(narrow.length).toBe(wide.length); // same gridlines
    expect(narrow.filter((t) => t.label).length).toBeLessThan(
      wide.filter((t) => t.label).length,
    );
  });

  it("never labels more densely than every 2nd hour on D, however wide", () => {
    // Hourly labels would be noise even on a huge screen; 2-hourly is the floor the canvas set.
    const huge = buildTimeTicks("D", back(1), END, 4000);
    expect(huge.filter((t) => t.label).length).toBeLessThanOrEqual(
      Math.ceil(huge.length / 2),
    );
  });

  it("degrades to a single label rather than dividing by zero at zero width", () => {
    const t = buildTimeTicks("M", back(30), END, 0);
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.label !== null)).toBe(true);
  });
});

/**
 * Calibration: at a desktop plot width the fitted density lands where the canvas charts did. Pinned
 * so tuning the estimate cannot silently change every axis in the app.
 */
describe("desktop density matches what the canvas charts shipped", () => {
  const n = (range: "D" | "W" | "M" | "Y", days: number) =>
    buildTimeTicks(range, back(days), END, 812).filter((t) => t.label).length;

  it.each([
    ["D", 1, 12], // canvas: 12
    ["W", 7, 8], //  canvas: 8
    ["M", 30, 8], // canvas: 8
    ["Y", 365, 13], // canvas: 13
  ] as const)("%s", (range, days, canvas) => {
    expect(Math.abs(n(range, days) - canvas)).toBeLessThanOrEqual(1);
  });
});
