import { describe, it, expect } from "@jest/globals";
import { msUntilNextBoundary, tickOnce, type Entry } from "../run";
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
