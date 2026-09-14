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
import {
  deviceCommand,
  mergeChangeOffsetPasses,
  renderChangeOffset,
  renderRecompute,
  type WireChangeOffset,
  type WireRecompute,
} from "../cli";

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
  it("rename requires a device and name, and is dry-run by default", () => {
    const args = ["rename", "9", "Amber CitiPower NMI 6102849089"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
    expect(failure(["rename", "9"])).toMatch(/name/);
  });
  // The harness installs --apply/--dry-run/--yes from `mutates`, but only on the verbs that declare
  // it. A read verb that grew the flags would be advertising a gate it does not honour.
  it("recompute is dry by default and offers --apply", () => {
    const args = ["recompute", "kutis", "--date=2026-09-10"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it("change-offset is dry by default and offers --apply", () => {
    const args = ["change-offset", "kutis", "--offset=600"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it.each(["list", "show", "points", "latest", "history", "vendor-identity"])(
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
    dayOffsetMin: 600,
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

describe("change-offset has no window, deliberately", () => {
  // 🛑 The property that makes this verb correct is the INVERSE of `recompute`'s. A re-bucket has
  // exactly one right window — the whole history — because a partial one splits the device's days
  // across two boundaries with nothing recording where the seam is. Offering --date/--start/--end
  // would make a wrong answer typable.
  it.each(["--date=2026-09-10", "--start=2026-09-10", "--end=2026-09-10"])(
    "rejects %s",
    (flag) => {
      expect(failure(["change-offset", "kutis", "--offset=600", flag])).toMatch(
        /unknown/i,
      );
    },
  );

  it("takes the offset as minutes east of UTC", () => {
    expect(
      success(["change-offset", "kutis", "--offset=600"]).flags.offset,
    ).toBe("600");
  });
});

describe("change-offset's rendering", () => {
  const base: WireChangeOffset = {
    device: {
      id: "dv_x",
      systemId: 5,
      name: "Kinkora Fronius",
      vendor: "fusher",
    },
    offset: { from: 660, to: 600 },
    area: {
      id: "ar_01kv06sy19evn989sjamnjn4j8",
      name: "Kinkora Unified",
      dayOffsetMin: 660,
      otherDevices: ["Kinkora Mondo"],
      divergesAfter: true,
    },
    span: { startDay: "2025-09-22", endDay: "2026-09-13", rows: 1416 },
    days: 357,
    points: 13,
    dryRun: true,
    deleted1d: 0,
    agg1dDays: 0,
    provenanceAreas: 0,
    nextDay: null,
  };

  it("a dry run says the totals will change and that nothing has", () => {
    const out = renderChangeOffset(base);
    expect(out).toMatch(/\+660m → \+600m/);
    expect(out).toMatch(/Nothing has been changed/);
    expect(out).toMatch(/dry run/);
  });

  it("signs a negative offset rather than printing a bare minus", () => {
    const out = renderChangeOffset({
      ...base,
      offset: { from: -300, to: -360 },
    });
    expect(out).toMatch(/-300m → -360m/);
  });

  // The offset is written BEFORE the rebuild, so a shortfall leaves days deleted rather than wrong.
  // That is recoverable, but only if the operator is told — silence here would read as success.
  it("a shortfall names the recompute that finishes the job", () => {
    const out = renderChangeOffset({
      ...base,
      dryRun: false,
      deleted1d: 1416,
      agg1dDays: 300,
      provenanceAreas: 1,
    });
    expect(out).toMatch(/57 day\(s\) did NOT rebuild/);
    expect(out).toMatch(/liveone device recompute 5/);
  });

  it("reports the pass count once the resumption loop has run more than once", () => {
    // The loop is invisible in the result shape — the last pass's `nextDay` is null either way — so
    // the number of round trips is the only thing that tells an operator a 300 s budget was hit.
    const out = renderChangeOffset(
      {
        ...base,
        dryRun: false,
        deleted1d: 1416,
        agg1dDays: 357,
        provenanceAreas: 1,
      },
      3,
    );
    expect(out).toMatch(/357 of 357 day\(s\), over 3 passes/);
  });

  it("does not mention passes for a single-pass run", () => {
    const out = renderChangeOffset(
      {
        ...base,
        dryRun: false,
        deleted1d: 1416,
        agg1dDays: 357,
        provenanceAreas: 1,
      },
      1,
    );
    expect(out).not.toMatch(/passes/);
  });

  it("says plainly when there is nothing to rebuild", () => {
    const out = renderChangeOffset({ ...base, span: null, days: 0 });
    expect(out).toMatch(/no agg_1d rows/);
  });
});

describe("merging a re-bucket's passes", () => {
  // Modelled on the real prod run: pass 1 writes the offset, deletes 1416 rows and rebuilds 340 days
  // before its budget runs out; pass 2 re-plans (so it sees the ALREADY-WRITTEN offset and the rows
  // pass 1 left) and finishes the last 20.
  const pass1: WireChangeOffset = {
    device: {
      id: "dv_x",
      systemId: 5,
      name: "Kinkora Fronius",
      vendor: "fusher",
    },
    offset: { from: 660, to: 600 },
    area: {
      id: "ar_01kv06sy19evn989sjamnjn4j8",
      name: "Kinkora Unified",
      dayOffsetMin: 660,
      otherDevices: ["Kinkora Mondo"],
      divergesAfter: true,
    },
    span: { startDay: "2025-09-21", endDay: "2026-09-15", rows: 1416 },
    days: 360,
    points: 13,
    dryRun: false,
    deleted1d: 1416,
    agg1dDays: 340,
    provenanceAreas: 1,
    nextDay: "2026-08-27",
  };
  const pass2: WireChangeOffset = {
    ...pass1,
    offset: { from: 600, to: 600 }, // re-planned after pass 1 wrote it
    span: { startDay: "2025-09-21", endDay: "2026-09-15", rows: 1182 },
    deleted1d: 0, // the delete already happened
    agg1dDays: 20,
    nextDay: null,
  };

  const merged = mergeChangeOffsetPasses(pass1, pass2, 360);

  it("keeps the FIRST pass's delete count, not the resumed pass's zero", () => {
    expect(merged.deleted1d).toBe(1416);
  });

  it("keeps the original offset, so the report still says what changed", () => {
    expect(merged.offset).toEqual({ from: 660, to: 600 });
  });

  it("keeps the first pass's row count, which is what was actually removed", () => {
    expect(merged.span?.rows).toBe(1416);
  });

  it("accumulates the days rather than taking the last pass's", () => {
    expect(merged.agg1dDays).toBe(360);
  });

  it("takes nextDay and dryRun from the LAST pass — those are genuinely its own", () => {
    expect(merged.nextDay).toBeNull();
    expect(merged.dryRun).toBe(false);
  });

  it("renders a report that shows the work, not a no-op", () => {
    // The regression in one assertion: before the fix this read "deleted 0" and "+600m → +600m".
    const out = renderChangeOffset(merged, 2);
    expect(out).toMatch(/deleted      1416 agg_1d row\(s\)/);
    expect(out).toMatch(/\+660m → \+600m/);
    expect(out).toMatch(/360 of 360 day\(s\), over 2 passes/);
  });

  it("is a no-op for a single pass", () => {
    expect(mergeChangeOffsetPasses(pass1, pass1, pass1.agg1dDays)).toEqual(
      pass1,
    );
  });
});

/**
 * `--include-inactive`, and the `--status` bug it exists to close.
 *
 * 🛑 `device list --status=archived` returned ZERO, always, while its own help advertised
 * `archived` and `disabled` as valid values: the filter runs client-side over whatever the server
 * returned, and the server returns only `active` unless asked otherwise. So two of the three
 * documented values could only ever answer "nothing". Found by running it on prod after archiving
 * three devices and getting an empty list back.
 *
 * The flag is named `includeInactive`, NOT `includeArchived` like the areas twin, because
 * `devices.status` is `active | disabled | archived` — a flag called `include-archived` that also
 * returned `disabled` devices would be wrong in the widening direction.
 */
describe("device --include-inactive", () => {
  it("is offered on the read verbs that address a device by ref", () => {
    for (const verb of ["list", "show"] as const) {
      const spec = deviceCommand.subcommands?.[verb];
      expect(Object.keys(spec?.flags ?? {})).toContain("includeInactive");
    }
  });

  it("parses as a boolean, defaulting to off", () => {
    expect(success(["show", "4"]).flags.includeInactive).toBe(false);
    expect(
      success(["show", "4", "--include-inactive"]).flags.includeInactive,
    ).toBe(true);
  });

  /**
   * 🛑 The name is load-bearing. If someone "harmonises" it to `--include-archived` to match the
   * area verbs, it starts describing a set it does not return.
   */
  it("is NOT called --include-archived — devices have three statuses, areas have two", () => {
    expect(failure(["show", "4", "--include-archived"])).toMatch(
      /include-archived/,
    );
  });

  it("--status still advertises the values it can now actually return", () => {
    const help = String(
      (
        deviceCommand.subcommands?.list?.flags as Record<
          string,
          { help: string }
        >
      )?.status?.help ?? "",
    );
    expect(help).toContain("archived");
    expect(help).not.toContain("removed");
    // and it says it widens, so the coupling is discoverable from --help alone
    expect(help).toMatch(/include-inactive/);
  });
});
