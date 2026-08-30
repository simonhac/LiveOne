import { describe, it, expect } from "@jest/globals";
import {
  msUntilNextBoundary,
  shouldDeliverTick,
  tickOnce,
  type Entry,
} from "../run";
import type { Source, Values } from "../source";

const MANIFEST = [
  { key: "x", physicalPathTail: "x", metricType: "power", metricUnit: "W" },
];

function makeEntry(read: () => Promise<Values>): {
  entry: Entry;
  captured: {
    readings?: unknown[];
    meta?: { sessionLabel: string; measurementTime: string };
    resetCount: number;
  };
} {
  const captured: {
    readings?: unknown[];
    meta?: { sessionLabel: string; measurementTime: string };
    resetCount: number;
  } = { resetCount: 0 };
  const source: Source = {
    name: "test",
    siteId: "s",
    manifest: MANIFEST,
    read,
    isRunning: (v) => Number(v.x ?? 0) > 0,
    reset: () => {
      captured.resetCount++;
    },
  };
  const pusher = {
    async store(
      readings: unknown[],
      meta: { sessionLabel: string; measurementTime: string },
    ) {
      captured.readings = readings;
      captured.meta = meta;
      return "ok" as const;
    },
  };
  return { entry: { source, pusher } as unknown as Entry, captured };
}

describe("msUntilNextBoundary", () => {
  it("returns a full period when exactly on a boundary (no double-fire)", () => {
    expect(msUntilNextBoundary(300_000, 300_000 * 5)).toBe(300_000);
    expect(msUntilNextBoundary(60_000, 60_000 * 12)).toBe(60_000);
  });

  it("returns time to the next 5-min boundary", () => {
    expect(msUntilNextBoundary(300_000, 300_000 * 5 + 1_000)).toBe(299_000);
    expect(msUntilNextBoundary(300_000, 300_000 * 6 - 1)).toBe(1);
  });

  it("returns time to the next 1-min boundary", () => {
    expect(msUntilNextBoundary(60_000, 60_000 * 10 + 250)).toBe(59_750);
  });
});

describe("tickOnce", () => {
  it("reports active + pushes when the source is running", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ name: "test", count: 1, active: true });
    expect(captured.readings).toHaveLength(1);
  });

  it("reports deliveryActive separately when the source distinguishes them", async () => {
    // musher's shape: `isRunning` stays true through a diagnostic post-run hold so the LOCAL
    // journal keeps sampling finely, while delivery follows the engine. Before the two were split
    // that hold pushed active-rate data to LiveOne for an hour after every run.
    const { entry } = makeEntry(async () => ({ x: 0 }));
    (entry.source as { isRunning: (v: Values) => boolean }).isRunning = () =>
      true; // the hold
    (
      entry.source as unknown as { isDeliveryActive: (v: Values) => boolean }
    ).isDeliveryActive = (v) => Number(v.x ?? 0) > 0;
    const r = await tickOnce(entry, () => {});
    expect(r.active).toBe(true); // poll cadence stays fast
    expect(r.deliveryActive).toBe(false); // push cadence goes back to idle
  });

  it("defaults deliveryActive to active when the source says nothing", async () => {
    const { entry } = makeEntry(async () => ({ x: 5 }));
    const r = await tickOnce(entry, () => {});
    expect(r.active).toBe(true);
    expect(r.deliveryActive).toBe(true);
  });

  it("reports NOT active when the running signal is zero (still pushes the 0)", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 0 }));
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ name: "test", count: 1, active: false });
    expect(captured.readings).toHaveLength(1);
  });

  it("returns count 0 and does not push when all readings are n/a", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: null }));
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ name: "test", count: 0, active: false });
    expect(captured.meta).toBeUndefined();
  });

  it("returns count null on read error, without throwing", async () => {
    const { entry, captured } = makeEntry(async () => {
      throw new Error("boom");
    });
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ name: "test", count: null, active: false });
    expect(captured.resetCount).toBe(1); // reset the source so the next tick reconnects
  });

  it("aborts a hung read within the timeout and resets the source (no freeze)", async () => {
    // read() never resolves — the real-world hang that froze the loop
    const { entry, captured } = makeEntry(() => new Promise<Values>(() => {}));
    const start = Date.now();
    const r = await tickOnce(entry, () => {}, 60); // 60ms cap
    expect(r).toMatchObject({ name: "test", count: null, active: false });
    expect(Date.now() - start).toBeLessThan(1000); // it did NOT hang
    expect(captured.resetCount).toBe(1); // stale connection dropped → next tick reconnects
  });

  it("stamps the ACTUAL tick time (truthful, not snapped to a boundary)", async () => {
    const before = Date.now();
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    await tickOnce(entry, () => {});
    const after = Date.now();
    const stampedMs = Date.parse(captured.meta!.measurementTime);
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(after);
    // sessionLabel carries the same real instant, not a rounded boundary
    expect(captured.meta!.sessionLabel).toMatch(/^test\/\d+$/);
  });
});

describe("tickOnce store wiring (blackbox + spool)", () => {
  function makeStore() {
    const journalled: unknown[] = [];
    const spooled: unknown[] = [];
    return {
      journalled,
      spooled,
      blackbox: {
        append: async (r: unknown) => {
          journalled.push(r);
        },
      },
      spool: {
        enqueue: async (b: unknown) => {
          spooled.push(b);
          return true;
        },
      },
    };
  }

  it("journals the batch to the blackbox BEFORE a successful push", async () => {
    const { entry } = makeEntry(async () => ({ x: 5 }));
    const store = makeStore();
    Object.assign(entry, { blackbox: store.blackbox, spool: store.spool });
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ count: 1, pushOk: true });
    expect(store.journalled).toHaveLength(1);
    expect(store.journalled[0]).toMatchObject({ siteId: "s", count: 1 });
    expect(store.spooled).toHaveLength(0); // push succeeded → nothing spooled
  });

  it("spools the batch when the push fails transiently", async () => {
    const { entry } = makeEntry(async () => ({ x: 5 }));
    const store = makeStore();
    Object.assign(entry, {
      blackbox: store.blackbox,
      spool: store.spool,
      pusher: { store: async () => "transient" as const },
    });
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ count: 1, pushOk: false, spooled: true });
    expect(r.error).toMatch(/spooled/);
    expect(store.journalled).toHaveLength(1); // journalled regardless
    expect(store.spooled).toHaveLength(1);
    expect(store.spooled[0]).toMatchObject({ siteId: "s" });
  });

  it("does NOT spool a permanently rejected (4xx) batch", async () => {
    const { entry } = makeEntry(async () => ({ x: 5 }));
    const store = makeStore();
    Object.assign(entry, {
      blackbox: store.blackbox,
      spool: store.spool,
      pusher: { store: async () => "rejected" as const },
    });
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ count: 1, pushOk: false });
    expect(r.spooled).toBeUndefined();
    expect(r.error).toMatch(/rejected/);
    expect(store.journalled).toHaveLength(1); // the blackbox still has it
    expect(store.spooled).toHaveLength(0);
  });

  it("journals nothing when there are no readings (all n/a)", async () => {
    const { entry } = makeEntry(async () => ({ x: null }));
    const store = makeStore();
    Object.assign(entry, { blackbox: store.blackbox, spool: store.spool });
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ count: 0 });
    expect(store.journalled).toHaveLength(0);
  });

  it("runs without a store at all (degraded mode = old behavior)", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ count: 1, pushOk: true });
    expect(captured.readings).toHaveLength(1);
  });
});

describe("tickOnce delivery gating (poll ≠ push)", () => {
  function makeStore() {
    const journalled: unknown[] = [];
    return {
      journalled,
      blackbox: {
        append: async (r: unknown) => {
          journalled.push(r);
        },
      },
    };
  }

  it("reads the device but neither blackboxes nor pushes on a poll-only tick", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    const store = makeStore();
    Object.assign(entry, { blackbox: store.blackbox });

    const r = await tickOnce(
      entry,
      () => {},
      undefined,
      () => false,
    );

    expect(r).toMatchObject({ count: 1, active: true, delivered: false });
    expect(r.pushOk).toBeUndefined();
    expect(captured.readings).toBeUndefined(); // never reached the pusher
    expect(store.journalled).toHaveLength(0); // blackbox records DELIVERIES, not polls
  });

  it("delivers normally when the gate allows it", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    const store = makeStore();
    Object.assign(entry, { blackbox: store.blackbox });

    const r = await tickOnce(
      entry,
      () => {},
      undefined,
      () => true,
    );

    expect(r).toMatchObject({ count: 1, delivered: true, pushOk: true });
    expect(captured.readings).toHaveLength(1);
    expect(store.journalled).toHaveLength(1);
  });

  it("gives the gate the source's running state, so push cadence can differ when active", async () => {
    const seen: boolean[] = [];
    const gate = (active: boolean) => {
      seen.push(active);
      return false;
    };
    await tickOnce(
      makeEntry(async () => ({ x: 5 })).entry,
      () => {},
      undefined,
      gate,
    ); // running
    await tickOnce(
      makeEntry(async () => ({ x: 0 })).entry,
      () => {},
      undefined,
      gate,
    ); // idle
    expect(seen).toEqual([true, false]);
  });

  it("delivers by default, so callers that ignore the gate are unaffected", async () => {
    const { entry, captured } = makeEntry(async () => ({ x: 5 }));
    const r = await tickOnce(entry, () => {});
    expect(r).toMatchObject({ delivered: true, pushOk: true });
    expect(captured.readings).toHaveLength(1);
  });

  it("never consults the gate when there is nothing to send", async () => {
    let consulted = false;
    const { entry } = makeEntry(async () => ({}));
    const r = await tickOnce(
      entry,
      () => {},
      undefined,
      () => {
        consulted = true;
        return true;
      },
    );
    expect(r).toMatchObject({ count: 0 });
    expect(r.delivered).toBeUndefined();
    expect(consulted).toBe(false);
  });
});

describe("shouldDeliverTick", () => {
  // A source with no supervisor, freshly delivered, nothing transitioning: the boring case.
  const base = {
    active: false,
    wasActive: false,
    controlVersion: undefined,
    lastControlVersion: undefined,
    inTransition: false,
    sinceDeliveredMs: 0,
    idlePushMs: 300_000,
    activePushMs: 60_000,
  };

  it("holds a tick that is not due", () => {
    expect(shouldDeliverTick(base)).toBe(false);
  });

  describe("tolerance — the one-tick overshoot", () => {
    // Measured on prod 2026-08-30: a 60s push cadence on a 15s poll delivered every 75s, and a
    // 300s one every 315s, because `sinceDeliveredMs` is measured from the END of the previous
    // delivery (a second or two past its tick boundary) while ticks arrive ON the boundary.
    const TICK = 15_000;
    const tol = { toleranceMs: TICK / 2 };

    it("delivers on the due tick despite the read+push cost of the last one", () => {
      // The tick that SHOULD deliver arrives 1.8s short of the nominal period.
      expect(
        shouldDeliverTick({ ...base, ...tol, sinceDeliveredMs: 298_200 }),
      ).toBe(true);
      expect(
        shouldDeliverTick({
          ...base,
          ...tol,
          active: true,
          sinceDeliveredMs: 58_200,
        }),
      ).toBe(true);
    });

    it("never delivers a whole tick early", () => {
      // Half a period of slack is by construction less than the gap to the previous tick, so the
      // tick BEFORE the due one is still refused.
      expect(
        shouldDeliverTick({
          ...base,
          ...tol,
          sinceDeliveredMs: 300_000 - TICK - 1_800,
        }),
      ).toBe(false);
    });

    it("is opt-in: without a tolerance the comparison is exact, as before", () => {
      expect(shouldDeliverTick({ ...base, sinceDeliveredMs: 298_200 })).toBe(
        false,
      );
    });
  });

  it("delivers once the idle push period has elapsed", () => {
    expect(shouldDeliverTick({ ...base, sinceDeliveredMs: 299_999 })).toBe(
      false,
    );
    expect(shouldDeliverTick({ ...base, sinceDeliveredMs: 300_000 })).toBe(
      true,
    );
  });

  it("uses the ACTIVE period while the genset runs", () => {
    const running = { ...base, active: true, wasActive: true };
    expect(shouldDeliverTick({ ...running, sinceDeliveredMs: 60_000 })).toBe(
      true,
    );
    expect(shouldDeliverTick({ ...running, sinceDeliveredMs: 59_999 })).toBe(
      false,
    );
  });

  it("delivers on the running edge, in both directions", () => {
    expect(shouldDeliverTick({ ...base, active: true })).toBe(true);
    expect(shouldDeliverTick({ ...base, active: false, wasActive: true })).toBe(
      true,
    );
  });

  it("does not treat process start as an edge (wasActive undefined)", () => {
    expect(
      shouldDeliverTick({ ...base, active: true, wasActive: undefined }),
    ).toBe(false);
  });

  it("delivers when a command moved the supervisor's state", () => {
    expect(
      shouldDeliverTick({
        ...base,
        controlVersion: 4,
        lastControlVersion: 3,
      }),
    ).toBe(true);
    expect(
      shouldDeliverTick({
        ...base,
        controlVersion: 3,
        lastControlVersion: 3,
      }),
    ).toBe(false);
  });

  // The bracket's whole point: mid-start/mid-stop every tick goes, however recently we delivered
  // and whatever the push period says.
  it("delivers every tick while the engine is starting or stopping", () => {
    expect(shouldDeliverTick({ ...base, inTransition: true })).toBe(true);
    expect(
      shouldDeliverTick({
        ...base,
        active: true,
        wasActive: true,
        inTransition: true,
        sinceDeliveredMs: 5_000,
      }),
    ).toBe(true);
  });
});
