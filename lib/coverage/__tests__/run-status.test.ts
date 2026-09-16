/**
 * The coverage run's headline status, and specifically that a DEAD STALE SWEEP raises the alarm.
 *
 * 🛑 THE REGRESSION THIS FILE EXISTS FOR. `healStaleAgg1dForDevice` swallows its own failures by
 * design — a backstop must not be the reason a backfill does not happen — so a permanently broken
 * detector returns the same empty result as a healthy fleet. `staleAgg1dLocalDays` shipped in #462
 * emitting a GROUP BY Postgres refuses (42803) and threw on every device on both callers every
 * night; the nightly report stayed 🟢 for five days while nothing healed, and `Amber Kinkora`
 * accumulated 16 days of missing aggregates. Every OTHER input to this status describes gaps the
 * sweep is not responsible for, which is exactly why its silence was indistinguishable from health.
 */
import { describe, it, expect } from "@jest/globals";
import { coverageRunStatus } from "../runner";

const HEALTHY = {
  errors: 0,
  staleSweepFailures: 0,
  unsettled: 0,
  deferredForCap: 0,
  recomputePending: 0,
};

describe("coverageRunStatus", () => {
  it("is ok on a clean run", () => {
    expect(coverageRunStatus(HEALTHY)).toBe("ok");
  });

  it("ALERTS on a failed stale sweep, even when every other signal is clean", () => {
    // The whole point: nothing else in the report can reveal this.
    expect(coverageRunStatus({ ...HEALTHY, staleSweepFailures: 1 })).toBe(
      "alert",
    );
  });

  it("does not let a merely-warning signal mask a failed sweep", () => {
    expect(
      coverageRunStatus({
        ...HEALTHY,
        staleSweepFailures: 2,
        unsettled: 5,
        deferredForCap: 3,
        recomputePending: 1,
      }),
    ).toBe("alert");
  });

  it("still alerts on repair errors", () => {
    expect(coverageRunStatus({ ...HEALTHY, errors: 1 })).toBe("alert");
  });

  it("warns — not alerts — on unsettled, deferred or pending recompute", () => {
    expect(coverageRunStatus({ ...HEALTHY, unsettled: 1 })).toBe("warn");
    expect(coverageRunStatus({ ...HEALTHY, deferredForCap: 1 })).toBe("warn");
    expect(coverageRunStatus({ ...HEALTHY, recomputePending: 1 })).toBe("warn");
  });
});
