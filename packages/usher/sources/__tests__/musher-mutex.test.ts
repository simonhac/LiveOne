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

// Belt and braces: every musher here is pointed at TEST-NET-1 (RFC 5737, guaranteed unroutable)
// rather than the default 10.0.1.244. If the mock below ever fails to apply, the test must not be
// able to reach a real generator — it should fail on connect, loudly, not command an engine.
const UNROUTABLE = "192.0.2.1";

jest.mock("modbus-serial", () => ({
  __esModule: true,
  default: class FakeModbus {
    setID(): void {}
    setTimeout(): void {}
    async connectTCP(): Promise<void> {}
    readHoldingRegisters(): Promise<{ data: number[] }> {
      if (hangReads) return new Promise(() => {}); // the silently-dead socket
      return Promise.resolve({ data: [0] });
    }
    async writeRegisters(addr: number, values: number[]): Promise<void> {
      written.push({ addr, values });
    }
    close(cb?: () => void): void {
      cb?.();
    }
  },
}));

import { createMusher } from "../musher";

describe("musher device mutex", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    written.length = 0;
    hangReads = true;
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
