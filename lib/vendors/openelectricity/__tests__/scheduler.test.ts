import { describe, it, expect } from "@jest/globals";
import {
  adaptiveLookbackStartMs,
  applyObservation,
  decidePoll,
  DEFAULT_DELAY_SEC,
  DEFAULT_LOOKBACK_MS,
  MAX_AUTOHEAL_MS,
  MAX_POLLS_PER_INTERVAL,
  type OeSchedState,
} from "../scheduler";

const DAY = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (h: number, m: number, s = 0) =>
  new Date(DAY + h * 3600_000 + m * 60_000 + s * 1000);
const endMs = (h: number, m: number) => DAY + h * 3600_000 + m * 60_000;

const baseState = (overrides: Partial<OeSchedState> = {}): OeSchedState => ({
  delaySec: DEFAULT_DELAY_SEC, // 150
  lastSeenIntervalEndMs: 0,
  windowIntervalEndMs: 0,
  pollsThisWindow: 0,
  ...overrides,
});

describe("decidePoll", () => {
  it("skips when the latest closed interval is already captured", () => {
    const d = decidePoll({
      now: at(10, 7),
      state: baseState({ lastSeenIntervalEndMs: endMs(10, 5) }),
    });
    expect(d.shouldPoll).toBe(false);
    expect(d.reason).toMatch(/up to date/);
  });

  it("skips when before the expected arrival window (data not published yet)", () => {
    // interval 10:05 just ended; expected arrival = 10:05 + 150s - 30s = 10:07:00
    const d = decidePoll({
      now: at(10, 5, 30),
      state: baseState({ lastSeenIntervalEndMs: endMs(10, 0) }),
    });
    expect(d.shouldPoll).toBe(false);
    expect(d.reason).toMatch(/awaiting/);
  });

  it("polls once inside the arrival window and increments the attempt counter", () => {
    const d = decidePoll({
      now: at(10, 7, 30),
      state: baseState({ lastSeenIntervalEndMs: endMs(10, 0) }),
    });
    expect(d.shouldPoll).toBe(true);
    expect(d.newState.pollsThisWindow).toBe(1);
    expect(d.newState.windowIntervalEndMs).toBe(endMs(10, 5));
  });

  it("backs off and nudges the delay up when persistently late", () => {
    const d = decidePoll({
      now: at(10, 8),
      state: baseState({
        lastSeenIntervalEndMs: endMs(10, 0),
        windowIntervalEndMs: endMs(10, 5),
        pollsThisWindow: MAX_POLLS_PER_INTERVAL,
      }),
    });
    expect(d.shouldPoll).toBe(false);
    expect(d.reason).toMatch(/overdue/);
    expect(d.newState.delaySec).toBe(DEFAULT_DELAY_SEC + 30);
  });

  it("resets the attempt counter when a new interval window starts", () => {
    const d = decidePoll({
      now: at(10, 7, 30),
      state: baseState({
        lastSeenIntervalEndMs: endMs(10, 0),
        windowIntervalEndMs: endMs(10, 0), // stale window
        pollsThisWindow: 3,
      }),
    });
    // rolled into the 10:05 window → counter reset, then this poll = 1
    expect(d.newState.pollsThisWindow).toBe(1);
  });
});

describe("applyObservation", () => {
  it("raises the EWMA delay when the interval arrives late", () => {
    const next = applyObservation(
      baseState(),
      endMs(10, 5),
      endMs(10, 5) + 200_000, // 200s observed delay
    );
    // 0.3*200 + 0.7*150 = 165
    expect(next.delaySec).toBe(165);
    expect(next.lastSeenIntervalEndMs).toBe(endMs(10, 5));
  });

  it("lowers the EWMA delay when the interval arrives early", () => {
    const next = applyObservation(
      baseState(),
      endMs(10, 5),
      endMs(10, 5) + 90_000,
    );
    // 0.3*90 + 0.7*150 = 132
    expect(next.delaySec).toBe(132);
  });

  it("ignores a re-pull / revision of an already-seen interval", () => {
    const state = baseState({ lastSeenIntervalEndMs: endMs(10, 5) });
    const next = applyObservation(state, endMs(10, 5), endMs(10, 5) + 120_000);
    expect(next).toBe(state); // unchanged reference → delay not skewed
  });

  /**
   * The bug that pinned prod's `delaySec` at the 60 s floor (measured 2026-08-15), opening the
   * arrival window ~31 s after each interval closed — long before NEM's 1-3 min publication lag —
   * and halving the effective capture rate to ~7 polls/h against a 12/h target.
   */
  describe("only measures a delay it can actually observe", () => {
    it("does not read our OWN downtime as a slow vendor", () => {
      // Captured 10:05 at 10:21:40 — but 10:20 had also closed and we did not get it, so the only
      // thing this proves is that we were not polling. The old code recorded a 16-minute "delay".
      const next = applyObservation(
        baseState(),
        endMs(10, 5),
        endMs(10, 5) + 1_000_000,
      );
      expect(next.delaySec).toBe(150); // unmoved
      expect(next.lastSeenIntervalEndMs).toBe(endMs(10, 5)); // but progress is still recorded
    });

    it("treats a missed target as a LOWER BOUND that can only push the estimate up", () => {
      // At 10:14:00 the 10:10 interval has closed and we only came away with 10:05: 10:10 had not
      // published in 240 s. That is evidence the delay is ≥240 s, so the estimate rises.
      const next = applyObservation(
        baseState({ delaySec: 150 }),
        endMs(10, 5),
        endMs(10, 10) + 240_000,
      );
      // 0.3*240 + 0.7*150 = 177
      expect(next.delaySec).toBe(177);
    });

    it("never lets a lower bound drag the estimate down", () => {
      // Same shape, but the bound (60 s) is below the current estimate — it says nothing new.
      const next = applyObservation(
        baseState({ delaySec: 200 }),
        endMs(10, 5),
        endMs(10, 10) + 30_000,
      );
      expect(next.delaySec).toBe(200);
    });

    it("still learns normally when it catches the interval that just closed", () => {
      const next = applyObservation(
        baseState(),
        endMs(10, 5),
        endMs(10, 5) + 200_000,
      );
      expect(next.delaySec).toBe(165); // 0.3*200 + 0.7*150
    });
  });
});

describe("adaptiveLookbackStartMs", () => {
  const base = endMs(12, 0);

  it("uses the default 30-min lookback in steady state", () => {
    // up to date: lastSeen is the previous interval end
    const start = adaptiveLookbackStartMs(base, base - 5 * 60_000);
    expect(start).toBe(base - DEFAULT_LOOKBACK_MS);
  });

  it("uses the default lookback on cold start (no lastSeen)", () => {
    expect(adaptiveLookbackStartMs(base, 0)).toBe(base - DEFAULT_LOOKBACK_MS);
  });

  it("extends the window back to lastSeen to auto-fill a 1-hour gap", () => {
    const lastSeen = base - 60 * 60_000; // 12 intervals behind
    expect(adaptiveLookbackStartMs(base, lastSeen)).toBe(lastSeen);
  });

  it("caps the catch-up window at MAX_AUTOHEAL for very large gaps", () => {
    const lastSeen = base - 3 * 24 * 60 * 60_000; // 3 days behind, exceeds the cap
    expect(adaptiveLookbackStartMs(base, lastSeen)).toBe(
      base - MAX_AUTOHEAL_MS,
    );
  });
});
