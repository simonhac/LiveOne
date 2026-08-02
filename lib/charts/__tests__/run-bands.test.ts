import { describe, expect, it } from "@jest/globals";
import {
  renewablePct,
  runBandsForSeries,
  seriesForRole,
  snapToBandEdges,
} from "../run-bands";
import type { SeriesData } from "../types";
import type { RunPeriodEvent } from "@/lib/queries/runPeriods";

const WINDOW_START = Date.parse("2026-07-28T00:00:00Z");
const WINDOW_END = Date.parse("2026-07-29T00:00:00Z");

function run(start: string, end: string | null): RunPeriodEvent {
  return {
    date: "",
    startTime: "",
    endTime: end,
    startTimeISO: start,
    endTimeISO: end,
    running: end === null,
    energyKwh: 10,
  };
}

const bands = (events: RunPeriodEvent[]) =>
  runBandsForSeries(events, "ev", "ev", WINDOW_START, WINDOW_END);

describe("runBandsForSeries", () => {
  it("keeps a run wholly inside the window as-is", () => {
    const [b] = bands([run("2026-07-28T06:00:00Z", "2026-07-28T09:00:00Z")]);
    expect(b.startMs).toBe(Date.parse("2026-07-28T06:00:00Z"));
    expect(b.endMs).toBe(Date.parse("2026-07-28T09:00:00Z"));
    expect(b.running).toBe(false);
  });

  it("clamps a run that starts before the window", () => {
    const [b] = bands([run("2026-07-27T22:00:00Z", "2026-07-28T02:00:00Z")]);
    expect(b.startMs).toBe(WINDOW_START);
    expect(b.endMs).toBe(Date.parse("2026-07-28T02:00:00Z"));
    // The FIGURES are not clamped — a session that began yesterday still charged what it charged.
    expect(b.event.energyKwh).toBe(10);
  });

  it("clamps an open run to the window END, not to the wall clock", () => {
    // The chart's last sample can be minutes behind now; an overlay past it would sit on empty plot.
    const [b] = bands([run("2026-07-28T23:00:00Z", null)]);
    expect(b.endMs).toBe(WINDOW_END);
    expect(b.running).toBe(true);
  });

  it("drops runs outside the window, and ones that only touch its edge", () => {
    expect(
      bands([
        run("2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z"), // entirely before
        run("2026-07-30T00:00:00Z", "2026-07-30T01:00:00Z"), // entirely after
        run("2026-07-27T20:00:00Z", "2026-07-28T00:00:00Z"), // ends exactly at the start
      ]),
    ).toEqual([]);
  });

  it("skips rows with no usable timestamps rather than emitting NaN geometry", () => {
    const noStart = {
      ...run("2026-07-28T06:00:00Z", null),
      startTimeISO: undefined,
    };
    const badEnd = run("2026-07-28T06:00:00Z", "not a date");
    expect(bands([noStart, badEnd])).toEqual([]);
  });

  it("keys a band on the run's OWN start, so panning cannot re-key it mid-hover", () => {
    const event = run("2026-07-27T22:00:00Z", "2026-07-28T02:00:00Z");
    const wide = runBandsForSeries(
      [event],
      "ev",
      "ev",
      WINDOW_START - 86_400_000,
      WINDOW_END,
    );
    expect(bands([event])[0].id).toBe(wide[0].id);
    expect(bands([event])[0].startMs).not.toBe(wide[0].startMs);
  });
});

describe("snapToBandEdges", () => {
  // A 5-minute grid, as the D-period chart draws.
  const grid = [0, 5, 10, 15, 20, 25, 30, 35].map(
    (m) =>
      new Date(Date.parse(`2026-07-28T00:${String(m).padStart(2, "0")}:00Z`)),
  );
  const at = (m: number) =>
    Date.parse(`2026-07-28T00:${String(m).padStart(2, "0")}:00Z`);
  /** A band that is flat everywhere: nothing to walk down, so only the sample snap applies. */
  const flat = grid.map(() => 7.2);

  it("widens outward to the enclosing samples", () => {
    // 🛑 The bug this fixes: a boundary part-way down the band's falling edge puts the overlay's
    // vertical through the middle of the shape, leaving an un-outlined sliver beside it.
    expect(snapToBandEdges(at(6), at(12), grid, flat)).toEqual({
      startMs: at(5),
      endMs: at(15),
    });
  });

  it("walks on down the band's ramp to its foot", () => {
    // 🛑 The second half of the same bug. The enclosing sample is the band's SHOULDER; the descent
    // to zero happens over the intervals BEYOND it, so snapping alone still drops the outline to the
    // axis before the fill gets there. A real session's last interval is a partial average, which is
    // why the tail is 7.2 → 3.6 → 0 rather than a single step to zero.
    const values = [0, 3.6, 7.2, 7.2, 7.2, 3.6, 0, 0];
    expect(snapToBandEdges(at(12), at(22), grid, values)).toEqual({
      startMs: at(0),
      endMs: at(30),
    });
  });

  it("stops where the band stops falling — back-to-back runs do not swallow each other", () => {
    // The band dips between two sessions but never reaches the axis. The boundary belongs at the
    // trough, not one sample into the next run's rise.
    const values = [7.2, 7.2, 4.1, 6.8, 7.2, 7.2, 7.2, 7.2];
    expect(snapToBandEdges(at(5), at(6), grid, values)).toEqual({
      startMs: at(5),
      endMs: at(10),
    });
  });

  it("stops at a gap — a break in the drawn band is not a ramp", () => {
    // Extending onto a null puts the vertical where there is nothing to clip against, which leaves
    // the outline open on that side.
    const values = [7.2, null, 7.2, 7.2, 5.0, null, 0, 0];
    expect(snapToBandEdges(at(12), at(17), grid, values)).toEqual({
      startMs: at(10),
      endMs: at(20),
    });
  });

  it("caps the walk on a long monotone decline", () => {
    // MAX_RAMP_SAMPLES = 4. Without a cap a slowly-decaying band would drag the boundary arbitrarily
    // far from the run it is meant to bracket.
    const values = [1, 2, 3, 4, 5, 6, 7, 8].reverse();
    expect(snapToBandEdges(at(0), at(0), grid, values)).toEqual({
      startMs: at(0),
      endMs: at(20),
    });
  });

  it("leaves a span already on the grid alone", () => {
    expect(snapToBandEdges(at(5), at(15), grid, flat)).toEqual({
      startMs: at(5),
      endMs: at(15),
    });
  });

  it("never shrinks a run", () => {
    const { startMs, endMs } = snapToBandEdges(at(6), at(12), grid, flat);
    expect(startMs).toBeLessThanOrEqual(at(6));
    expect(endMs).toBeGreaterThanOrEqual(at(12));
  });

  it("leaves a boundary outside the grid where it is", () => {
    // Already window-clamped by `runBandsForSeries`, so there is no sample to snap to — and no
    // vertex to walk a ramp from either.
    expect(snapToBandEdges(at(0) - 60_000, at(40), grid, flat)).toEqual({
      startMs: at(0) - 60_000,
      endMs: at(40),
    });
  });

  it("snaps without walking when the band's values are unknown", () => {
    expect(snapToBandEdges(at(6), at(12), grid)).toEqual({
      startMs: at(5),
      endMs: at(15),
    });
  });

  it("is a no-op with no samples", () => {
    expect(snapToBandEdges(at(6), at(12), [], [])).toEqual({
      startMs: at(6),
      endMs: at(12),
    });
  });
});

describe("seriesForRole", () => {
  const series = [
    { id: "ev-load", flowPath: "load.ev" },
    { id: "rest-of-house", flowPath: "load.rest-of-house" },
  ] as SeriesData[];

  it("matches on the flow path, not the display id", () => {
    expect(seriesForRole("ev", series, new Set(["ev-load"]))?.id).toBe(
      "ev-load",
    );
  });

  it("ignores a hidden series — legend visibility takes the overlay with it", () => {
    expect(seriesForRole("ev", series, new Set(["rest-of-house"]))).toBeNull();
  });

  it("returns null for a role this chart has no band for", () => {
    expect(seriesForRole("generator", series, new Set(["ev-load"]))).toBeNull();
  });
});

describe("renewablePct", () => {
  it("states the share as a percentage of the run's own energy", () => {
    expect(
      renewablePct({ ...run("", null), energyKwh: 20, renewableKwh: 5 }),
    ).toBe(25);
  });

  it("is null when unknown or when there is no energy to divide by", () => {
    expect(renewablePct({ ...run("", null), renewableKwh: null })).toBeNull();
    expect(
      renewablePct({ ...run("", null), energyKwh: 0, renewableKwh: 0 }),
    ).toBeNull();
  });
});
