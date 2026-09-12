import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Spool, type SpooledBatch } from "../spool";
import type { DiskSpace } from "../disk";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "spool-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const batch = (siteId: string, label: string): SpooledBatch => ({
  siteId,
  sessionLabel: label,
  measurementTime: "2026-07-14T10:00:00.000Z",
  readings: [
    { physicalPathTail: "x", value: 1, metricType: "power", metricUnit: "W" },
  ],
  spooledAt: "2026-07-14T10:00:05.000Z",
});

const bigDisk = async (): Promise<DiskSpace | null> => ({
  capacityBytes: 10_000_000,
  freeBytes: 9_000_000,
  freeFrac: 0.9,
});

describe("Spool", () => {
  it("enqueues one file per batch and drains them oldest-first on ack", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("s1", "a"));
    await spool.enqueue(batch("s1", "b"));

    const sent: string[] = [];
    const result = await spool.drain("s1", async (b) => {
      sent.push(b.sessionLabel);
      return "ok";
    });
    expect(sent).toEqual(["a", "b"]); // oldest first
    expect(result).toMatchObject({ sent: 2, dropped: 0, remaining: 0 });
    expect(await fs.readdir(tmp)).toHaveLength(0); // acked → deleted
  });

  it("stops draining on a transient failure and keeps the files", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("s1", "a"));
    await spool.enqueue(batch("s1", "b"));

    const result = await spool.drain("s1", async () => "transient");
    expect(result).toMatchObject({ sent: 0, remaining: 2 }); // receiver still down
    expect(await fs.readdir(tmp)).toHaveLength(2);
  });

  it("deletes (but counts) a permanently rejected batch and keeps going", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("s1", "bad"));
    await spool.enqueue(batch("s1", "good"));

    const result = await spool.drain("s1", async (b) =>
      b.sessionLabel === "bad" ? "rejected" : "ok",
    );
    expect(result).toMatchObject({ sent: 1, dropped: 1, remaining: 0 });
  });

  it("only drains the requested site's batches", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("s1", "mine"));
    await spool.enqueue(batch("s2", "other"));

    const sent: string[] = [];
    await spool.drain("s1", async (b) => {
      sent.push(b.sessionLabel);
      return "ok";
    });
    expect(sent).toEqual(["mine"]);
    expect(await fs.readdir(tmp)).toHaveLength(1); // s2's file untouched
  });

  it("caps the spool at the disk fraction by dropping the OLDEST batch", async () => {
    let clock = 1000;
    const logs: string[] = [];
    // capacity 10_000 → cap at 75% = 7_500 bytes; each batch ≈ 230 bytes
    const tiny = async (): Promise<DiskSpace | null> => ({
      capacityBytes: 10_000,
      freeBytes: 9_000,
      freeFrac: 0.9,
    });
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: tiny,
      maxDiskFrac: 0.05, // cap = 500 bytes → holds ~2 batches
      log: (m) => logs.push(m),
    }))!;
    await spool.enqueue(batch("s1", "first"));
    await spool.enqueue(batch("s1", "second"));
    await spool.enqueue(batch("s1", "third")); // must evict "first"

    const names = (await fs.readdir(tmp)).sort();
    const contents = await Promise.all(
      names.map(async (n) =>
        JSON.parse(await fs.readFile(path.join(tmp, n), "utf8")),
      ),
    );
    const labels = contents.map((c) => c.sessionLabel);
    expect(labels).not.toContain("first"); // oldest dropped
    expect(labels).toContain("third"); // newest kept
    expect(logs.join(" ")).toMatch(/DROPPED oldest/);
  });

  // The onDrop hook is the ONLY data-loss signal this fleet has (core/spool-metrics.ts). Every
  // other metric anywhere describes an observability gap; if these three sites stop firing,
  // readings that were collected are destroyed and nothing reports it.
  it("reports every destroyed batch through onDrop, with its reason", async () => {
    let clock = 1000;
    const reasons: string[] = [];
    const tiny = async (): Promise<DiskSpace | null> => ({
      capacityBytes: 10_000,
      freeBytes: 9_000,
      freeFrac: 0.9,
    });
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: tiny,
      maxDiskFrac: 0.05, // cap = 500 bytes → holds ~2 batches
      onDrop: (reason) => reasons.push(reason),
    }))!;

    await spool.enqueue(batch("s1", "first"));
    await spool.enqueue(batch("s1", "second"));
    await spool.enqueue(batch("s1", "third")); // evicts "first"
    expect(reasons).toEqual(["disk_cap"]);

    // A 4xx from the receiver: permanently rejected, deleted, and gone.
    await spool.drain("s1", async () => "rejected");
    expect(reasons.filter((r) => r === "rejected").length).toBeGreaterThan(0);

    // A corrupt file is deleted too, and that is data loss just the same.
    await fs.writeFile(path.join(tmp, "9999-0-s1.json"), "{not json");
    await spool.drain("s1", async () => "ok");
    expect(reasons).toContain("unreadable");
  });

  it("never lets a throwing onDrop reach the collector", async () => {
    // Metrics are best-effort; losing a batch must not also mean crashing the loop that would have
    // logged it.
    let clock = 1000;
    const tiny = async (): Promise<DiskSpace | null> => ({
      capacityBytes: 10_000,
      freeBytes: 9_000,
      freeFrac: 0.9,
    });
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: tiny,
      maxDiskFrac: 0.05,
      onDrop: () => {
        throw new Error("exporter is down");
      },
    }))!;
    await spool.enqueue(batch("s1", "first"));
    await spool.enqueue(batch("s1", "second"));
    await expect(spool.enqueue(batch("s1", "third"))).resolves.toBe(true);
  });

  it("is re-entrancy guarded per site (no double-send from overlapping drains)", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await spool.enqueue(batch("s1", "a"));

    let inFlight = 0;
    let maxInFlight = 0;
    const slowSend = async (): Promise<"ok"> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return "ok";
    };
    const [r1, r2] = await Promise.all([
      spool.drain("s1", slowSend),
      spool.drain("s1", slowSend),
    ]);
    expect(maxInFlight).toBe(1); // second call bailed out
    expect(r1.sent + r2.sent).toBe(1);
  });

  it("deletes an unreadable batch file instead of wedging the drain", async () => {
    let clock = 1000;
    const spool = (await Spool.create(tmp, {
      now: () => clock++,
      diskSpaceFn: bigDisk,
    }))!;
    await fs.writeFile(path.join(tmp, "0500-0-s1.json"), "not json{{{");
    await spool.enqueue(batch("s1", "good"));

    const result = await spool.drain("s1", async () => "ok");
    expect(result).toMatchObject({ sent: 1, dropped: 1, remaining: 0 });
  });

  it("degrades (returns null) when the dir is not writable", async () => {
    const file = path.join(tmp, "not-a-dir");
    await fs.writeFile(file, "block");
    const logs: string[] = [];
    const spool = await Spool.create(file, { log: (m) => logs.push(m) });
    expect(spool).toBeNull();
    expect(logs.join(" ")).toMatch(/DISABLED/);
  });
});
