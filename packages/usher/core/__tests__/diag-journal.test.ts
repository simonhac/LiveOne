import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagJournal } from "../diag-journal";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "diag-journal-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
/** 2026-08-10T00:00:00Z — fixed so day-rolls are deterministic. */
const T0 = Date.parse("2026-08-10T00:00:00Z");

/** A record big enough that a handful of them cross a small test cap. */
const fatRecord = (n: number) => ({ n, pad: "x".repeat(4096) });

const names = async (dir: string) => (await fs.readdir(dir)).sort();
const totalBytes = async (dir: string) => {
  let total = 0;
  for (const n of await fs.readdir(dir)) {
    total += (await fs.stat(path.join(dir, n))).size;
  }
  return total;
};

describe("DiagJournal disk cap", () => {
  it("purges oldest-first to stay under maxBytes, keeping the newest days", async () => {
    // Pre-seed four completed days, ~20 KB each, oldest first.
    for (const day of ["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"]) {
      await fs.writeFile(path.join(tmp, `${day}.jsonl.gz`), Buffer.alloc(20_000, 1));
    }

    // Cap at 50 KB: the four seeded days (80 KB) already bust it.
    let now = T0;
    const dj = await DiagJournal.create(tmp, {
      now: () => now,
      maxBytes: 50_000,
    });
    expect(dj).not.toBeNull();

    // create() sweeps at boot, so the two oldest should already be gone.
    const afterBoot = await names(tmp);
    expect(afterBoot).not.toContain("2026-08-06.jsonl.gz");
    expect(afterBoot).not.toContain("2026-08-07.jsonl.gz");
    expect(afterBoot).toContain("2026-08-09.jsonl.gz");
    expect(await totalBytes(tmp)).toBeLessThanOrEqual(50_000);
  });

  it("never deletes the day it is writing to, even when that alone exceeds the cap", async () => {
    let now = T0;
    const dj = await DiagJournal.create(tmp, { now: () => now, maxBytes: 1_000 });
    // Enough appends to trigger a sweep (SWEEP_EVERY_APPENDS = 240) and blow a 1 KB cap.
    for (let i = 0; i < 250; i++) await dj!.append(fatRecord(i));

    const remaining = await names(tmp);
    expect(remaining).toEqual(["2026-08-10.jsonl"]);
    // The live file survived and still holds every record.
    const lines = (await fs.readFile(path.join(tmp, "2026-08-10.jsonl"), "utf-8"))
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(250);
  });

  it("rolls the previous day to .gz and applies the cap on the roll", async () => {
    let now = T0;
    const dj = await DiagJournal.create(tmp, { now: () => now, maxBytes: 10_000_000 });
    await dj!.append({ hello: "day one" });

    now = T0 + DAY; // cross midnight
    await dj!.append({ hello: "day two" });

    const after = await names(tmp);
    expect(after).toContain("2026-08-10.jsonl.gz"); // yesterday, compressed
    expect(after).toContain("2026-08-11.jsonl"); // today, live
    expect(after).not.toContain("2026-08-10.jsonl");
  });

  it("degrades rather than throwing when the directory disappears mid-run", async () => {
    let now = T0;
    const dj = await DiagJournal.create(tmp, { now: () => now });
    await dj!.append({ ok: 1 });
    await fs.rm(tmp, { recursive: true, force: true });
    // Must not reject — a broken disk may never break the collector loop.
    await expect(dj!.append({ ok: 2 })).resolves.toBeUndefined();
  });
});
