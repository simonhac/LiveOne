/**
 * `import --check-all` — the pre-flight, and the chunk-boundary honesty it fixes.
 *
 * 🛑 The bug this closes is not "the dry run is incomplete", it is that the dry run LOOKED complete.
 * A 64,070-row file reported `created: 5000, replaced: 0, downgraded: 0` beside `rows: 64070` — the
 * first of 13 chunks, labelled only by an adjacent `effectSampledFrom`. An operator asking "does
 * any row in this file downgrade a measured value?" was answered about 7.8% of it.
 *
 * And apply is chunked too, with no transaction: a refusal in chunk 7 leaves chunks 1-6 written.
 *
 * These tests drive the real handler with both network seams mocked, which is the only way to
 * observe the thing that matters — WHICH REQUESTS WERE ISSUED, and whether any of them wrote.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type Tty } from "@/lib/cli/cli";

const PT = "pt_3ae6h0d8f2avvbadgq4t3ctsgq";
const CHUNK = 5000;
const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };

/** A file of `rows` rows on the 5-minute grid — enough to span several chunks. */
function csvFile(rows: number): string {
  const lines = ["point,interval_end,value"];
  for (let i = 0; i < rows; i++)
    lines.push(
      `${PT},${new Date(Date.UTC(2026, 0, 1) + i * 300_000).toISOString()},${i}`,
    );
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "liveone-import-")),
    "rows.csv",
  );
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

interface Call {
  dryRun: boolean;
  rows: number;
}

/**
 * Load the handler with both seams replaced.
 *
 * `blockChunk` makes the server refuse one chunk with a 409, exactly as the real route does when a
 * row would downgrade a measured value — the case the pre-flight exists to catch before any write.
 */
async function load(blockChunk?: number) {
  const calls: Call[] = [];
  jest.resetModules();
  jest.doMock("@/lib/cli-kit/api-session", () => ({
    withApiSession: async (
      _ctx: unknown,
      fn: (s: unknown) => Promise<number>,
    ) =>
      fn({
        origin: "https://example.test",
        token: "lo_cli_x",
        get: async () => ({
          devices: [
            {
              id: "dv_x",
              legacySystemId: 1,
              name: "Test",
              slug: null,
              vendor: "fusher",
              status: "active",
              ownerUserId: "u",
              areaId: null,
              areaName: null,
            },
          ],
        }),
      }),
  }));
  jest.doMock("@/lib/cli-kit/http", () => ({
    apiFetch: async (
      _o: string,
      _p: string,
      init: { body: { dryRun: boolean; readings: unknown[] } },
    ) => {
      const n = calls.length;
      calls.push({ dryRun: init.body.dryRun, rows: init.body.readings.length });
      if (blockChunk !== undefined && n % 1000 === blockChunk) {
        const { CliFailure: CF, EXIT } = await import("@/lib/cli/cli");
        throw new CF({
          code: EXIT.FINDINGS,
          what: "refused — this import would overwrite existing readings",
          why: "row would downgrade a measured value",
          next: "re-run with --overwrite-measured",
        });
      }
      return {
        body: {
          rows: init.body.readings.length,
          quality: "estimated",
          interval: "5m",
          sessionId: "se_x",
          firstInterval: "2026-01-01T00:05:00Z",
          lastInterval: "2026-01-02T00:05:00Z",
          created: init.body.readings.length,
          replaced: 0,
          downgraded: 0,
          downgradesOver: [],
          overMeasured: 0,
          successorDeltasRepaired: 0,
          written: init.body.dryRun ? 0 : init.body.readings.length,
          points: [],
        },
      };
    },
  }));
  const mod = await import("../cli");
  return { calls, mod };
}

function ctxFor(
  mod: { importCommand: Parameters<typeof parse>[0] },
  argv: string[],
) {
  const r = parse(mod.importCommand, argv, TTY, ["liveone"]);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return {
    ...r,
    emit: () => {},
    note: () => {},
    warn: (m: string) => warnings.push(m),
    confirm: async () => true,
  };
}

/**
 * The `what` line of whatever refusal came out.
 *
 * 🛑 Not `toBeInstanceOf(CliFailure)`: `jest.resetModules()` gives the re-imported handler its OWN
 * copy of `lib/cli/cli`, so its `CliFailure` is a different constructor from the one this file
 * imported and the identity check fails with the baffling "Expected CliFailure, received
 * CliFailure". Assert on the shape instead.
 */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const d = (e as { detail?: { what?: string } }).detail;
    if (d?.what) return d.what;
    throw e;
  }
  throw new Error("expected a refusal, but the call returned");
}

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
});

const BASE = (file: string) => [
  "dv_x",
  `--file=${file}`,
  "--quality=estimated",
  "--session=se_x",
];

describe("the plain dry run", () => {
  it("sends ONE chunk and says plainly that the numbers are a sample", async () => {
    const file = csvFile(CHUNK * 3);
    const { calls, mod } = await load();
    await mod.runImport(ctxFor(mod, BASE(file)) as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ dryRun: true, rows: CHUNK });
    // 🛑 On stderr, not only in the payload: `effectSampledFrom` sits below three totals that read
    // like a verdict, and an operator checking for downgrades cannot tell from the numbers alone.
    expect(warnings.join(" ")).toMatch(/chunk 1 of 3/);
    expect(warnings.join(" ")).toMatch(/SAMPLE, not a verdict/);
    expect(warnings.join(" ")).toMatch(/--check-all/);
  });

  it("does not cry sample on a file that fits in one chunk", async () => {
    const { calls, mod } = await load();
    await mod.runImport(ctxFor(mod, BASE(csvFile(10))) as never);
    expect(calls).toHaveLength(1);
    expect(warnings.join(" ")).not.toMatch(/SAMPLE/);
  });
});

describe("--check-all", () => {
  it("projects EVERY chunk, and writes nothing", async () => {
    const { calls, mod } = await load();
    await mod.runImport(
      ctxFor(mod, [...BASE(csvFile(CHUNK * 3)), "--check-all"]) as never,
    );
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.dryRun)).toBe(true);
  });
});

describe("--apply", () => {
  it("warns that a multi-chunk write has no transaction across it", async () => {
    const { mod } = await load();
    await mod.runImport(
      ctxFor(mod, [...BASE(csvFile(CHUNK * 2)), "--apply", "--yes"]) as never,
    );
    expect(warnings.join(" ")).toMatch(/no transaction/);
  });

  /**
   * The whole point of the pre-flight. Without it the refusal in chunk 3 arrives AFTER chunks 1-2
   * are durably written; with it, the projection pass hits the same refusal and nothing is written
   * at all.
   */
  it("with --check-all, a refusal in a later chunk writes NOTHING", async () => {
    const { calls, mod } = await load(2);
    expect(
      await refusal(
        mod.runImport(
          ctxFor(mod, [
            ...BASE(csvFile(CHUNK * 4)),
            "--check-all",
            "--apply",
            "--yes",
          ]) as never,
        ),
      ),
    ).toMatch(/would overwrite existing readings/);
    expect(calls.every((c) => c.dryRun)).toBe(true);
    expect(calls.some((c) => !c.dryRun)).toBe(false);
  });

  it("without --check-all, the same refusal lands after earlier chunks are written", async () => {
    const { calls, mod } = await load(2);
    expect(
      await refusal(
        mod.runImport(
          ctxFor(mod, [
            ...BASE(csvFile(CHUNK * 4)),
            "--apply",
            "--yes",
          ]) as never,
        ),
      ),
    ).toMatch(/would overwrite existing readings/);
    // This is the documented hazard, pinned so the warning above can never quietly stop being true.
    expect(calls.filter((c) => !c.dryRun && c.rows > 0)).toHaveLength(3);
  });
});
