/**
 * The `device` verb's flag contract.
 *
 * `parse()` is importable here precisely because the domain module has no entrypoint, so the spec
 * can be exercised without a network, a token, or a running server. Handlers are not unit-tested —
 * their HTTP behaviour is covered by `lib/cli-kit/__tests__/http.test.ts`.
 *
 * 🛑 What is load-bearing here is `recompute`'s WINDOW. It is a delete-and-reinsert, and its
 * fleet-wide twin (`/api/cron/daily?action=regenerate`) reads a missing date as ALL HISTORY. The
 * assertions below pin the property that makes this verb safe where that one is not: the dangerous
 * case is not reachable by typing less.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { deviceCommand, renderRecompute, type WireRecompute } from "../cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };

/** Parse under the real ancestry, so error messages name a runnable command. */
const at = (argv: string[]) => parse(deviceCommand, argv, TTY, ["liveone"]);

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

describe("the write gate", () => {
  // The harness installs --apply/--dry-run/--yes from `mutates`, but only on the verbs that declare
  // it. A read verb that grew the flags would be advertising a gate it does not honour.
  it("recompute is dry by default and offers --apply", () => {
    const args = ["recompute", "kutis", "--date=2026-09-10"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it.each(["list", "show", "points", "latest", "history"])(
    "%s has no write flags at all",
    (verb) => {
      const args = verb === "list" ? [verb] : [verb, "kutis"];
      expect(failure([...args, "--apply"])).toMatch(/apply/i);
    },
  );

  it("refuses --apply and --dry-run together", () => {
    expect(
      failure([
        "recompute",
        "kutis",
        "--date=2026-09-10",
        "--apply",
        "--dry-run",
      ]),
    ).toMatch(/contradictory/i);
  });
});

describe("recompute's window", () => {
  it("accepts a single day", () => {
    expect(
      success(["recompute", "kutis", "--date=2026-09-10"]).flags.date,
    ).toBe("2026-09-10");
  });

  it("accepts a range", () => {
    const r = success([
      "recompute",
      "13",
      "--start=2026-09-10",
      "--end=2026-09-11",
    ]);
    expect(r.flags.start).toBe("2026-09-10");
    expect(r.flags.end).toBe("2026-09-11");
  });

  it("leaves every window flag ABSENT when not passed", () => {
    // 🛑 Sparse absence, not a default. A `default` on any of these would give the handler a window
    // the caller never typed — and the handler's "no window" refusal, the whole safety property of
    // this verb, would become unreachable.
    const r = success(["recompute", "kutis"]);
    for (const k of ["date", "start", "end"])
      expect(r.flags[k]).toBeUndefined();
  });

  it("refuses a date that is not a date", () => {
    expect(failure(["recompute", "kutis", "--date=6 September"])).toMatch(
      /date/i,
    );
    expect(failure(["recompute", "kutis", "--date=2026-13-01"])).toMatch(
      /date/i,
    );
    // A real calendar check, not a regex: 2026-02-31 matches YYYY-MM-DD and does not exist.
    expect(failure(["recompute", "kutis", "--start=2026-02-31"])).toMatch(
      /start|date/i,
    );
  });

  it("requires a device", () => {
    expect(failure(["recompute", "--date=2026-09-10"])).toMatch(/device/i);
  });

  it("takes exactly one device", () => {
    expect(
      failure(["recompute", "kutis", "daylesford", "--date=2026-09-10"]),
    ).toMatch(/argument/i);
  });
});

describe("the recompute report", () => {
  const base: WireRecompute = {
    device: { id: "dv_x", systemId: 13, name: "Kutis", vendor: "sigenergy" },
    window: { start: "2026-09-10", end: "2026-09-11", days: 2 },
    timezoneOffsetMin: 600,
    days: ["2026-09-10", "2026-09-11"],
    dryRun: false,
    agg1dDays: 2,
    provenanceAreas: 1,
  };

  it("says a dry run rebuilt nothing, and how to make it", () => {
    const out = renderRecompute({ ...base, dryRun: true, agg1dDays: 0 });
    expect(out).toMatch(/Nothing has been rebuilt/);
    expect(out).toMatch(/--apply/);
  });

  it("reports the days rebuilt against the days asked for", () => {
    // 🛑 Never a bare count. The recompute is best-effort per day, so "2" alone cannot distinguish
    // a complete rebuild from two of five.
    expect(renderRecompute(base)).toMatch(/2 of 2 day\(s\) rebuilt/);
  });

  it("says plainly when some days did NOT rebuild", () => {
    const out = renderRecompute({ ...base, agg1dDays: 1 });
    expect(out).toMatch(/1 day\(s\) did NOT rebuild/);
  });

  it("names what it does not cover", () => {
    // Run detectors are derivations with their own scoped verb. A report that stayed silent about
    // them reads as "everything derived is now current", which is the misreading that matters.
    expect(renderRecompute(base)).toMatch(/derivation recompute/);
  });
});
