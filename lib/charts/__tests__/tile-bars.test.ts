import { describe, it, expect } from "@jest/globals";
import { bucketBars, dayTicks, sumSeries } from "../tile-bars";

const AEST = 600;
/** A UTC instant for a local AEST wall-clock time on 2026-09-19. */
const at = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 8, 19, h, m) - AEST * 60_000);

/** Every 5 minutes from local `fromH` to (exclusive) `toH`. */
function grid(fromH: number, toH: number): Date[] {
  const out: Date[] = [];
  for (let t = at(fromH).getTime(); t < at(toH).getTime(); t += 300_000)
    out.push(new Date(t));
  return out;
}

describe("bucketBars — D", () => {
  it("one bar per local hour, the mean of its samples", () => {
    const ts = grid(0, 2);
    const vals = ts.map((_, i) => (i < 12 ? 1000 : 3000));
    const bars = bucketBars(ts, vals, "D", AEST);
    expect(bars.map((b) => b.value)).toEqual([1000, 3000]);
  });

  it("ticks the four Activity hours, in the subject's timezone", () => {
    const ts = grid(0, 24);
    const bars = bucketBars(
      ts,
      ts.map(() => 1),
      "D",
      AEST,
    );
    expect(bars).toHaveLength(24);
    expect(bars.flatMap((b, i) => (b.tick ? [[i, b.tick]] : []))).toEqual([
      [0, "12 am"],
      [6, "6 am"],
      [12, "12 pm"],
      [18, "6 pm"],
    ]);
  });

  it("a bucket with no reading is a gap, not zero", () => {
    const ts = grid(0, 3);
    const vals = ts.map((_, i) => (i >= 12 && i < 24 ? null : 0));
    expect(bucketBars(ts, vals, "D", AEST).map((b) => b.value)).toEqual([
      0,
      null,
      0,
    ]);
  });
});

describe("bucketBars — W/M/Y", () => {
  it("W buckets by local day with weekday ticks", () => {
    const ts = [at(1), at(23), new Date(at(1).getTime() + 86_400_000)];
    const bars = bucketBars(ts, [2, 4, 6], "W", AEST);
    expect(bars).toEqual([
      { value: 3, tick: "S" },
      { value: 6, tick: "S" },
    ]);
  });

  it("Y buckets by local month and ticks quarters", () => {
    const ts = [0, 1, 2, 3].map(
      (m) => new Date(Date.UTC(2026, m, 15) - AEST * 60_000),
    );
    const bars = bucketBars(ts, [1, 2, 3, 4], "Y", AEST);
    expect(bars.map((b) => b.tick)).toEqual([
      "Jan",
      undefined,
      undefined,
      "Apr",
    ]);
  });
});

describe("sumSeries", () => {
  it("is null only where every series is", () => {
    expect(
      sumSeries([
        [1, null, null],
        [2, 5, null],
      ]),
    ).toEqual([3, 5, null]);
  });
});

describe("dayTicks", () => {
  it("places the four ticks positionally", () => {
    const ts = grid(0, 24);
    const ticks = dayTicks(ts, AEST);
    expect(ticks.map((t) => t.label)).toEqual([
      "12 am",
      "6 am",
      "12 pm",
      "6 pm",
    ]);
    expect(ticks[0].at).toBe(0);
    expect(ticks[2].at).toBeCloseTo(144 / 287);
  });
});
