/**
 * The best-effort seam on the minutely derivations pass.
 *
 * 🛑 The one thing this file exists to pin: **a throw inside the automation evaluator must not cost
 * the interval reconcile that already succeeded.** The pass is four steps deep now (reconcile →
 * running-latest → HWS → automations) and each later step is wrapped, exactly so a broken model or
 * a broken limit cannot take down the thing that keeps `derived_intervals` current.
 *
 * And the distinction the `trackersFailed` lesson taught: a FAILED step reports `null`, not zeros.
 * Zeros would read as "evaluated nothing, all quiet" — indistinguishable from an idle minute, which
 * is exactly how a silently-dead evaluator survives for weeks.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireCronOrAdmin: jest.fn() }));
jest.mock("@/lib/cron/guard", () => ({ cronSkipReason: jest.fn() }));
jest.mock("@/lib/run-tracking/recompute", () => ({
  reconcileTrailingWindow: jest.fn(),
  recomputeRange: jest.fn(),
  deleteRange: jest.fn(),
  describeFilter: jest.fn(),
}));
jest.mock("@/lib/derivations/resolve", () => ({
  listEnabledRunDetectors: jest.fn(),
}));
jest.mock("@/lib/run-tracking/running-latest", () => ({
  publishRunningLatest: jest.fn(),
}));
jest.mock("@/lib/hws/recompute", () => ({
  reconcileTrailingWindow: jest.fn(),
}));
jest.mock("@/lib/automations/evaluate", () => ({
  evaluateAutomations: jest.fn(),
}));

import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { reconcileTrailingWindow } from "@/lib/run-tracking/recompute";
import { publishRunningLatest } from "@/lib/run-tracking/running-latest";
import { reconcileTrailingWindow as reconcileHws } from "@/lib/hws/recompute";
import { evaluateAutomations } from "@/lib/automations/evaluate";
import { GET } from "../route";

const mockReconcile = jest.mocked(reconcileTrailingWindow);
const mockEvaluate = jest.mocked(evaluateAutomations);

const RECONCILE_SUMMARY = { detectors: 3, intervalsWritten: 7 };
const AUTOMATIONS_SUMMARY = {
  evaluated: 2,
  armed: 1,
  disarmed: 0,
  fired: 1,
  skipped: 0,
  errors: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.mocked(requireCronOrAdmin).mockResolvedValue({ isCron: true } as never);
  jest.mocked(cronSkipReason).mockReturnValue(null as never);
  mockReconcile.mockResolvedValue(RECONCILE_SUMMARY as never);
  jest.mocked(publishRunningLatest).mockResolvedValue({ updated: 2 } as never);
  jest.mocked(reconcileHws).mockResolvedValue({
    pairsProcessed: 1,
    rowsWritten: 4,
  } as never);
  mockEvaluate.mockResolvedValue(AUTOMATIONS_SUMMARY);
});

function call() {
  return GET(new NextRequest("http://localhost/api/cron/derivations"));
}

describe("GET /api/cron/derivations (no params — the minutely pass)", () => {
  it("carries the automation summary alongside the existing keys", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe("reconcile");
    expect(body.detectors).toBe(3);
    expect(body.intervalsWritten).toBe(7);
    expect(body.runningPublished).toBe(2);
    expect(body.hwsPairs).toBe(1);
    expect(body.hwsRows).toBe(4);
    expect(body.automations).toEqual(AUTOMATIONS_SUMMARY);
  });

  it("evaluates AFTER the reconcile, so a limit reads this minute's open run", async () => {
    const order: string[] = [];
    mockReconcile.mockImplementation(async () => {
      order.push("reconcile");
      return RECONCILE_SUMMARY as never;
    });
    mockEvaluate.mockImplementation(async () => {
      order.push("automations");
      return AUTOMATIONS_SUMMARY;
    });
    await call();
    expect(order).toEqual(["reconcile", "automations"]);
  });

  it("🛑 a rejecting evaluator still answers 200 with the reconcile intact, and null automations", async () => {
    mockEvaluate.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.detectors).toBe(3);
    expect(body.intervalsWritten).toBe(7);
    // null, NOT zeros — a failed step must not read as an idle one.
    expect(body.automations).toBeNull();
  });

  it("respects the kill switch — nothing evaluates when crons are off", async () => {
    jest
      .mocked(cronSkipReason)
      .mockReturnValue({ skipped: true, reason: "CRONS_ENABLED" } as never);
    const res = await call();
    expect(await res.json()).toEqual({
      skipped: true,
      reason: "CRONS_ENABLED",
    });
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("passes an auth failure through without evaluating", async () => {
    jest
      .mocked(requireCronOrAdmin)
      .mockResolvedValue(
        NextResponse.json({ error: "no" }, { status: 401 }) as never,
      );
    expect((await call()).status).toBe(401);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});
