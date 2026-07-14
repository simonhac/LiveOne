import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Blackbox, type BlackboxRecord } from "../blackbox";
import type { DiskSpace } from "../disk";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "blackbox-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const record = (siteId = "s1"): BlackboxRecord => ({
  at: new Date().toISOString(),
  siteId,
  sessionLabel: `${siteId}/123`,
  measurementTime: new Date().toISOString(),
  count: 1,
  readings: [
    { physicalPathTail: "x", value: 1, metricType: "power", metricUnit: "W" },
  ],
});

/** fixed-capacity disk probe the tests can tune */
const spaceFn =
  (state: { freeFrac: number }) => async (): Promise<DiskSpace | null> => ({
    capacityBytes: 1_000_000,
    freeBytes: state.freeFrac * 1_000_000,
    freeFrac: state.freeFrac,
  });

describe("Blackbox", () => {
  it("appends one JSONL line per record to today's (UTC) file", async () => {
    const now = Date.parse("2026-07-14T10:00:00Z");
    const bb = (await Blackbox.create(tmp, { now: () => now }))!;
    await bb.append(record());
    await bb.append(record());
    const content = await fs.readFile(
      path.join(tmp, "2026-07-14.jsonl"),
      "utf8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ siteId: "s1", count: 1 });
  });

  it("rolls at the UTC day boundary and gzips the completed day", async () => {
    let nowMs = Date.parse("2026-07-14T23:59:00Z");
    const bb = (await Blackbox.create(tmp, {
      now: () => nowMs,
      diskSpaceFn: spaceFn({ freeFrac: 0.5 }), // plenty free → no GC interference
    }))!;
    await bb.append(record());
    nowMs = Date.parse("2026-07-15T00:01:00Z"); // cross midnight
    await bb.append(record());

    const names = (await fs.readdir(tmp)).sort();
    expect(names).toContain("2026-07-14.jsonl.gz");
    expect(names).toContain("2026-07-15.jsonl");
    expect(names).not.toContain("2026-07-14.jsonl");

    // the archive is a valid gzip of the original line
    const gunzipped = zlib
      .gunzipSync(await fs.readFile(path.join(tmp, "2026-07-14.jsonl.gz")))
      .toString("utf8");
    expect(JSON.parse(gunzipped.trim())).toMatchObject({ siteId: "s1" });
  });

  it("compresses stale day files found at startup (crash recovery)", async () => {
    await fs.writeFile(path.join(tmp, "2026-07-10.jsonl"), "{}\n");
    const now = Date.parse("2026-07-14T10:00:00Z");
    await Blackbox.create(tmp, {
      now: () => now,
      diskSpaceFn: spaceFn({ freeFrac: 0.5 }), // plenty free → no GC interference
    });
    const names = await fs.readdir(tmp);
    expect(names).toContain("2026-07-10.jsonl.gz");
    expect(names).not.toContain("2026-07-10.jsonl");
  });

  it("GCs oldest archives when the disk is below the free floor", async () => {
    const state = { freeFrac: 0.5 };
    const now = Date.parse("2026-07-14T10:00:00Z");
    const bb = (await Blackbox.create(tmp, {
      now: () => now,
      diskSpaceFn: spaceFn(state),
    }))!;
    await fs.writeFile(path.join(tmp, "2026-07-01.jsonl.gz"), "old");
    await fs.writeFile(path.join(tmp, "2026-07-02.jsonl.gz"), "newer");

    // disk "fills": below 10% free until one file is deleted
    let calls = 0;
    state.freeFrac = 0.05;
    const recovering = async (): Promise<DiskSpace | null> => {
      calls++;
      const freeFrac = calls > 1 ? 0.5 : 0.05; // freed after the first delete
      return {
        capacityBytes: 1_000_000,
        freeBytes: freeFrac * 1_000_000,
        freeFrac,
      };
    };
    const bb2 = (await Blackbox.create(tmp, {
      now: () => now,
      diskSpaceFn: recovering,
    }))!;
    void bb; // first instance only seeded the dir

    const names = await fs.readdir(tmp);
    expect(names).not.toContain("2026-07-01.jsonl.gz"); // oldest deleted
    expect(names).toContain("2026-07-02.jsonl.gz"); // newer survived
    expect(bb2.statsSync().enabled).toBe(true);
  });

  it("degrades (returns null) when the dir is not writable, without throwing", async () => {
    const file = path.join(tmp, "not-a-dir");
    await fs.writeFile(file, "block"); // a FILE at the dir path → mkdir fails
    const logs: string[] = [];
    const bb = await Blackbox.create(file, { log: (m) => logs.push(m) });
    expect(bb).toBeNull();
    expect(logs.join(" ")).toMatch(/DISABLED/);
  });

  it("disables itself on a write error instead of throwing into the loop", async () => {
    const now = Date.parse("2026-07-14T10:00:00Z");
    const logs: string[] = [];
    const bb = (await Blackbox.create(tmp, {
      now: () => now,
      log: (m) => logs.push(m),
    }))!;
    // Replace today's file with a DIRECTORY so appendFile fails.
    await fs.mkdir(path.join(tmp, "2026-07-14.jsonl"));
    await expect(bb.append(record())).resolves.toBeUndefined(); // no throw
    await bb.append(record()); // still no throw while disabled
    expect(logs.join(" ")).toMatch(/journaling DISABLED/);
  });
});
