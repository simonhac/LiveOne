/**
 * The musher device mutex — the property that must never break: a HUNG POLL READ cannot block the
 * stop path. modbus-serial's timeout does not fire on a silently-dead socket, so a read can pend
 * forever; the mutex timeout-bounds every held op so the chain always advances and a queued
 * control write still executes. A naive promise-chain mutex fails this test (deadline stop waits
 * forever behind the hung read) — which is a runaway engine.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

// Stand-in for the Modbus library: reads hang forever, writes succeed and are recorded.
const written: { addr: number; values: number[] }[] = [];
let hangReads = true;
// The 2026-09-11 failure mode: tcpport's close callback is never invoked (its 'close' handler is
// guarded by openFlag, which the 'error' handler has already cleared). destroy() still works —
// modbus-serial calls it back synchronously — which is what makes the escalation in close() safe.
let hangClose = false;
// Reads that REJECT rather than hang. readAll() catches every per-field error and returns
// normally, so this is the path the real failure took: the read completed (with every field
// null), and the hang was in readInner's finally-close.
let failReads = false;
const destroyed: number[] = [];
let instanceSeq = 0;

// Belt and braces: every musher here is pointed at TEST-NET-1 (RFC 5737, guaranteed unroutable)
// rather than the default 10.0.1.244. If the mock below ever fails to apply, the test must not be
// able to reach a real generator — it should fail on connect, loudly, not command an engine.
const UNROUTABLE = "192.0.2.1";

jest.mock("modbus-serial", () => ({
  __esModule: true,
  default: class FakeModbus {
    id = ++instanceSeq;
    setID(): void {}
    setTimeout(): void {}
    async connectTCP(): Promise<void> {}
    readHoldingRegisters(): Promise<{ data: number[] }> {
      if (failReads) return Promise.reject(new Error("ECONNRESET"));
      if (hangReads) return new Promise(() => {}); // the silently-dead socket
      return Promise.resolve({ data: [0] });
    }
    async writeRegisters(addr: number, values: number[]): Promise<void> {
      written.push({ addr, values });
    }
    close(cb?: () => void): void {
      if (hangClose) return; // callback never fires — the wedge
      cb?.();
    }
    destroy(cb?: () => void): void {
      destroyed.push(this.id);
      cb?.(); // modbus-serial calls back synchronously on both branches
    }
  },
}));

import { createMusher } from "../musher";

describe("musher device mutex", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    written.length = 0;
    destroyed.length = 0;
    hangReads = true;
    hangClose = false;
    failReads = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("a hung poll read does NOT block a queued control stop (chain advances on timeout)", async () => {
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });

    // 1. Poll read hangs on the dead socket…
    const read = source.read();
    read.catch(() => {}); // it will time out; don't leak the rejection
    // 2. …and a stop is queued behind it (fn 33 skips the SCF pre-read by design, so no reads).
    const stop = source.control!.stop();

    // Nothing can proceed while the read holds the lock:
    await jest.advanceTimersByTimeAsync(1_000);
    expect(written).toHaveLength(0);

    // The lock's internal timeout (28 s) frees the chain; the stop then executes promptly.
    await jest.advanceTimersByTimeAsync(30_000);
    await stop;
    expect(written).toHaveLength(1);
    expect(written[0].addr).toBe(4104);
    expect(written[0].values).toEqual([35733, 29802]); // Cancel Telemetry Start + complement

    // And the abandoned read surfaced as a timeout error, not a hang:
    await expect(read).rejects.toThrow(/hung Modbus op/);
  });

  // ── the 2026-09-11 regression ───────────────────────────────────────────────
  // A hung read is survivable on its own (the test above). What killed the Daylesford collector
  // for 4 h 49 m was the RECOVERY from it: the lock's catch did `await dse.close()` unbounded, and on
  // a socket whose error had already cleared modbus-serial's openFlag that close callback never
  // fired. The chain then never advanced, so every later op — including the deadline STOP —
  // queued behind a promise that could not settle. This test fails on that code.
  it("a close() that never calls back does NOT wedge the chain", async () => {
    hangClose = true;
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });

    const read = source.read();
    read.catch(() => {});
    const stop = source.control!.stop();

    // 28 s frees the read; its recovery close() then hangs — bounded now, forever before.
    await jest.advanceTimersByTimeAsync(35_000);
    await stop;
    expect(written).toHaveLength(1);
    expect(written[0].addr).toBe(4104);

    // And the chain is still live afterwards: a THIRD op runs. (A wedge is permanent — proving
    // one op got through is not enough.)
    hangReads = false;
    const after = source.control!.stop();
    await jest.advanceTimersByTimeAsync(35_000);
    await after;
    expect(written).toHaveLength(2);

    await expect(read).rejects.toThrow(/hung Modbus op/);
  });

  // The exact sequence recovered from the Fly volume for 2026-09-11 04:01:20 AEST. The final diag
  // record has all 115 fields null with NO sentinel reason — i.e. every register read ERRORED, and
  // readAll (which catches per-field errors) returned normally. So the read did not hang: the
  // socket errored, which cleared modbus-serial's openFlag, and readInner's finally-close then
  // never got its callback. The lock's 28 s timer fired into a catch that closed AGAIN, unbounded.
  it("survives the actual 2026-09-11 sequence: reads error, then close() hangs", async () => {
    failReads = true;
    hangClose = true;
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });

    const read = source.read();
    read.catch(() => {});
    // A deadline stop queued behind it — the case that makes this a safety bug, not just a
    // data-loss bug: on the day, a commanded run could not have been stopped.
    const stop = source.control!.stop();

    await jest.advanceTimersByTimeAsync(40_000);
    await stop;
    expect(written).toHaveLength(1);
    expect(written[0].addr).toBe(4104);

    // And the read reproduces the incident's signature exactly: it RESOLVES (readAll catches every
    // per-field error), with every value null — which is what the 04:01:20 diag record shows, and
    // why that record had 115 nulls and not one sentinel reason.
    const values = await read;
    const keys = Object.keys(values);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.every((k) => values[k] === null)).toBe(true);
  });

  it("an op that never gets its turn gives up instead of waiting forever", async () => {
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });

    // The read takes the lock and hangs for its full 28 s hold budget.
    const read = source.read();
    read.catch(() => {});
    // A second read queues behind it. Its 5 s QUEUE budget expires first: a poll that cannot get
    // the lock within 5 s is worthless, since the next poll is 15 s away.
    const queuedRead = source.read();

    await jest.advanceTimersByTimeAsync(6_000);
    await expect(queuedRead).rejects.toThrow(
      /waited 5000ms for the device lock/,
    );

    // Giving up must be total — a late turn must never reach the device.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(written).toHaveLength(0);
    await expect(read).rejects.toThrow(/hung Modbus op/);
  });

  it("a queued control stop outlives a worst-case read (queue budget > hold budget)", async () => {
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });

    const read = source.read();
    read.catch(() => {});
    const stop = source.control!.stop();

    // The stop's queue budget (~33 s) deliberately exceeds the read's 28 s hold, so a stop queued
    // behind one bad read still runs rather than being rejected as "waited too long".
    await jest.advanceTimersByTimeAsync(35_000);
    await expect(stop).resolves.toBeUndefined();
    expect(written).toHaveLength(1);
    expect(written[0].addr).toBe(4104);
  });

  it("control writes are serialised — a second op waits for the first", async () => {
    hangReads = false;
    const source = createMusher({
      siteId: "s",
      host: UNROUTABLE,
      enableControl: true,
    });
    await source.control!.stop();
    await source.control!.stop();
    expect(written).toHaveLength(2);
  });

  it("control is absent unless the config opts in (fail-closed)", () => {
    const source = createMusher({ siteId: "s", host: UNROUTABLE });
    expect(source.control).toBeUndefined();
  });
});
