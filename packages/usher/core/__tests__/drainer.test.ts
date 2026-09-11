/**
 * The drainer exists because `spool.drain` used to be reachable only from inside the poll loop. On
 * 2026-09-11 that loop wedged and 46 already-spooled batches sat on disk for 4 h 49 m — through the
 * receiver's recovery — because nothing outside the loop could send them.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Spool, type SpooledBatch } from "../spool";
import type { DiskSpace } from "../disk";
import { drainOnce } from "../drainer";
import type { ScheduledEntry } from "../run";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drainer-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const bigDisk = async (): Promise<DiskSpace | null> => ({
  capacityBytes: 10_000_000,
  freeBytes: 9_000_000,
  freeFrac: 0.9,
});

const batch = (siteId: string, label: string): SpooledBatch => ({
  siteId,
  sessionLabel: label,
  measurementTime: "2026-09-11T04:00:00.000Z",
  readings: [
    { physicalPathTail: "x", value: 1, metricType: "power", metricUnit: "W" },
  ],
  spooledAt: "2026-09-11T04:00:05.000Z",
});

/** An entry whose loop is NOT running — the whole point: nothing here ever ticks. */
function makeEntry(
  siteId: string,
  spool: Spool,
  store: (readings: unknown[]) => Promise<"ok" | "transient" | "rejected">,
): ScheduledEntry {
  return {
    source: { siteId, name: siteId },
    pusher: { store },
    spool,
    intervalMs: 15_000,
  } as unknown as ScheduledEntry;
}

describe("drainOnce", () => {
  it("sends a backlog for an entry whose loop never ticks", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    for (const label of ["a", "b", "c"]) {
      await spool.enqueue(batch("sheephouse", label));
    }
    expect(spool.statsSync().files).toBe(3);

    const sent: unknown[][] = [];
    const entry = makeEntry("sheephouse", spool, async (r) => {
      sent.push(r);
      return "ok";
    });

    await drainOnce([entry], () => {});
    expect(sent).toHaveLength(3);
    expect(spool.statsSync().files).toBe(0);
  });

  it("leaves the backlog alone while the receiver is still down", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("sheephouse", "a"));

    const entry = makeEntry("sheephouse", spool, async () => "transient");
    await drainOnce([entry], () => {});
    expect(spool.statsSync().files).toBe(1); // still there, to try again next minute
  });

  it("skips entries with an empty spool without calling the pusher", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    let calls = 0;
    const entry = makeEntry("sheephouse", spool, async () => {
      calls++;
      return "ok";
    });
    await drainOnce([entry], () => {});
    expect(calls).toBe(0);
  });

  // The background timer and the in-loop trigger can fire together; Spool.drain's per-site
  // re-entrancy guard is what makes that safe, so assert it rather than assuming it.
  it("cannot double-send when both triggers fire at once", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    for (const label of ["a", "b", "c"]) {
      await spool.enqueue(batch("sheephouse", label));
    }
    const sent: string[] = [];
    const slow = async (r: unknown[]) => {
      await new Promise((res) => setTimeout(res, 20));
      sent.push(String((r as { value: number }[])[0]?.value));
      return "ok" as const;
    };
    const entry = makeEntry("sheephouse", spool, slow);

    await Promise.all([
      drainOnce([entry], () => {}),
      drainOnce([entry], () => {}),
    ]);
    expect(sent).toHaveLength(3); // not 6
    expect(spool.statsSync().files).toBe(0);
  });

  it("one site's failure does not stop another site draining", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("sheephouse", "a"));
    await spool.enqueue(batch("kinkora", "b"));

    const bad = makeEntry("sheephouse", spool, async () => {
      throw new Error("pusher exploded");
    });
    const good = makeEntry("kinkora", spool, async () => "ok");

    const logs: string[] = [];
    await drainOnce([bad, good], (m) => logs.push(m));
    expect(logs.join()).toMatch(/sheephouse.*background drain failed/);
    expect(spool.statsSync().files).toBe(1); // kinkora's went, sheephouse's remains
  });
});
