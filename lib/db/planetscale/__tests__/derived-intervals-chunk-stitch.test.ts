/**
 * A run that is still going when the recompute window ends.
 *
 * 🛑 The reason this exists: `recomputeRange` walks a historical range in 14-day chunks, and
 * `detectRunPeriods` closes its final run at the last on-sample it can see. A read that stopped dead
 * at the window's edge therefore made a run that was STILL RUNNING look like a run that ended there
 * — and the next chunk, finding no straddler to anchor on, discarded the continuation because it
 * started before the anchor. The charging after the boundary was lost outright: measured on prod
 * 2026-08-02, four boundary days accounted for 21.8 kWh of energy attributed to no run.
 *
 * Two properties keep it fixed: the trailing read margin (a run that continues is stored with an end
 * PAST the window, which is what the next chunk anchors on) and the delayOff-tolerant straddler test
 * (which stitches a row that was ALREADY stored truncated, without re-running the whole range).
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";
import type { PointId } from "@/lib/ids";

interface StoredRow {
  startTime: Date;
  endTime: Date | null;
  energyKwh: number | null;
}

/** The straddler the fake `select` hands back — the previous chunk's stored row, or nothing. */
let straddler: { startTime: Date; endTime: Date | null }[] = [];
let inserted: StoredRow[] = [];
let deleted = 0;

const readRaw =
  jest.fn<
    (
      ids: PointId[],
      window: { fromMs: number; toMs: number },
      exec?: unknown,
    ) => Promise<Map<PointId, { measurementTimeMs: number; value: number }[]>>
  >();

jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    readRaw: (
      ids: PointId[],
      window: { fromMs: number; toMs: number },
      exec?: unknown,
    ) => readRaw(ids, window, exec),
  },
}));
// Provenance is resolved from the persisted blend and is not what this test is about.
jest.mock("@/lib/run-tracking/intensity", () => ({
  resolveIntensitySeries: async () => null,
}));
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));

import { recomputeIntervalsForWindow } from "../derived-intervals-pg";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The chunk boundary under test, and "now" — far later, so every run closes by the tail rule. */
const BOUNDARY = Date.parse("2026-01-23T00:00:00Z");
const NOW = BOUNDARY + 90 * DAY;

const SIGNAL = "pt_signal" as unknown as PointId;
const ENERGY = "pt_energy" as unknown as PointId;

const DETECTOR = {
  id: "ev-derivation",
  signalPoint: SIGNAL,
  energyPoint: ENERGY,
  signalUnit: "W",
  detectorVersion: 1,
  detect: {
    upperW: 1000,
    lowerW: null,
    hysteresisW: 0,
    delayOnMs: 5 * MIN,
    delayOffMs: 30 * MIN,
    nowMs: NOW,
    boundaryMode: "edge" as const,
  },
} as unknown as ResolvedRunDetector;

/** The run under test: charging at 3 kW from 3h before the boundary to 3h after it. */
const RUN_START = BOUNDARY - 3 * HOUR;
const RUN_END = BOUNDARY + 3 * HOUR;
const SAMPLE_MS = 5 * MIN;

/** Signal samples every 5 min: 3000 W inside the run, 0 W outside it. */
function signalSeries(fromMs: number, toMs: number) {
  const out: { measurementTimeMs: number; value: number }[] = [];
  const first = Math.ceil(fromMs / SAMPLE_MS) * SAMPLE_MS;
  for (let t = first; t <= toMs; t += SAMPLE_MS) {
    out.push({
      measurementTimeMs: t,
      value: t >= RUN_START && t <= RUN_END ? 3000 : 0,
    });
  }
  return out;
}

/** A monotonic Wh counter tracking the signal: 3 kW for 5 min = 250 Wh per sample while running. */
function energySeries(fromMs: number, toMs: number) {
  const out: { measurementTimeMs: number; value: number }[] = [];
  const first = Math.ceil(fromMs / SAMPLE_MS) * SAMPLE_MS;
  for (let t = first; t <= toMs; t += SAMPLE_MS) {
    const ranFor = Math.min(Math.max(t - RUN_START, 0), RUN_END - RUN_START);
    out.push({ measurementTimeMs: t, value: (ranFor / SAMPLE_MS) * 250 });
  }
  return out;
}

/** The slice of the drizzle surface `recomputeIntervalsForWindow` actually drives. */
function fakeDb() {
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => straddler }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          const rows = Array.from({ length: deleted }, () => ({
            startTime: new Date(0),
          }));
          return rows;
        },
      }),
    }),
    insert: () => ({
      values: async (rows: StoredRow[]) => {
        inserted.push(...rows);
      },
    }),
  };
  return {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  straddler = [];
  inserted = [];
  deleted = 0;
  readRaw.mockImplementation(async (ids, window) => {
    const id = ids[0];
    return new Map([
      [
        id,
        id === SIGNAL
          ? signalSeries(window.fromMs, window.toMs)
          : energySeries(window.fromMs, window.toMs),
      ],
    ]);
  });
});

describe("recomputeIntervalsForWindow at a chunk boundary", () => {
  it("stores a still-running run with an end PAST the window, not clipped to it", async () => {
    const res = await recomputeIntervalsForWindow(
      fakeDb(),
      DETECTOR,
      BOUNDARY - 14 * DAY,
      BOUNDARY,
      NOW,
    );

    expect(res.inserted).toBe(1);
    expect(inserted[0].startTime.getTime()).toBe(RUN_START);
    // The trailing margin: the run is carried delayOff past the boundary, which is precisely what
    // makes the next chunk's straddler test fire. Clipped to `winEndMs`, it would not.
    expect(inserted[0].endTime!.getTime()).toBe(BOUNDARY + 30 * MIN);
    // ...and its energy counter is read that far too. Clipped at the window edge it would be 9 kWh.
    expect(inserted[0].energyKwh).toBeCloseTo(10.5, 3);
  });

  it("stitches the continuation onto the straddler in the next chunk", async () => {
    straddler = [
      {
        startTime: new Date(RUN_START),
        endTime: new Date(BOUNDARY + 30 * MIN),
      },
    ];
    deleted = 1;

    const res = await recomputeIntervalsForWindow(
      fakeDb(),
      DETECTOR,
      BOUNDARY,
      BOUNDARY + 14 * DAY,
      NOW,
    );

    // ONE run spanning the boundary — not a dropped continuation, and not a second fragment.
    expect(res.inserted).toBe(1);
    expect(inserted[0].startTime.getTime()).toBe(RUN_START);
    expect(inserted[0].endTime!.getTime()).toBe(RUN_END);
    expect(inserted[0].energyKwh).toBeCloseTo(18, 3);
  });

  it("stitches a row that was ALREADY stored truncated just before the boundary", async () => {
    // What prod looks like today: the pre-fix pass clipped the run at its last on-sample before the
    // boundary. A strict `end >= winStart` test misses it by five minutes and drops the rest of the
    // charge; the delayOff tolerance re-anchors and heals it in place.
    straddler = [
      { startTime: new Date(RUN_START), endTime: new Date(BOUNDARY - 5 * MIN) },
    ];
    deleted = 1;

    const res = await recomputeIntervalsForWindow(
      fakeDb(),
      DETECTOR,
      BOUNDARY,
      BOUNDARY + 14 * DAY,
      NOW,
    );

    expect(res.inserted).toBe(1);
    expect(inserted[0].startTime.getTime()).toBe(RUN_START);
    expect(inserted[0].endTime!.getTime()).toBe(RUN_END);
  });

  it("does not re-anchor on a run that genuinely ended before the window", async () => {
    // Ended well over delayOff before the window start: nothing this window sees could have
    // continued it, so it keeps its own boundary and the window stays anchored where it was asked
    // to be. The tolerance is a repair for a read artefact, not a licence to widen every rebuild.
    straddler = [
      {
        startTime: new Date(BOUNDARY - 10 * HOUR),
        endTime: new Date(BOUNDARY - 2 * HOUR),
      },
    ];

    const res = await recomputeIntervalsForWindow(
      fakeDb(),
      DETECTOR,
      BOUNDARY,
      BOUNDARY + 14 * DAY,
      NOW,
    );

    expect(res.inserted).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});
