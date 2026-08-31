import { describe, it, expect, beforeEach } from "@jest/globals";
import { Point } from "@/lib/ids";
import { PointReference } from "@/lib/identifiers";
import type {
  LogicalSystem,
  LogicalSystemPoint,
} from "@/lib/aggregation/logical-system";
import type { DailyFlowMatrices } from "@/lib/energy-flow-matrix";
import type { AttrRollupRow } from "@/lib/aggregation/flow-attr-read";

// ── Mocks: the rollup read + the per-segment live builders + the DB handle ─────────────────────────
const rollupRows: AttrRollupRow[] = [];
const rollupCalls: Array<{ startYMD: string; endYMD: string }> = [];
jest.mock("@/lib/aggregation/flow-attr-read", () => ({
  readAttrRollupRows: async (
    _db: unknown,
    _areaId: string,
    startYMD: string,
    endYMD: string,
  ) => {
    rollupCalls.push({ startYMD, endYMD });
    return rollupRows.filter((r) => r.day >= startYMD && r.day <= endYMD);
  },
}));

const liveCalls: Array<{ startMs: number; endMs: number }> = [];
let inFlight = 0;
let maxInFlight = 0;
const energyOnlyCalls: Array<{ startMs: number; endMs: number }> = [];
let liveResult: (seg: {
  startMs: number;
  endMs: number;
}) => DailyFlowMatrices | null;
let liveThrows = false;
jest.mock("@/lib/history/build-attributed-flow-matrix", () => ({
  buildAttributedFlowMatrix: async (
    _handle: number,
    startMs: number,
    endMs: number,
  ) => {
    liveCalls.push({ startMs, endMs });
    if (liveThrows) throw new Error("metric-leg input failed");
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return liveResult({ startMs, endMs });
  },
  buildEnergyOnlyAttributedMatrix: async (
    _handle: number,
    startMs: number,
    endMs: number,
  ) => {
    energyOnlyCalls.push({ startMs, endMs });
    return liveResult({ startMs, endMs });
  },
}));

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({}),
  planetscaleDb: {},
}));

import {
  splitWindowIntoLocalDays,
  buildAttributedFlowWindow,
} from "../attributed-window";

const DAY = 24 * 60 * 60 * 1000;
const TZ = 600; // UTC+10 — local midnight is 14:00Z the previous UTC day
// 2026-06-01 00:00 local
const D1 = Date.UTC(2026, 4, 31, 14);

const uid = (i: number) =>
  Point.encode(`019ec06c-f635-7000-8000-${String(i).padStart(12, "0")}`);
const mkPoint = (i: number, stem: string): LogicalSystemPoint => ({
  point: uid(i),
  ref: PointReference.fromIds(9, i),
  stem,
  metricType: "power",
  metricUnit: "W",
  transform: null,
  displayName: stem,
});
const LS: LogicalSystem = {
  id: 9,
  areaId: "area-test-9",
  timezoneOffsetMin: TZ,
  points: [mkPoint(1, "source.solar"), mkPoint(2, "load")],
  energyPoints: [],
  isComplete: true,
};

/** A live 1-day result with a single solar→load edge of `kwh` keyed to `day`. */
function liveDay(day: string, kwh: number): DailyFlowMatrices {
  return {
    sources: [{ id: "source.solar", label: "Solar", color: "#fc0" }],
    loads: [{ id: "load", label: "Load", color: "#48f" }],
    days: [
      {
        day,
        matrix: [[kwh]],
        emissionsG: [[null]],
        renewableKwh: [[kwh]],
        selfRenewableKwh: [[kwh]],
        costC: [[null]],
        revenueC: [[null]],
        estimatedKwh: [[0]],
      },
    ],
  };
}

function rollupRow(day: string, kwh: number): AttrRollupRow {
  return {
    day,
    sourcePath: "source.solar",
    loadPath: "load",
    energyKwh: kwh,
    emissionsG: null,
    renewableKwh: kwh,
    selfRenewableKwh: kwh,
    costC: null,
    revenueC: null,
    estimatedKwh: 0,
  };
}

beforeEach(() => {
  rollupRows.length = 0;
  rollupCalls.length = 0;
  liveCalls.length = 0;
  energyOnlyCalls.length = 0;
  liveThrows = false;
  liveResult = () => null;
  inFlight = 0;
  maxInFlight = 0;
});

describe("splitWindowIntoLocalDays", () => {
  it("splits an aligned multi-day window into full days", () => {
    const segs = splitWindowIntoLocalDays(D1, D1 + 3 * DAY, TZ);
    expect(segs).toEqual([
      { day: "2026-06-01", startMs: D1, endMs: D1 + DAY, full: true },
      { day: "2026-06-02", startMs: D1 + DAY, endMs: D1 + 2 * DAY, full: true },
      {
        day: "2026-06-03",
        startMs: D1 + 2 * DAY,
        endMs: D1 + 3 * DAY,
        full: true,
      },
    ]);
  });

  it("marks partial edge days on a rolling window (leading AND trailing)", () => {
    // 10:00 local day 1 → 10:00 local day 3: partial, full, partial.
    const start = D1 + 10 * 3600_000;
    const segs = splitWindowIntoLocalDays(start, start + 2 * DAY, TZ);
    expect(segs.map((s) => [s.day, s.full])).toEqual([
      ["2026-06-01", false],
      ["2026-06-02", true],
      ["2026-06-03", false],
    ]);
    expect(segs[0]).toMatchObject({ startMs: start, endMs: D1 + DAY });
    expect(segs[2]).toMatchObject({
      startMs: D1 + 2 * DAY,
      endMs: start + 2 * DAY,
    });
  });

  it("a sub-day window inside one local day is a single partial segment", () => {
    const segs = splitWindowIntoLocalDays(D1 + 3600_000, D1 + 5 * 3600_000, TZ);
    expect(segs).toEqual([
      {
        day: "2026-06-01",
        startMs: D1 + 3600_000,
        endMs: D1 + 5 * 3600_000,
        full: false,
      },
    ]);
  });

  it("an exactly-one-local-day window is one full segment", () => {
    expect(splitWindowIntoLocalDays(D1, D1 + DAY, TZ)).toEqual([
      { day: "2026-06-01", startMs: D1, endMs: D1 + DAY, full: true },
    ]);
  });
});

describe("buildAttributedFlowWindow", () => {
  it("serves whole days from ONE rollup range read and live-computes only the partial edges", async () => {
    const start = D1 + 10 * 3600_000; // 10:00 local day 1
    rollupRows.push(rollupRow("2026-06-02", 5));
    liveResult = (seg) =>
      liveDay(seg.startMs === start ? "2026-06-01" : "2026-06-03", 2);

    const out = await buildAttributedFlowWindow(9, start, start + 2 * DAY, LS);

    // One rollup read covering exactly the full-day range.
    expect(rollupCalls).toEqual([
      { startYMD: "2026-06-02", endYMD: "2026-06-02" },
    ]);
    // Live computes for the two partial segments only.
    expect(liveCalls).toEqual([
      { startMs: start, endMs: D1 + DAY },
      { startMs: D1 + 2 * DAY, endMs: start + 2 * DAY },
    ]);
    // Merged: three day entries, one per local day, in order.
    expect(out!.days.map((d) => d.day)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(out!.days.map((d) => d.matrix[0][0])).toEqual([2, 5, 2]);
  });

  it("a full day MISSING from the rollup falls back to the live compute for that day", async () => {
    // 2-day aligned window; only day 1 is materialised.
    rollupRows.push(rollupRow("2026-06-01", 7));
    liveResult = () => liveDay("2026-06-02", 3);

    const out = await buildAttributedFlowWindow(9, D1, D1 + 2 * DAY, LS);

    expect(liveCalls).toEqual([{ startMs: D1 + DAY, endMs: D1 + 2 * DAY }]);
    expect(out!.days.map((d) => [d.day, d.matrix[0][0]])).toEqual([
      ["2026-06-01", 7],
      ["2026-06-02", 3],
    ]);
  });

  it("a live segment whose full build throws degrades to the energy-only builder", async () => {
    liveThrows = true;
    liveResult = () => liveDay("2026-06-01", 4);

    const out = await buildAttributedFlowWindow(9, D1, D1 + 6 * 3600_000, LS);

    expect(energyOnlyCalls).toEqual([
      { startMs: D1, endMs: D1 + 6 * 3600_000 },
    ]);
    expect(out!.days[0].matrix[0][0]).toBe(4);
  });

  it("returns null when nothing yields a row (nothing to serve)", async () => {
    liveResult = () => null;
    const out = await buildAttributedFlowWindow(9, D1, D1 + DAY + 3600_000, LS);
    expect(out).toBeNull();
  });

  it("unions node sets across rollup and live days (a node absent one day still indexes)", async () => {
    const start = D1 + 10 * 3600_000;
    rollupRows.push(rollupRow("2026-06-02", 5), {
      ...rollupRow("2026-06-02", 1.5),
      sourcePath: "source.battery",
    });
    liveResult = (seg) =>
      seg.startMs === start ? liveDay("2026-06-01", 2) : null;

    const out = await buildAttributedFlowWindow(9, start, start + 2 * DAY, LS);

    expect(out!.sources.map((s) => s.id)).toEqual([
      "source.solar",
      "source.battery",
    ]);
    // Day 1 (live) has no battery row → dense zero in the union grid.
    const day1 = out!.days.find((d) => d.day === "2026-06-01")!;
    const batteryIdx = 1;
    expect(day1.matrix[batteryIdx][0]).toBe(0);
    expect(day1.matrix[0][0]).toBe(2);
  });

  it("coalesces ADJACENT missing days into one span (work scales with gaps, not day count)", async () => {
    // 5 aligned days, none materialised → one span, not five calls.
    liveResult = (seg) =>
      liveDay("2026-06-01", (seg.endMs - seg.startMs) / DAY);
    const out = await buildAttributedFlowWindow(9, D1, D1 + 5 * DAY, LS);
    expect(liveCalls).toEqual([{ startMs: D1, endMs: D1 + 5 * DAY }]);
    expect(out!.days[0].matrix[0][0]).toBe(5);
  });

  it("does NOT coalesce across a materialised day — per-day edges are preserved", async () => {
    // Days 1,2 missing · day 3 in the rollup · days 4,5 missing → two spans, not one and not four.
    rollupRows.push(rollupRow("2026-06-03", 9));
    liveResult = (seg) =>
      liveDay(seg.startMs === D1 ? "2026-06-01" : "2026-06-04", 1);
    const out = await buildAttributedFlowWindow(9, D1, D1 + 5 * DAY, LS);
    expect(liveCalls).toEqual([
      { startMs: D1, endMs: D1 + 2 * DAY },
      { startMs: D1 + 3 * DAY, endMs: D1 + 5 * DAY },
    ]);
    expect(out!.days.map((d) => d.day)).toEqual([
      "2026-06-01",
      "2026-06-03",
      "2026-06-04",
    ]);
  });

  it("bounds live-segment concurrency so a long unmaterialised range can't drain the pool", async () => {
    // 20 non-adjacent live spans (every second day materialised) — must not all run at once.
    for (let i = 1; i < 40; i += 2)
      rollupRows.push(
        rollupRow(
          new Date(D1 + i * DAY + 12 * 3600_000).toISOString().slice(0, 10),
          1,
        ),
      );
    liveResult = () => null;
    await buildAttributedFlowWindow(9, D1, D1 + 40 * DAY, LS);
    expect(liveCalls.length).toBeGreaterThan(10);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("drops sub-MIN_ATTR_KWH live edges when flattening (mirrors the rollup writer)", async () => {
    liveResult = () => liveDay("2026-06-01", 0.0005); // ≤ 1 Wh → noise
    const out = await buildAttributedFlowWindow(9, D1, D1 + 3600_000, LS);
    expect(out).toBeNull();
  });
});
