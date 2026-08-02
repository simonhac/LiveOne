/**
 * Re-pricing a run whose provenance inputs moved after it was priced.
 *
 * 🛑 The reason this exists: a run's cost/emissions/renewable columns are accumulated ONCE and
 * stored, while their inputs keep moving (Amber settles over ~72h, OE revises, the nightly heal
 * rewrites the battery blend). Without this pass a run older than the contiguous windows disagrees
 * with the Sankey forever. The properties pinned here are the ones that make it both correct and
 * affordable: only genuinely-moved runs are rebuilt, the rebuild window is the run's OWN span, the
 * coarse month gate keeps a quiet night to one query per bucket, and the caps are visible.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";
import type { PointId } from "@/lib/ids";

const listEnabledRunDetectors =
  jest.fn<(filter?: unknown) => Promise<ResolvedRunDetector[]>>();
const recomputeIntervalsForWindow = jest.fn<
  (...args: unknown[]) => Promise<{
    deleted: number;
    inserted: number;
    open: boolean;
  }>
>();
const resolveIntensityInputPoints =
  jest.fn<(...args: unknown[]) => Promise<PointId[]>>();
const latestAgg5mUpdatedAtForPoints =
  jest.fn<
    (
      points: PointId[],
      opts: { afterIntervalEndMs: number; throughIntervalEndMs: number },
      exec?: unknown,
    ) => Promise<number | null>
  >();

const orderBy = jest.fn<() => Promise<CandidateRow[]>>();
const where = jest.fn(() => ({ orderBy }));
const from = jest.fn(() => ({ where }));
const select = jest.fn(() => ({ from }));

jest.mock("@/lib/derivations/resolve", () => ({
  listEnabledRunDetectors: (filter?: unknown) =>
    listEnabledRunDetectors(filter),
}));
jest.mock("@/lib/db/planetscale/derived-intervals-pg", () => ({
  recomputeIntervalsForWindow: (...args: unknown[]) =>
    recomputeIntervalsForWindow(...args),
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({ select }),
}));
jest.mock("@/lib/run-tracking/intensity", () => ({
  resolveIntensityInputPoints: (...args: unknown[]) =>
    resolveIntensityInputPoints(...args),
}));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: {
    latestAgg5mUpdatedAtForPoints: (
      points: PointId[],
      opts: { afterIntervalEndMs: number; throughIntervalEndMs: number },
      exec?: unknown,
    ) => latestAgg5mUpdatedAtForPoints(points, opts, exec),
  },
}));
// The settlement floor only — importing the real module would drag the whole battery-provenance
// engine (and its DB driver) into a pure orchestration test.
jest.mock("@/lib/battery-provenance/recompute", () => ({
  REHEAL_TRAILING_MS: 4 * 24 * 60 * 60 * 1000,
}));

import { rehealStaleRuns } from "../recompute";

interface CandidateRow {
  startTime: Date;
  endTime: Date | null;
  updatedAt: Date;
}

/** A detector stub — only the fields the reheal itself reads. */
function detector(id: string, role: string, energy: string | null = "pt_e") {
  return {
    id,
    legacyHandle: 8,
    role,
    energyPoint: energy,
  } as unknown as ResolvedRunDetector;
}

const EV = detector("ev-derivation", "ev");
const WATCHED = ["pt_blend", "pt_rate"] as unknown as PointId[];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-02T00:00:00Z");

/** A closed run, `agedDays` before now, priced `pricedDaysAgo` ago. */
function run(agedDays: number, pricedDaysAgo: number): CandidateRow {
  const startMs = NOW - agedDays * DAY;
  return {
    startTime: new Date(startMs),
    endTime: new Date(startMs + 2 * HOUR),
    updatedAt: new Date(NOW - pricedDaysAgo * DAY),
  };
}

/** `agg_5m` rewrites the probe should see: a row stamped at `atMs`, rewritten at `updatedAtMs`. */
let rewrites: { atMs: number; updatedAtMs: number }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  rewrites = [];
  recomputeIntervalsForWindow.mockResolvedValue({
    deleted: 1,
    inserted: 1,
    open: false,
  });
  resolveIntensityInputPoints.mockResolvedValue(WATCHED);
  latestAgg5mUpdatedAtForPoints.mockImplementation(async (_points, opts) => {
    // Right-closed on interval_end, exactly as the DAO query is.
    const hits = rewrites.filter(
      (r) =>
        r.atMs > opts.afterIntervalEndMs && r.atMs <= opts.throughIntervalEndMs,
    );
    return hits.length > 0 ? Math.max(...hits.map((h) => h.updatedAtMs)) : null;
  });
});

describe("rehealStaleRuns", () => {
  it("re-prices only the run whose inputs moved, over that run's own span", async () => {
    const stale = run(30, 29); // priced the day after it ran
    const fresh = run(20, 1); // re-priced yesterday
    listEnabledRunDetectors.mockResolvedValue([EV]);
    orderBy.mockResolvedValue([stale, fresh]);
    // Both runs' spans were rewritten last night; only `stale` was priced before that.
    rewrites = [
      { atMs: stale.startTime.getTime() + HOUR, updatedAtMs: NOW - 0.5 * DAY },
      { atMs: fresh.startTime.getTime() + HOUR, updatedAtMs: NOW - 2 * DAY },
    ];

    const summary = await rehealStaleRuns(NOW);

    expect(summary.repriced).toBe(1);
    expect(summary.capped).toBe(false);
    expect(recomputeIntervalsForWindow).toHaveBeenCalledTimes(1);
    const [, det, winStart, winEnd, nowMs] =
      recomputeIntervalsForWindow.mock.calls[0];
    expect(det).toBe(EV);
    // Exactly the run's span — a wider window would truncate a neighbouring run.
    expect(winStart).toBe(stale.startTime.getTime());
    expect(winEnd).toBe(stale.endTime!.getTime());
    expect(nowMs).toBe(NOW);
  });

  it("leaves a run alone when nothing in its span moved since it was priced", async () => {
    listEnabledRunDetectors.mockResolvedValue([EV]);
    orderBy.mockResolvedValue([run(30, 29)]);
    rewrites = [{ atMs: NOW - 30 * DAY + HOUR, updatedAtMs: NOW - 29.5 * DAY }];

    const summary = await rehealStaleRuns(NOW);

    expect(summary.repriced).toBe(0);
    expect(recomputeIntervalsForWindow).not.toHaveBeenCalled();
  });

  it("skips a whole month on ONE probe when the bucket has not moved", async () => {
    listEnabledRunDetectors.mockResolvedValue([EV]);
    // Three runs in the same UTC month, none of whose inputs moved since pricing.
    orderBy.mockResolvedValue([run(40, 39), run(38, 37), run(36, 35)]);
    rewrites = [{ atMs: NOW - 39 * DAY + HOUR, updatedAtMs: NOW - 39 * DAY }];

    const summary = await rehealStaleRuns(NOW);

    // One bucket probe, and not a single per-run probe behind it.
    expect(latestAgg5mUpdatedAtForPoints).toHaveBeenCalledTimes(1);
    expect(summary.probed).toBe(0);
    expect(summary.repriced).toBe(0);
  });

  it("skips a detector with nothing to watch without probing anything", async () => {
    listEnabledRunDetectors.mockResolvedValue([detector("gen", "generator")]);
    resolveIntensityInputPoints.mockResolvedValue([]);

    const summary = await rehealStaleRuns(NOW);

    expect(summary.detectorsProcessed).toBe(0);
    expect(select).not.toHaveBeenCalled();
    expect(latestAgg5mUpdatedAtForPoints).not.toHaveBeenCalled();
  });

  it("skips a detector with no energy point (nothing was ever priced)", async () => {
    listEnabledRunDetectors.mockResolvedValue([detector("ev2", "ev", null)]);

    const summary = await rehealStaleRuns(NOW);

    expect(summary.detectorsProcessed).toBe(0);
    expect(resolveIntensityInputPoints).not.toHaveBeenCalled();
  });

  it("caps re-prices per pass, oldest first, and says so", async () => {
    const runs = [run(40, 39), run(38, 37), run(36, 35)];
    listEnabledRunDetectors.mockResolvedValue([EV]);
    orderBy.mockResolvedValue(runs);
    rewrites = runs.map((r) => ({
      atMs: r.startTime.getTime() + HOUR,
      updatedAtMs: NOW - 0.5 * DAY,
    }));

    const summary = await rehealStaleRuns(NOW, { limit: 2 });

    expect(summary.repriced).toBe(2);
    expect(summary.capped).toBe(true);
    // Oldest-first: the two oldest runs, and the third is left for the next pass.
    expect(recomputeIntervalsForWindow.mock.calls.map((c) => c[2])).toEqual([
      runs[0].startTime.getTime(),
      runs[1].startTime.getTime(),
    ]);
  });

  it("stops probing at the probe cap rather than grinding all history", async () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(40 - i, 39 - i));
    listEnabledRunDetectors.mockResolvedValue([EV]);
    orderBy.mockResolvedValue(runs);
    rewrites = runs.map((r) => ({
      atMs: r.startTime.getTime() + HOUR,
      updatedAtMs: NOW - 0.5 * DAY,
    }));

    const summary = await rehealStaleRuns(NOW, { probeLimit: 2 });

    expect(summary.probed).toBe(2);
    expect(summary.capped).toBe(true);
    expect(summary.repriced).toBe(2);
  });
});
