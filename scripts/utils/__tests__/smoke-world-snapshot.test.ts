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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assertNoStaleJournal,
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

  it("readJournal answers null for a MISSING file, and THROWS on a corrupt one", () => {
    expect(readJournal(join(dir, "nope.json"))).toBeNull();
    clearJournal(join(dir, "nope.json")); // must not throw

    // 🛑 A file that exists but does not parse is not "no journal". Treating it as one let the next
    // run sail past the refusal and overwrite the only record of a damaged world with a snapshot OF
    // that damaged world.
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    expect(() => readJournal(corrupt)).toThrow(/not readable JSON/);
  });

  it("🛑 REFUSES to restore a journal taken against a DIFFERENT database", async () => {
    // The stamp was written and never compared for a whole round, which made its own docstring
    // false. These are the same rows copied between environments, so every uuid would still
    // "resolve" — which is exactly why a mismatch has to be refused rather than trusted.
    const snap = await captureWorld(join(dir, "j7.json"));
    snap.database = "someone@elsewhere.psdb.cloud/postgres";
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await restoreWorld(snap)).toBe(false);
      expect(err.mock.calls.flat().join("\n")).toContain("REFUSING to restore");
    } finally {
      err.mockRestore();
    }
    expect(writes).toEqual([]);
  });

  it("🛑 REFUSES on a stale journal rather than replaying it", async () => {
    // The hazard the refusal exists for: a journal is a photograph of the WHOLE config, so replaying
    // one is a blind write over every placement and every binding, with no idea what has
    // legitimately changed since — a real re-home, or the 2-hourly prod→dev sync. Automatic revert
    // of unknown edits is not a safety feature, so a human decides.
    const path = join(dir, "stale.json");
    await captureWorld(path);
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => assertNoStaleJournal(path)).toThrow("exited");
      expect(exit).toHaveBeenCalledWith(1);
      // …and it tells the operator how to act on it, both ways.
      const printed = err.mock.calls.flat().join("\n");
      expect(printed).toContain("restore-smoke-journal.ts");
      expect(printed).toContain(`rm ${path}`);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
    // 🛑 And it did NOT write: refusing must not itself mutate anything.
    expect(writes).toEqual([]);
  });

  it("does nothing at all when there is no journal", () => {
    expect(() => assertNoStaleJournal(join(dir, "absent.json"))).not.toThrow();
  });

  it("stamps the journal with the database it came from", async () => {
    // A journal is only meaningful against its own database; without this stamp one could be
    // replayed over a different branch and every uuid would still "resolve".
    const snap = await captureWorld(join(dir, "j6.json"));
    expect(typeof snap.database).toBe("string");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});
