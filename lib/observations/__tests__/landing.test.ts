/**
 * Tests for {@link waitForLanding}.
 *
 * 🛑 The bug this replaced was not a rare race — it was a check that passed almost immediately and
 * then kept passing. The first test is therefore the whole point: a target that has delivered ONE of
 * its rows must still be pending. Everything a sign-of-life test would have accepted, this must
 * refuse.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { waitForLanding, landingScopeFor } from "../landing";

/** A clock the test drives, so nothing here waits on real time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const run = (
  opts: Partial<Parameters<typeof waitForLanding>[0]> & {
    countLanded: (key: string) => Promise<number>;
  },
) => {
  const clock = fakeClock();
  return waitForLanding({
    targets: [{ key: "a", expected: 10 }],
    timeoutMs: 60_000,
    pollMs: 1_000,
    sleep: clock.sleep,
    now: clock.now,
    ...opts,
  });
};

describe("waitForLanding", () => {
  it("does NOT treat partial delivery as landed — the bug it exists to prevent", async () => {
    // The old watermark check stopped here. 1 of 10 rows is exactly the state that produced a
    // half-computed day.
    const res = await run({ countLanded: async () => 1 });
    expect(res.pending).toEqual(["a"]);
    expect(res.landed).toEqual([]);
    expect(res.observed.get("a")).toBe(1);
  });

  it("lands when the expected count is reached", async () => {
    const res = await run({ countLanded: async () => 10 });
    expect(res.landed).toEqual(["a"]);
    expect(res.pending).toEqual([]);
  });

  it("lands when MORE rows than expected are visible", async () => {
    // Another writer touching the same window counts too; the test is >=, never equality, or a
    // concurrent live poll would hang the wait forever.
    const res = await run({ countLanded: async () => 11 });
    expect(res.landed).toEqual(["a"]);
  });

  it("keeps polling while the count climbs, and lands on the poll that completes it", async () => {
    const counts = [0, 3, 7, 10];
    let i = 0;
    const countLanded = jest.fn(
      async () => counts[Math.min(i++, counts.length - 1)],
    );
    const res = await run({ countLanded });
    expect(res.landed).toEqual(["a"]);
    expect(countLanded).toHaveBeenCalledTimes(4);
  });

  it("gives up at the deadline and reports the target as pending, not landed", async () => {
    // 🛑 The caller must be able to tell "finished" from "gave up". Reporting a timeout as success
    // is how a partial day gets written on purpose.
    const res = await run({
      countLanded: async () => 2,
      timeoutMs: 5_000,
      pollMs: 1_000,
    });
    expect(res.pending).toEqual(["a"]);
    expect(res.landed).toEqual([]);
    expect(res.waitedMs).toBeGreaterThanOrEqual(5_000);
  });

  it("treats a read failure as transient, never as zero and never as success", async () => {
    let n = 0;
    const res = await run({
      countLanded: async () => {
        if (++n < 3) throw new Error("connection reset");
        return 10;
      },
    });
    expect(res.landed).toEqual(["a"]);
  });

  it("gives up if the read never succeeds, rather than hanging", async () => {
    const res = await run({
      countLanded: async () => {
        throw new Error("down");
      },
      timeoutMs: 3_000,
      pollMs: 1_000,
    });
    expect(res.pending).toEqual(["a"]);
  });

  it("lands a target that published nothing, without waiting for it", async () => {
    const countLanded = jest.fn(async () => 0);
    const res = await waitForLanding({
      targets: [{ key: "empty", expected: 0 }],
      countLanded,
      timeoutMs: 60_000,
      pollMs: 1_000,
    });
    expect(res.landed).toEqual(["empty"]);
    expect(countLanded).not.toHaveBeenCalled();
  });

  it("tracks targets independently — one slow device does not strand a fast one", async () => {
    const counts: Record<string, number[]> = { fast: [5], slow: [0, 0, 5] };
    const idx: Record<string, number> = { fast: 0, slow: 0 };
    const res = await waitForLanding({
      targets: [
        { key: "fast", expected: 5 },
        { key: "slow", expected: 5 },
      ],
      countLanded: async (k) =>
        counts[k][Math.min(idx[k]++, counts[k].length - 1)],
      timeoutMs: 60_000,
      pollMs: 1_000,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    });
    expect(res.landed.sort()).toEqual(["fast", "slow"]);
    expect(res.pending).toEqual([]);
  });

  it("checks before the first sleep, so an already-applied publish costs no poll interval", async () => {
    const sleep = jest.fn(async () => {});
    await run({ countLanded: async () => 10, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("landingScopeFor", () => {
  const obs = (
    uid: string,
    ms: number,
    interval: "raw" | "5m" | "1d" = "5m",
    sessionId = "sess-1",
  ) => ({
    interval,
    sessionId,
    point: { pointUid: uid },
    measurementTimeMs: ms,
  });

  const A = "00000000-0000-7000-8000-0000000000a1";
  const B = "00000000-0000-7000-8000-0000000000b2";
  const T = Date.parse("2026-09-09T00:05:00.000Z");

  it("counts every 5m row, including two points at the same interval", () => {
    // 🛑 The count is ROWS, not intervals. Two points sharing an interval are two rows, and undercounting
    // here is the failure that makes a wait stop halfway.
    expect(landingScopeFor([obs(A, T), obs(B, T)]).expected).toBe(2);
  });

  it("takes its point set from the observations, not from anywhere else", () => {
    // 🛑 THE Amber test. Its usage repair publishes energy, cost AND price per channel while its
    // coverage tails cover only energy and cost — so a scope built from coverage points would wait
    // for rows its own query could never see, and time out on every successful repair.
    const scope = landingScopeFor([obs(A, T), obs(B, T)]);
    expect(scope.points).toHaveLength(2);
    expect(scope.expected).toBe(2);
  });

  it("ignores raw and 1d entries — only 5m becomes an agg_5m row", () => {
    const scope = landingScopeFor([
      obs(A, T, "raw"),
      obs(A, T, "1d"),
      obs(A, T),
    ]);
    expect(scope.expected).toBe(1);
  });

  it("brackets the published intervals, with the lower bound EXCLUSIVE", () => {
    // Downstream the bound is `interval_end > fromMs`, so the earliest published row has to fall
    // strictly inside — hence the single millisecond of headroom.
    const scope = landingScopeFor([obs(A, T), obs(A, T + 600_000)]);
    expect(scope.fromMs).toBe(T - 1);
    expect(scope.toMs).toBe(T + 600_000);
  });

  it("carries the distinct session ids — how a landed row is identified as ours", () => {
    // 🛑 Correctness lives here, not in the interval bracket. Without the session key the count
    // cannot tell our landings from a concurrent live poll's, and a handful of unrelated writes can
    // stand in for the last handful of queued rows.
    const scope = landingScopeFor([
      obs(A, T, "5m", "sess-1"),
      obs(B, T, "5m", "sess-1"),
      obs(A, T + 300_000, "5m", "sess-2"),
    ]);
    expect(scope.sessionIds.sort()).toEqual(["sess-1", "sess-2"]);
  });

  it("returns an empty scope when nothing 5m was published", () => {
    expect(landingScopeFor([obs(A, T, "raw")])).toEqual({
      points: [],
      fromMs: 0,
      toMs: 0,
      sessionIds: [],
      expected: 0,
    });
    expect(landingScopeFor([])).toMatchObject({ expected: 0 });
  });
});
