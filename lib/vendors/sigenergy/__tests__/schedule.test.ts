import { describe, it, expect } from "@jest/globals";
import { SigenergyAdapter } from "../adapter";
import type { SystemWithPolling } from "@/lib/systems-manager";

/**
 * Boundary-aligned scheduling (adapter.alignToBoundary = true): poll on absolute 5-min boundaries
 * and, until a reading is recorded for the current window, retry every minute; go quiet once a
 * success lands. Keyed off pollingStatus.lastSuccessTime. All timestamps are UTC.
 */

// Minimal SystemWithPolling — shouldPoll only reads timezoneOffsetMin + pollingStatus.
function sys(lastSuccessTime: Date | null): SystemWithPolling {
  return {
    timezoneOffsetMin: 600,
    pollingStatus: lastSuccessTime ? { lastSuccessTime } : null,
  } as unknown as SystemWithPolling;
}

describe("SigenergyAdapter boundary schedule", () => {
  const adapter = new SigenergyAdapter();

  it("polls at the 5-min boundary when the current window has no success yet", async () => {
    const now = new Date("2026-07-12T05:05:03Z");
    const r = await adapter.shouldPoll(
      sys(new Date("2026-07-12T05:00:04Z")),
      false,
      now,
    );
    expect(r.shouldPoll).toBe(true);
    expect(r.reason).toBe("Boundary poll");
  });

  it("skips once a success is recorded in the current window", async () => {
    const now = new Date("2026-07-12T05:06:10Z");
    const r = await adapter.shouldPoll(
      sys(new Date("2026-07-12T05:05:04Z")),
      false,
      now,
    );
    expect(r.shouldPoll).toBe(false);
    expect(r.reason).toBe("Recorded this window");
  });

  it("retries mid-window when the boundary poll failed (no success this window)", async () => {
    const now = new Date("2026-07-12T05:07:00Z");
    const r = await adapter.shouldPoll(
      sys(new Date("2026-07-12T05:00:04Z")),
      false,
      now,
    );
    expect(r.shouldPoll).toBe(true);
    expect(r.reason).toMatch(/Retry until next boundary/);
  });

  it("does not treat last window's success as covering this window", async () => {
    // Success at 05:04:59 (prev window) must not suppress the 05:05 boundary poll.
    const now = new Date("2026-07-12T05:05:02Z");
    const r = await adapter.shouldPoll(
      sys(new Date("2026-07-12T05:04:59Z")),
      false,
      now,
    );
    expect(r.shouldPoll).toBe(true);
  });

  it("polls when the system has never recorded a success", async () => {
    const now = new Date("2026-07-12T05:05:03Z");
    const r = await adapter.shouldPoll(sys(null), false, now);
    expect(r.shouldPoll).toBe(true);
  });
});
