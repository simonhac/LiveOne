/**
 * Scoping a recompute to ONE detector.
 *
 * 🛑 The reason this exists: `recomputeRange`/`deleteRange` are delete-and-reinsert per detector, so
 * an UNSCOPED historical pass is destructive to every detector other than the one being backfilled.
 * A detector whose signal has been re-pointed regenerates nothing for a window that predates its new
 * signal — Daylesford's generator moved to the DeepSea engine-speed point (history from 2026-07-11),
 * so a full-history rebuild would delete its Grid-proxy-era runs and put nothing back.
 *
 * These tests pin the two properties that prevent that: the filter reaches the detector listing, and
 * a filter that matches nothing deletes NOTHING rather than falling back to the unfiltered delete.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import type { ResolvedRunDetector } from "@/lib/derivations/resolve";

const listEnabledRunDetectors =
  jest.fn<(filter?: unknown) => Promise<ResolvedRunDetector[]>>();
const recomputeIntervalsForWindow = jest.fn<
  (...args: unknown[]) => Promise<{
    deleted: number;
    inserted: number;
    open: boolean;
  }>
>();
const returning = jest.fn<() => Promise<Array<{ startTime: Date }>>>();
const where = jest.fn(() => ({ returning }));
const del = jest.fn(() => ({ where }));

jest.mock("@/lib/derivations/resolve", () => ({
  listEnabledRunDetectors: (filter?: unknown) =>
    listEnabledRunDetectors(filter),
}));
jest.mock("@/lib/db/planetscale/derived-intervals-pg", () => ({
  recomputeIntervalsForWindow: (...args: unknown[]) =>
    recomputeIntervalsForWindow(...args),
}));
jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => ({ delete: del }),
}));

import { deleteRange, recomputeRange } from "../recompute";

/** A detector stub — only the fields the orchestration itself reads. */
function detector(id: string, handle: number, role: string) {
  return { id, legacyHandle: handle, role } as unknown as ResolvedRunDetector;
}

const EV = detector("ev-derivation", 6, "ev");
const GEN = detector("gen-derivation", 1, "generator");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-01T00:00:00Z");

beforeEach(() => {
  jest.clearAllMocks();
  recomputeIntervalsForWindow.mockResolvedValue({
    deleted: 0,
    inserted: 1,
    open: false,
  });
  returning.mockResolvedValue([]);
});

describe("recomputeRange scoping", () => {
  it("passes the filter to the detector listing and rebuilds only what it returns", async () => {
    listEnabledRunDetectors.mockResolvedValue([EV]);

    const summary = await recomputeRange(NOW - DAY, NOW, NOW, {
      filter: { derivationId: "ev-derivation" },
    });

    expect(listEnabledRunDetectors).toHaveBeenCalledWith({
      derivationId: "ev-derivation",
    });
    expect(summary.trackersProcessed).toBe(1);
    // The generator detector is never handed to the rebuild — that is the whole point.
    for (const call of recomputeIntervalsForWindow.mock.calls) {
      expect(call[1]).toBe(EV);
    }
  });

  it("still covers every detector when unscoped (the trailing-reconcile behaviour)", async () => {
    listEnabledRunDetectors.mockResolvedValue([EV, GEN]);

    const summary = await recomputeRange(NOW - DAY, NOW, NOW);

    expect(listEnabledRunDetectors).toHaveBeenCalledWith(undefined);
    expect(summary.trackersProcessed).toBe(2);
    const seen = recomputeIntervalsForWindow.mock.calls.map((c) => c[1]);
    expect(seen).toContain(EV);
    expect(seen).toContain(GEN);
  });
});

describe("deleteRange scoping", () => {
  it("restricts the delete to the scoped detector's rows", async () => {
    listEnabledRunDetectors.mockResolvedValue([EV]);
    returning.mockResolvedValue([{ startTime: new Date(NOW) }]);

    const res = await deleteRange(NOW - DAY, NOW, { handle: 6, role: "ev" });

    expect(listEnabledRunDetectors).toHaveBeenCalledWith({
      handle: 6,
      role: "ev",
    });
    expect(res.rowsDeleted).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("deletes NOTHING when the scope matches no enabled detector", async () => {
    // 🛑 The failure mode being pinned: falling back to the unfiltered delete here would wipe every
    // detector's rows in the window on a typo'd derivation id.
    listEnabledRunDetectors.mockResolvedValue([]);

    const res = await deleteRange(NOW - DAY, NOW, { derivationId: "nope" });

    expect(res.rowsDeleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes across all detectors when unscoped", async () => {
    returning.mockResolvedValue([
      { startTime: new Date(NOW) },
      { startTime: new Date(NOW - 1) },
    ]);

    const res = await deleteRange(NOW - DAY, NOW);

    expect(listEnabledRunDetectors).not.toHaveBeenCalled();
    expect(res.rowsDeleted).toBe(2);
  });
});
