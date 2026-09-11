/**
 * The courier exists so that gusher's availability cannot control how fast we sample the device.
 * Through the ~4 h receiver outage of 2026-09-11 sheephouse recorded 895 reads where its 15 s
 * cadence should have produced 958 — ~45 readings lost to failing pushes alone, before the wedge
 * that killed the collector later that morning.
 */

import { describe, it, expect } from "@jest/globals";
import { createCourier, type DeliveryResult } from "../courier";
import type { PushOutcome } from "../pusher";
import type { PushReading } from "@liveone/protocol";
import type { Spool, SpooledBatch, SpoolStats } from "../spool";

const readings: PushReading[] = [
  { physicalPathTail: "x", value: 1, metricType: "power", metricUnit: "W" },
];

const job = (label: string, hasDeviceReadings = true) => ({
  siteId: "sheephouse",
  sessionLabel: label,
  measurementTime: "2026-09-11T04:00:00.000Z",
  readings,
  hasDeviceReadings,
});

/** A spool stand-in that records what it was asked to keep. */
function fakeSpool() {
  const kept: SpooledBatch[] = [];
  let drained = 0;
  const spool = {
    enqueue: async (b: SpooledBatch) => {
      kept.push(b);
      return true;
    },
    statsSync: (): SpoolStats => ({ files: kept.length, bytes: 0 }),
    drain: async () => {
      drained++;
      const sent = kept.length;
      kept.length = 0;
      return { sent, dropped: 0, remaining: 0 };
    },
  } as unknown as Spool;
  return { spool, kept, drains: () => drained };
}

describe("courier", () => {
  it("submit() returns immediately, even when the push is slow", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => {
        await blocked;
        return "ok" as PushOutcome;
      },
    });

    const before = Date.now();
    c.submit(job("a"));
    // The whole point: the caller is not waiting on the receiver.
    expect(Date.now() - before).toBeLessThan(50);

    release();
    await c.idle();
  });

  it("delivers in submission order through one worker", async () => {
    const sent: string[] = [];
    const c = createCourier({
      siteId: "sheephouse",
      store: async (_r, meta) => {
        await new Promise((res) => setTimeout(res, 5));
        sent.push(meta.sessionLabel);
        return "ok";
      },
    });
    c.submit(job("a"));
    c.submit(job("b"));
    c.submit(job("c"));
    await c.idle();
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("spools a transiently failed batch", async () => {
    const { spool, kept } = fakeSpool();
    const results: DeliveryResult[] = [];
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => "transient",
      spool,
      onResult: (r) => results.push(r),
    });
    c.submit(job("a"));
    await c.idle();
    expect(kept.map((b) => b.sessionLabel)).toEqual(["a"]);
    expect(results[0]).toMatchObject({ outcome: "transient", spooled: true });
  });

  it("does not spool a permanently rejected batch", async () => {
    const { spool, kept } = fakeSpool();
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => "rejected",
      spool,
    });
    c.submit(job("a"));
    await c.idle();
    expect(kept).toHaveLength(0);
  });

  // The trigger that used to live in the run loop, where a wedged loop could strand it — and did,
  // for 4 h 49 m, through the receiver's own recovery.
  it("drains the backlog once the receiver acks again", async () => {
    const { spool, kept, drains } = fakeSpool();
    let up = false;
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => (up ? "ok" : "transient"),
      spool,
    });

    c.submit(job("a"));
    c.submit(job("b"));
    await c.idle();
    expect(kept).toHaveLength(2);
    expect(drains()).toBe(0);

    up = true;
    c.submit(job("c"));
    await c.idle();
    expect(drains()).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("spools overflow instead of growing in memory", async () => {
    const { spool, kept } = fakeSpool();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => {
        await blocked;
        return "ok" as PushOutcome;
      },
      spool,
      maxDepth: 2,
    });

    c.submit(job("a")); // taken by the worker
    c.submit(job("b")); // queued
    c.submit(job("c")); // queued — now at maxDepth
    c.submit(job("d")); // overflow → disk
    c.submit(job("e")); // overflow → disk
    expect(c.depth()).toBe(2);
    await Promise.resolve();
    expect(kept.map((b) => b.sessionLabel)).toEqual(["d", "e"]);

    release();
    await c.idle();
  });

  it("a store() that throws does not kill the worker", async () => {
    const seen: string[] = [];
    let first = true;
    const c = createCourier({
      siteId: "sheephouse",
      store: async (_r, meta) => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        seen.push(meta.sessionLabel);
        return "ok";
      },
    });
    c.submit(job("a"));
    c.submit(job("b"));
    await c.idle();
    expect(seen).toEqual(["b"]); // the site keeps delivering
  });

  it("reports hasDeviceReadings so the heartbeat can tell data from control points", async () => {
    const results: DeliveryResult[] = [];
    const c = createCourier({
      siteId: "sheephouse",
      store: async () => "ok",
      onResult: (r) => results.push(r),
    });
    c.submit(job("a", true));
    c.submit(job("b", false));
    await c.idle();
    expect(results.map((r) => r.job.hasDeviceReadings)).toEqual([true, false]);
  });

  it("an onResult observer that throws does not break delivery", async () => {
    const sent: string[] = [];
    const c = createCourier({
      siteId: "sheephouse",
      store: async (_r, meta) => {
        sent.push(meta.sessionLabel);
        return "ok";
      },
      onResult: () => {
        throw new Error("observer exploded");
      },
    });
    c.submit(job("a"));
    c.submit(job("b"));
    await c.idle();
    expect(sent).toEqual(["a", "b"]);
  });
});
