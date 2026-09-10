/**
 * The `sync` verb's flag contract and its rendering.
 *
 * 🛑 What is load-bearing here is the SEPARATION of `published` from `landed`. On 2026-09-09 a
 * backfill reported `Rows inserted: 1008 / Success: YES` ten times while materialising zero rows,
 * because the number counted what the sync compared and nothing read the serving store back. Every
 * assertion below that looks like prose-checking is really checking that the two numbers cannot be
 * collapsed into one reassuring one — including the case that matters most, a verification that
 * TIMED OUT, which must never render as a measured zero.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { syncCommand, renderPlan, renderRun, type WireSync } from "../cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(syncCommand, argv, TTY, ["liveone"]);

const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

const WINDOW = ["10002", "--start=2026-07-07", "--end=2026-09-08"];

describe("flags", () => {
  it("is dry by default and writes only with --apply", () => {
    expect(success(WINDOW).dryRun).toBe(true);
    expect(success([...WINDOW, "--apply"]).dryRun).toBe(false);
  });

  it("requires a device", () => {
    expect(failure(["--start=2026-07-07", "--end=2026-07-08"])).toMatch(
      /device/i,
    );
  });

  it("rejects an action the vendor has no notion of", () => {
    expect(failure([...WINDOW, "--action=everything"])).toMatch(/action/);
  });
});

describe("the plan (dry run)", () => {
  const plan: WireSync = {
    device: { id: "dv_x", systemId: 10002, name: "Amber", vendor: "amber" },
    window: { start: "2026-07-07", end: "2026-09-08", days: 64 },
    action: "usage",
    dryRun: true,
    vendorMaxDays: 7,
    lane: "backfill",
    plan: Array.from({ length: 10 }, (_, i) => ({
      start: `2026-07-${String(7 + i * 7).padStart(2, "0")}`,
      end: `2026-07-${String(13 + i * 7).padStart(2, "0")}`,
      days: i === 9 ? 1 : 7,
    })),
    chunks: [],
    observations: 0,
    merged: 0,
    failed: 0,
    done: true,
    nextStart: null,
  };

  it("states the vendor's window, and that it is the VENDOR's", () => {
    // The caller passed 64 days and never a 7. Naming where the 7 comes from is what stops the
    // next person hard-coding it into a caller, which is how 8..30 came to fail at Amber with an
    // opaque 422 that named neither the limit nor the field.
    const out = renderPlan(plan);
    expect(out).toMatch(/10 × ≤7 days/);
    expect(out).toMatch(/vendor's own limit/);
  });

  it("says it would write, that it has not, and how to make it", () => {
    // 🛑 A dry run here touches NOTHING — no vendor fetch, no session rows. Saying so matters
    // because the admin sync's "dry run" DID fetch and DID write an ADMIN-DRYRUN session per call.
    const out = renderPlan(plan);
    expect(out).toMatch(/would fetch and publish/);
    expect(out).toMatch(/Nothing has been fetched or written/);
    expect(out).toMatch(/--apply/);
  });
});

describe("the run", () => {
  const chunk = (over: Partial<WireSync["chunks"][0]> = {}) => ({
    start: "2026-07-07",
    end: "2026-07-13",
    days: 7,
    observations: 1008,
    merged: 0,
    durationMs: 4200,
    ok: true,
    ...over,
  });

  const base = {
    device: { id: "dv_x", systemId: 10002, name: "Amber" },
    window: { start: "2026-07-07", end: "2026-07-13" },
    action: "usage",
    lane: "backfill",
    chunks: [chunk()],
    published: 1008,
    merged: 0,
    failed: 0,
    done: true,
    landed: {
      seriesCovering: 14,
      seriesTotal: 34,
      waitedMs: 10_000,
      settled: true,
    },
  };

  it("never uses the word that was the lie", () => {
    // "Rows inserted: 1008 / Success: YES", for a backfill that inserted nothing.
    expect(renderRun(base)).not.toMatch(/inserted/i);
  });

  it("reports published and landed as SEPARATE numbers", () => {
    const out = renderRun(base);
    expect(out).toMatch(/published\s+1008 observations/);
    expect(out).toMatch(/landed\s+14 of 34 series/);
  });

  it("renders a verification TIMEOUT as unknown, never as a measured zero", () => {
    // 🛑 The single most important line in this file. "I stopped waiting" and "nothing arrived"
    // produce the same zero; reporting the first as the second is the original defect wearing a
    // new hat.
    const out = renderRun({
      ...base,
      landed: {
        seriesCovering: 0,
        seriesTotal: 34,
        waitedMs: 120_000,
        settled: false,
      },
    });
    expect(out).toMatch(/landed\s+UNKNOWN/);
    expect(out).toMatch(/NOT a measurement of zero/);
    expect(out).not.toMatch(/landed\s+0 of/);
  });

  it("says plainly when landing was not checked at all", () => {
    const out = renderRun({ ...base, landed: null });
    expect(out).toMatch(/not checked/);
    expect(out).toMatch(/NOT a landing claim/);
  });

  it("reports a failed window and says the walk stopped", () => {
    // Marching on through a vendor that has started refusing turns one legible error into sixty.
    const out = renderRun({
      ...base,
      chunks: [
        chunk(),
        chunk({ ok: false, observations: 0, error: "429 Too Many Requests" }),
      ],
      failed: 1,
      done: false,
    });
    expect(out).toMatch(/FAILED — 429 Too Many Requests/);
    expect(out).toMatch(/walk stopped/);
  });

  it("says a partial window is resumable rather than leaving it looking complete", () => {
    const out = renderRun({ ...base, done: false });
    expect(out).toMatch(/NOT finished/);
    expect(out).toMatch(/resume/);
  });

  it("surfaces collapsed duplicates, which are a producer signal", () => {
    const out = renderRun({
      ...base,
      merged: 215,
      chunks: [chunk({ merged: 215 })],
    });
    expect(out).toMatch(/merged\s+215 duplicate/);
  });
});
