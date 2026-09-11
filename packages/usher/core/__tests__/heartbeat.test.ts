/**
 * The heartbeat's only job is to be silent when the site is not delivering real readings — silence
 * is what raises the alarm, so a ping that is too easy to earn is worse than no heartbeat at all.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { createHeartbeat } from "../heartbeat";

function harness(opts: { throttleMs?: number } = {}) {
  const calls: string[] = [];
  let now = 1_000_000;
  const hb = createHeartbeat({
    url: "https://uptime.example/heartbeat/abc",
    throttleMs: opts.throttleMs ?? 60_000,
    now: () => now,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { hb, calls, advance: (ms: number) => (now += ms) };
}

const ACCEPTED_READINGS = {
  outcome: "ok" as const,
  hasDeviceReadings: true,
};

describe("heartbeat", () => {
  it("pings when real readings were accepted by the receiver", async () => {
    const { hb, calls } = harness();
    hb.onDelivery(ACCEPTED_READINGS);
    await Promise.resolve();
    expect(calls).toEqual(["https://uptime.example/heartbeat/abc"]);
  });

  it("does NOT ping when the push failed transiently", async () => {
    const { hb, calls } = harness();
    hb.onDelivery({ outcome: "transient", hasDeviceReadings: true });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("does NOT ping when the receiver rejected the batch", async () => {
    const { hb, calls } = harness();
    hb.onDelivery({ outcome: "rejected", hasDeviceReadings: true });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  // The subtle one, and the reason `hasDeviceReadings` exists at all. On a read error with a
  // supervisor attached the hub still delivers the synthetic control-plane points, and that push
  // succeeds — so a generator that has stopped answering entirely would otherwise keep the monitor
  // green forever. This is exactly the 2026-09-11 shape: pushes fine, device gone.
  it("does NOT ping for a control-only batch (device read failed)", async () => {
    const { hb, calls } = harness();
    hb.onDelivery({ outcome: "ok", hasDeviceReadings: false });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("throttles to one ping per window, then resumes", async () => {
    const { hb, calls, advance } = harness({ throttleMs: 60_000 });
    hb.onDelivery(ACCEPTED_READINGS);
    advance(10_000);
    hb.onDelivery(ACCEPTED_READINGS);
    advance(10_000);
    hb.onDelivery(ACCEPTED_READINGS);
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    advance(60_000);
    hb.onDelivery(ACCEPTED_READINGS);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
  });

  it("never surfaces a failing ping — monitoring must not affect collection", async () => {
    const log: string[] = [];
    const hb = createHeartbeat({
      url: "https://uptime.example/heartbeat/abc",
      fetchImpl: (() =>
        Promise.reject(new Error("network down"))) as unknown as typeof fetch,
      log: (m) => log.push(m),
    });
    expect(() => hb.onDelivery(ACCEPTED_READINGS)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(log.join()).toMatch(/heartbeat ping failed/);
  });

  it("a hanging ping does not block the caller", () => {
    jest.useFakeTimers();
    try {
      const hb = createHeartbeat({
        url: "https://uptime.example/heartbeat/abc",
        fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
      });
      const before = Date.now();
      hb.onDelivery(ACCEPTED_READINGS); // returns void, synchronously
      expect(Date.now() - before).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
