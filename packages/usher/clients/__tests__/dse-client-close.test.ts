/**
 * DseClient.close() must ALWAYS settle, and must always leave the client reconnectable.
 *
 * modbus-serial's tcpport.close() only calls socket.end() and relies on its 'close' handler to
 * invoke the callback — but that handler is guarded by `openFlag`, which the 'error' handler
 * clears first. So after any socket error (or on a stalled tunnel, where neither event arrives)
 * the callback is never called and an unbounded `await close()` pends for the life of the
 * process. That is what wedged the Daylesford collector for 4 h 49 m on 2026-09-11.
 *
 * These tests pin the escalation: close → destroy → abandon the instance.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

let hangClose = false;
let hangDestroy = false;
const events: string[] = [];
let instanceSeq = 0;
/** ids of the FakeModbus instances a read was issued against, in order */
const readsOn: number[] = [];

const UNROUTABLE = "192.0.2.1"; // RFC 5737 — never a real generator, even if the mock misses

jest.mock("modbus-serial", () => ({
  __esModule: true,
  default: class FakeModbus {
    id = ++instanceSeq;
    setID(): void {}
    setTimeout(): void {}
    async connectTCP(): Promise<void> {}
    readHoldingRegisters(): Promise<{ data: number[] }> {
      readsOn.push(this.id);
      return Promise.resolve({ data: [0] });
    }
    close(cb?: () => void): void {
      events.push(`close:${this.id}`);
      if (hangClose) return; // the openFlag trap
      cb?.();
    }
    destroy(cb?: () => void): void {
      events.push(`destroy:${this.id}`);
      if (hangDestroy) return;
      cb?.(); // the real library calls back synchronously on both branches
    }
  },
}));

import { DseClient } from "../dse-client";

describe("DseClient.close()", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    hangClose = false;
    hangDestroy = false;
    events.length = 0;
    readsOn.length = 0;
    instanceSeq = 0; // ids are asserted on, so they must restart each test
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** close() resolved within `ms` of fake time (i.e. it did not hang). */
  async function settles(p: Promise<void>, ms: number): Promise<boolean> {
    let done = false;
    void p.then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(ms);
    return done;
  }

  it("falls back to destroy() when close() never calls back", async () => {
    const dse = new DseClient({ host: UNROUTABLE });
    await dse.connect();
    hangClose = true;

    expect(await settles(dse.close(), 5_000)).toBe(true);
    expect(events).toEqual(["close:1", "destroy:1"]);

    // Still usable: the next op reconnects rather than being blocked by a stale `connected`.
    await dse.probeBatteryV();
    expect(readsOn).toEqual([1]);
  });

  it("abandons the client when neither close() nor destroy() calls back", async () => {
    const dse = new DseClient({ host: UNROUTABLE });
    await dse.connect();
    hangClose = true;
    hangDestroy = true;

    expect(await settles(dse.close(), 5_000)).toBe(true);

    // The wedged instance is gone; the next op runs against a NEW one. Reusing a client whose
    // socket state we no longer understand is exactly how the original bug persisted.
    await dse.connect();
    await dse.probeBatteryV();
    expect(readsOn).toEqual([2]);
  });

  it("resolves promptly by the graceful path when the library behaves", async () => {
    const dse = new DseClient({ host: UNROUTABLE });
    await dse.connect();

    expect(await settles(dse.close(), 0)).toBe(true);
    expect(events).toEqual(["close:1"]); // no destroy — the fallback must not fire in normal use
  });

  it("a connect() timeout does not leave a half-open socket attached", async () => {
    // A connect that never completes: the race rejects, but the underlying socket is still
    // attached and `connected` is false — so close() would no-op and never reap it.
    const stalling = class {
      id = ++instanceSeq;
      setID(): void {}
      setTimeout(): void {}
      connectTCP(): Promise<void> {
        return new Promise(() => {});
      }
      close(cb?: () => void): void {
        events.push(`close:${this.id}`);
        cb?.();
      }
      destroy(cb?: () => void): void {
        events.push(`destroy:${this.id}`);
        cb?.();
      }
    };
    const dse = new DseClient({ host: UNROUTABLE, timeoutMs: 1_000 });
    (dse as unknown as { client: unknown }).client = new stalling();

    const connect = dse.connect();
    connect.catch(() => {});
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(connect).rejects.toThrow(/timed out/);

    expect(events.some((e) => e.startsWith("destroy:"))).toBe(true);
  });
});
