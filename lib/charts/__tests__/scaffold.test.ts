import { describe, it, expect } from "@jest/globals";
import {
  buildShadingAnnotations,
  buildTimeScale,
  formatHoverTimestamp,
} from "../scaffold";

// A fixed local-time window so the day/weekday maths is deterministic regardless of the runner TZ.
const now = new Date(2024, 7, 22, 12, 0, 0); // Thu 22 Aug 2024, local noon
const dayMs = 24 * 60 * 60 * 1000;

describe("buildShadingAnnotations", () => {
  it("returns daytime boxes within the window for 1D/7D", () => {
    const windowStart = new Date(now.getTime() - dayMs);
    const boxes = buildShadingAnnotations("1D", now, windowStart);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.type).toBe("box");
      expect(b.borderWidth).toBe(0);
      expect(b.xMin).toBeGreaterThanOrEqual(windowStart.getTime());
      expect(b.xMax).toBeLessThanOrEqual(now.getTime());
      expect(b.xMin).toBeLessThan(b.xMax);
    }
  });

  it("returns weekday boxes for 30D (no weekend shading)", () => {
    const windowStart = new Date(now.getTime() - 30 * dayMs);
    const boxes = buildShadingAnnotations("30D", now, windowStart);
    expect(boxes.length).toBeGreaterThan(0);
    // ~30 days spans ~22 weekdays; never all 31 (weekends excluded).
    expect(boxes.length).toBeLessThan(31);
    for (const b of boxes) {
      const start = new Date(b.xMin);
      // Each box's start clipped to >= windowStart; the underlying day is a weekday (Mon–Fri).
      expect(b.xMin).toBeGreaterThanOrEqual(windowStart.getTime());
      expect(b.xMax).toBeLessThanOrEqual(now.getTime());
      // a clipped box may start at windowStart; otherwise it begins at local midnight of a weekday
      if (b.xMin !== windowStart.getTime()) {
        const dow = start.getDay();
        expect(dow).toBeGreaterThanOrEqual(1);
        expect(dow).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe("buildTimeScale", () => {
  const windowStart = new Date(now.getTime() - dayMs);

  it("spans [windowStart, now] as a time axis with the period unit", () => {
    const s1d = buildTimeScale("1D", now, windowStart);
    expect(s1d.type).toBe("time");
    expect(s1d.min).toBe(windowStart.getTime());
    expect(s1d.max).toBe(now.getTime());
    expect(s1d.time.unit).toBe("hour");
    expect(buildTimeScale("7D", now, windowStart).time.unit).toBe("day");
    expect(buildTimeScale("30D", now, windowStart).time.unit).toBe("day");
  });

  it("1D tick callback shows HH:mm on even ticks, hides odd ticks", () => {
    const cb = buildTimeScale("1D", now, windowStart).ticks.callback;
    const ts = now.getTime();
    expect(cb(ts, 0, [{}, {}, {}])).toMatch(/^\d{2}:\d{2}$/);
    expect(cb(ts, 1, [{}, {}, {}])).toBe("​");
  });

  it("7D tick callback returns a two-line [weekday, date] label", () => {
    const cb = buildTimeScale("7D", now, windowStart).ticks.callback;
    const out = cb(now.getTime(), 0, new Array(7).fill({}));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("30D tick callback skips ticks (5 spaces) and labels the rest", () => {
    const cb = buildTimeScale("30D", now, windowStart).ticks.callback;
    const ticks = new Array(15).fill({}); // skipInterval 2
    expect(Array.isArray(cb(now.getTime(), 0, ticks))).toBe(true);
    expect(cb(now.getTime(), 1, ticks)).toBe("     ");
  });
});

describe("formatHoverTimestamp", () => {
  const d = new Date(2024, 7, 22, 23, 58, 0); // 11:58 PM

  it("returns '' for a null date", () => {
    expect(formatHoverTimestamp(null, "1D")).toBe("");
  });

  it("formats time-only for 1D, date+time for 7D, date-only for 30D", () => {
    expect(formatHoverTimestamp(d, "1D")).toMatch(/^\d{1,2}:\d{2}(am|pm)$/i);
    expect(formatHoverTimestamp(d, "7D")).toMatch(/\d{1,2}:\d{2}(am|pm)$/i);
    expect(formatHoverTimestamp(d, "30D")).not.toMatch(/(am|pm)/i);
  });

  it("drops the year on mobile", () => {
    expect(formatHoverTimestamp(d, "30D", false)).toMatch(/2024/);
    expect(formatHoverTimestamp(d, "30D", true)).not.toMatch(/2024/);
  });
});
