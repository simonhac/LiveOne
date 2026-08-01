import { describe, it, expect } from "@jest/globals";
import {
  SLOTS_PER_DAY,
  bucketHeatmap,
  buildTimeLabels,
  dayKeyAt,
  daysOffFrame,
  offsetMinAt,
  resolveFrameOffsetMin,
  slotKeyAt,
} from "../heatmap-buckets";

const AEST = 600; // +10:00, Australia/Melbourne standard time — the fixed day offset
const ZONE = "Australia/Melbourne";
const HALF_HOUR = 30 * 60 * 1000;

/**
 * The two 2026 Melbourne DST transitions, which are the whole reason this module exists.
 *  - 2026-04-05 03:00 AEDT → 02:00 AEST (fall back; 02:00–03:00 local happens TWICE)
 *  - 2026-10-04 02:00 AEST → 03:00 AEDT (spring forward; 02:00–03:00 local never happens)
 */
const FALL_BACK_DAY = "2026-04-05";
const SPRING_FORWARD_DAY = "2026-10-04";

describe("time labels", () => {
  it("is always a 48-slot day", () => {
    const labels = buildTimeLabels();
    expect(labels).toHaveLength(SLOTS_PER_DAY);
    expect(labels[0]).toBe("00:00");
    expect(labels[1]).toBe("00:30");
    expect(labels[47]).toBe("23:30");
  });
});

describe("fixed-offset keys", () => {
  it("maps a UTC instant into the +10 frame", () => {
    // 2026-06-14T14:00Z is 2026-06-15 00:00 at +10.
    const ms = Date.parse("2026-06-14T14:00:00Z");
    expect(dayKeyAt(ms, AEST)).toBe("2026-06-15");
    expect(slotKeyAt(ms, AEST)).toBe("00:00");
  });

  it("floors to the half hour rather than rounding", () => {
    const base = Date.parse("2026-06-14T14:00:00Z");
    expect(slotKeyAt(base + 29 * 60_000, AEST)).toBe("00:00");
    expect(slotKeyAt(base + 30 * 60_000, AEST)).toBe("00:30");
    expect(slotKeyAt(base + 59 * 60_000, AEST)).toBe("00:30");
  });

  it("rolls the date at local midnight, not UTC midnight", () => {
    const justBefore = Date.parse("2026-06-14T13:30:00Z"); // 23:30 local
    const justAfter = Date.parse("2026-06-14T14:00:00Z"); // 00:00 local next day
    expect(dayKeyAt(justBefore, AEST)).toBe("2026-06-14");
    expect(dayKeyAt(justAfter, AEST)).toBe("2026-06-15");
  });
});

describe("bucketHeatmap", () => {
  /** A dense series of `count` half-hourly readings whose value is its own index. */
  const series = (count: number, firstEndIso: string) => ({
    values: Array.from({ length: count }, (_, i) => i),
    firstIntervalEndMs: Date.parse(firstEndIso),
    intervalMs: HALF_HOUR,
    frameOffsetMin: AEST,
  });

  it("places a reading by its interval START, not its end", () => {
    // First interval ENDS at 00:30 local ⇒ it covers 00:00–00:30 ⇒ column 00:00.
    const s = series(1, "2026-06-14T14:30:00Z");
    const { cells } = bucketHeatmap(s.values, s);
    const filled = cells.filter((c) => c.v !== null);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ x: "00:00", y: "2026-06-15", v: 0 });
  });

  it("gives every day exactly 48 cells and orders rows newest-first", () => {
    const s = series(SLOTS_PER_DAY * 3, "2026-06-12T14:30:00Z");
    const { cells, dayKeys } = bucketHeatmap(s.values, s);
    expect(dayKeys).toEqual(["2026-06-15", "2026-06-14", "2026-06-13"]);
    for (const day of dayKeys) {
      expect(cells.filter((c) => c.y === day)).toHaveLength(SLOTS_PER_DAY);
    }
  });

  it("reports the real min/max and falls back to 0..1 when everything is null", () => {
    const s = series(SLOTS_PER_DAY, "2026-06-14T14:30:00Z");
    expect(bucketHeatmap(s.values, s)).toMatchObject({ min: 0, max: 47 });

    const allNull = Array.from({ length: SLOTS_PER_DAY }, () => null);
    expect(bucketHeatmap(allNull, s)).toMatchObject({ min: 0, max: 1 });
  });

  // ---- the defects this module exists to kill ------------------------------------------------

  it("DST fall-back: keeps all 48 readings — no slot is overwritten", () => {
    // A full local day spanning the 2026-04-05 fall-back. Under DST-aware bucketing two intervals
    // collided on 02:00/02:30 and the later silently overwrote the earlier, losing an hour.
    const s = series(SLOTS_PER_DAY, "2026-04-04T14:30:00Z");
    const { cells } = bucketHeatmap(s.values, s);
    const day = cells.filter((c) => c.y === FALL_BACK_DAY);
    expect(day).toHaveLength(SLOTS_PER_DAY);
    expect(day.filter((c) => c.v === null)).toHaveLength(0);
    // Every distinct reading survived — the real test of "nothing was overwritten".
    expect(new Set(day.map((c) => c.v)).size).toBe(SLOTS_PER_DAY);
  });

  it("DST spring-forward: 02:00 and 02:30 carry data, not a fabricated gap", () => {
    const s = series(SLOTS_PER_DAY, "2026-10-03T14:30:00Z");
    const { cells } = bucketHeatmap(s.values, s);
    const day = cells.filter((c) => c.y === SPRING_FORWARD_DAY);
    expect(day).toHaveLength(SLOTS_PER_DAY);
    for (const slot of ["02:00", "02:30"]) {
      expect(day.find((c) => c.x === slot)?.v).not.toBeNull();
    }
  });
});

describe("offsetMinAt", () => {
  it("reads standard and daylight offsets for Melbourne", () => {
    expect(offsetMinAt("2026-06-15T12:00:00Z", ZONE)).toBe(600); // AEST
    expect(offsetMinAt("2026-01-15T12:00:00Z", ZONE)).toBe(660); // AEDT
  });

  it("handles a zone with no DST and a half-hour offset", () => {
    expect(offsetMinAt("2026-06-15T12:00:00Z", "Australia/Brisbane")).toBe(600);
    expect(offsetMinAt("2026-06-15T12:00:00Z", "Australia/Darwin")).toBe(570);
  });

  it("returns null rather than throwing for an unusable zone", () => {
    expect(offsetMinAt("2026-06-15T12:00:00Z", "Not/AZone")).toBeNull();
    expect(offsetMinAt("nonsense", ZONE)).toBeNull();
  });
});

describe("daysOffFrame", () => {
  it("marks only the days whose real offset differs from the labelling frame", () => {
    const days = ["2026-06-15", "2026-01-15", "2026-06-16"];
    // Frame = AEST. The January day was on AEDT, so it is the odd one out.
    expect(daysOffFrame(days, ZONE, 600)).toEqual(new Set(["2026-01-15"]));
  });

  it("marks nothing when the site does not observe DST", () => {
    const days = ["2026-06-15", "2026-01-15"];
    expect(daysOffFrame(days, "Australia/Brisbane", 600).size).toBe(0);
  });

  it("marks every day when the frame is the one that is unusual", () => {
    // Frame = AEDT (+11) but both sampled days are AEST.
    const days = ["2026-06-15", "2026-06-16"];
    expect(daysOffFrame(days, ZONE, 660).size).toBe(2);
  });

  it("samples at local midday, so a transition day resolves unambiguously", () => {
    // Both transition days must classify without landing in the doubled/missing hour.
    expect(() =>
      daysOffFrame([FALL_BACK_DAY, SPRING_FORWARD_DAY], ZONE, 600),
    ).not.toThrow();
    // 2026-04-05 midday is already back on AEST; 2026-10-04 midday is already on AEDT.
    expect(daysOffFrame([FALL_BACK_DAY], ZONE, 600).size).toBe(0);
    expect(daysOffFrame([SPRING_FORWARD_DAY], ZONE, 600)).toEqual(
      new Set([SPRING_FORWARD_DAY]),
    );
  });
});

describe("resolveFrameOffsetMin — the rolling frame", () => {
  const at = (iso: string) => Date.parse(iso);

  it("follows the newest reading's real offset", () => {
    expect(resolveFrameOffsetMin(at("2026-06-15T02:00:00Z"), ZONE, 600)).toBe(
      600,
    ); // AEST
    expect(resolveFrameOffsetMin(at("2026-01-15T02:00:00Z"), ZONE, 600)).toBe(
      660,
    ); // AEDT
  });

  it("falls back to the area's fixed offset when the zone is unusable", () => {
    // A bad display_timezone must degrade to standard time, not break the chart.
    expect(
      resolveFrameOffsetMin(at("2026-06-15T02:00:00Z"), "Not/AZone", 570),
    ).toBe(570);
  });
});

/**
 * The measurement that decided the frame convention (see the module doc). A standard-time frame
 * asterisks EVERY row of a midsummer window, which makes the mark meaningless exactly when it fires
 * most; anchoring to the newest day marks rows only near a real transition.
 */
describe("frame choice — why the frame rolls", () => {
  const thirtyDaysTo = (endIso: string) =>
    Array.from({ length: 30 }, (_, i) =>
      new Date(Date.parse(endIso) - (29 - i) * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );

  const marked = (endIso: string, frame: number) =>
    daysOffFrame(thirtyDaysTo(endIso), ZONE, frame).size;

  it("a standard-time frame would mark all 30 rows in midsummer", () => {
    expect(marked("2026-01-20T00:00:00Z", 600)).toBe(30);
  });

  it("the rolling frame marks none in midsummer or midwinter", () => {
    expect(marked("2026-01-20T00:00:00Z", 660)).toBe(0); // frame = AEDT, as the newest day is
    expect(marked("2026-06-20T00:00:00Z", 600)).toBe(0); // frame = AEST, as the newest day is
  });

  it("but still marks the days that genuinely differ, spanning a transition", () => {
    const n = marked("2026-04-20T00:00:00Z", 600);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(30);
  });
});
