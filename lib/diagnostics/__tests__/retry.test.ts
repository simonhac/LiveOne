import { describe, it, expect } from "@jest/globals";
import {
  MAX_ATTEMPTS,
  nextAttemptDelayMs,
  RETRY_LADDER_MINUTES,
} from "../store";

const MINUTE = 60_000;

describe("nextAttemptDelayMs", () => {
  it("is ONE-BASED, matching what claimDueJob returns", () => {
    // 🛑 The off-by-one this pins. `claimDueJob` increments `attempts` as it claims and returns the
    // incremented value, so the first failure arrives here as 1 — not 0. Read zero-based, the
    // first retry waited five minutes instead of one, which is the difference between reaching the
    // inverter while an outage is still in progress and arriving after it.
    expect(RETRY_LADDER_MINUTES).toEqual([1, 5, 15, 60]);
    expect(nextAttemptDelayMs(1)).toBe(1 * MINUTE);
    expect(nextAttemptDelayMs(2)).toBe(5 * MINUTE);
    expect(nextAttemptDelayMs(3)).toBe(15 * MINUTE);
    expect(nextAttemptDelayMs(4)).toBe(60 * MINUTE);
  });

  it("then retries hourly", () => {
    expect(nextAttemptDelayMs(5)).toBe(60 * MINUTE);
    expect(nextAttemptDelayMs(20)).toBe(60 * MINUTE);
  });

  it("gives up after a day, rather than dialling the inverter for ever", () => {
    // A job that has failed every hour for 24 hours is not going to succeed on a timer. It is
    // ABANDONED, not deleted — it stays visible, and a new transition creates a fresh one.
    expect(MAX_ATTEMPTS).toBe(28);
    expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptDelayMs(MAX_ATTEMPTS + 5)).toBeNull();
  });
});
