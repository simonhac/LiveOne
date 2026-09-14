/**
 * The smoke scripts' world snapshot — specifically, that it SURVIVES THE JOURNAL.
 *
 * 🛑 This exists because the thing it pins has already failed in the worst possible way. The snapshot
 * is what stands between a live smoke run and permanent loss of hand-authored `area_bindings` on the
 * shared dev database, and its first two versions were both broken:
 *
 *   1. It captured placements but not bindings. A run destroyed 23 real bindings and reported
 *      `✅ ALL CHECKS PASSED`, because membership came back byte-identical.
 *   2. It captured whole `area_bindings` rows, including the `Date` columns. Those survive in memory
 *      and do NOT survive `JSON.stringify` — they come back as strings, and drizzle's timestamp
 *      mapper calls `.toISOString()` on them and throws. So the in-memory path passed every test
 *      while restoring FROM A JOURNAL — the entire point of the journal — failed every time.
 *
 * The round-trip is therefore the assertion, not a detail of it.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captured = {
  devices: [] as { id: string; areaId: string | null }[],
  bindings: [] as Record<string, unknown>[],
  areas: [] as { id: string }[],
};
const writes: { op: string; values?: unknown }[] = [];

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb: () => fakeDb,
}));

const fakeDb = {
  select: (proj?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      // Which table is being read is inferred from the projection the caller asked for — enough for
      // this fake, and it keeps the test from depending on drizzle's private table symbols.
      if (proj && "pointUid" in proj) return Promise.resolve(captured.bindings);
      if (proj && "areaId" in proj && "id" in proj)
        return Promise.resolve(captured.devices);
      return Promise.resolve(captured.areas);
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        writes.push({ op: "update-device", values });
      },
    }),
  }),
  insert: () => ({
    values: (values: unknown) => ({
      onConflictDoNothing: async () => {
        // 🛑 The real driver throws here if a `Date` column arrived as a string. Reproduce that,
        // because it is the exact failure the journal hit and a fake that accepts anything would
        // have passed while the shipped code could not restore a single row.
        for (const [k, v] of Object.entries(values as Record<string, unknown>))
          if (/^(createdAt|updatedAt)$/.test(k) && typeof v === "string")
            throw new TypeError("value.toISOString is not a function");
        writes.push({ op: "insert-binding", values });
      },
    }),
  }),
};

import {
  captureWorld,
  clearJournal,
  readJournal,
  restoreWorld,
} from "../smoke-world-snapshot";

let dir: string;

beforeEach(() => {
  writes.length = 0;
  dir = mkdtempSync(join(tmpdir(), "world-snap-"));
  captured.devices = [
    { id: "dev-1", areaId: "area-a" },
    { id: "dev-2", areaId: null },
  ];
  captured.bindings = [
    {
      areaId: "area-a",
      role: "solar",
      metricType: "power",
      pointUid: "pt-1",
      ordinal: 0,
      priority: 0,
      transform: null,
    },
  ];
  captured.areas = [{ id: "area-a" }];
});

describe("the world snapshot", () => {
  it("🛑 restores from a JOURNAL, not just from memory", async () => {
    const path = join(dir, "journal.json");
    await captureWorld(path);

    // The load-bearing step: go through disk, exactly as a crashed run's recovery does.
    const reloaded = readJournal(path);
    expect(reloaded).not.toBeNull();
    expect(await restoreWorld(reloaded!)).toBe(true);

    expect(writes.filter((w) => w.op === "update-device")).toHaveLength(2);
    expect(writes.filter((w) => w.op === "insert-binding")).toHaveLength(1);
  });

  it("captures no Date columns at all — they cannot survive JSON", async () => {
    const path = join(dir, "j2.json");
    const snap = await captureWorld(path);
    for (const b of snap.bindings) {
      expect(b).not.toHaveProperty("createdAt");
      expect(b).not.toHaveProperty("updatedAt");
      // `id` goes too: it is a surrogate, and the natural key is what the re-insert conflicts on.
      expect(b).not.toHaveProperty("id");
    }
  });

  it("journals BEFORE it returns, so a crash straight after leaves the evidence", async () => {
    const path = join(dir, "j3.json");
    await captureWorld(path);
    expect(readJournal(path)?.placements).toEqual([
      ["dev-1", "area-a"],
      ["dev-2", null],
    ]);
  });

  it("skips a binding whose area is gone rather than failing the restore", async () => {
    // Nothing in a snapshot taken before the run can name a scratch area, so a missing area means a
    // REAL one was deleted during the run — the operator's business, not a restore failure.
    captured.areas = [];
    const path = join(dir, "j4.json");
    const snap = await captureWorld(path);
    expect(await restoreWorld(snap)).toBe(true);
    expect(writes.filter((w) => w.op === "insert-binding")).toHaveLength(0);
  });

  it("reports false when a restore fails, so the caller can veto teardown", async () => {
    const path = join(dir, "j5.json");
    const snap = await captureWorld(path);
    // A Date that slipped through would throw in the driver — the round-trip failure, simulated.
    (snap.bindings[0] as unknown as Record<string, unknown>).createdAt =
      "2026-01-01T00:00:00.000Z";
    expect(await restoreWorld(snap)).toBe(false);
  });

  it("readJournal answers null for a missing or corrupt file", () => {
    expect(readJournal(join(dir, "nope.json"))).toBeNull();
    clearJournal(join(dir, "nope.json")); // must not throw
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});
