/**
 * The `area purge` / `area provenance` flag contract, and the DISPATCH property that makes them safe.
 *
 * 🛑 The dispatch assertions are the point of this file. `runArea` used to fall back to the LAST path
 * element when the full-path lookup missed, which was harmless while every multi-segment verb was a
 * wiring one — and became live ammunition the moment `purge flows` existed, because `area purge
 * flows` would have fallen through to the `flows` READ verb and printed a Sankey instead of deleting
 * one. It would not have errored. It would have looked like it worked.
 *
 * `parse()` is importable without a network because the domain module has no entrypoint.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { areaCommand } from "../cli";
import { PURGE_HANDLERS } from "../purge";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(areaCommand, argv, TTY, ["liveone"]);

const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};
const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

describe("dispatch", () => {
  // Every verb these specs can spell must resolve to a handler keyed by its FULL path. A key that is
  // only the last element is the bug this file exists to pin.
  it.each([
    ["provenance", "provenance"],
    ["purge flows", "purge.flows"],
    ["purge provenance", "purge.provenance"],
  ])("`area %s` dispatches on the full path %s", (_verb, key) => {
    expect(Object.keys(PURGE_HANDLERS)).toContain(key);
  });

  it("does not key a purge verb by its last element alone", () => {
    // If `flows` or `provenance` appeared here bare, `area purge flows` could resolve to the read
    // verb (or vice versa) depending on lookup order.
    expect(Object.keys(PURGE_HANDLERS)).not.toContain("flows");
  });

  // Paths here are relative to `areaCommand`; under `liveone` they gain the leading "area" that
  // `runArea` slices back off. What matters is that the two are DIFFERENT and that the purge one
  // keeps its "purge" segment — lose that and it resolves to the read verb.
  it("`area flows` and `area purge flows` are different commands", () => {
    expect(success(["flows", "13"]).subcommandPath).toEqual(["flows"]);
    expect(
      success([
        "purge",
        "flows",
        "13",
        "--start=2026-07-06",
        "--end=2026-09-12",
      ]).subcommandPath,
    ).toEqual(["purge", "flows"]);
  });
});

describe("the write gate", () => {
  it.each([
    [
      "flows",
      ["purge", "flows", "13", "--start=2026-07-06", "--end=2026-09-12"],
    ],
    ["provenance", ["purge", "provenance", "13"]],
  ])("purge %s is dry by default and offers --apply", (_name, args) => {
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it("the provenance READ verb has no write flags at all", () => {
    // A read verb that grew --apply would advertise a gate it does not honour.
    expect(failure(["provenance", "13", "--apply"])).toContain("apply");
  });

  it("--apply off a terminal refuses without --yes", () => {
    const r = parse(
      areaCommand,
      ["purge", "provenance", "13", "--apply"],
      { stdoutIsTTY: false, stdinIsTTY: false },
      ["liveone"],
    );
    expect(r.ok).toBe(false);
  });
});

describe("purge flows has no unscoped form", () => {
  // The window is what separates this verb from `/api/cron/daily`, which reads a missing date as ALL
  // HISTORY. The spec accepts the flags; the handler refuses when they are absent — assert the flags
  // exist and are not somehow defaulted into a full-history sweep.
  it("accepts an explicit window", () => {
    const r = success([
      "purge",
      "flows",
      "13",
      "--start=2026-07-06",
      "--end=2026-09-12",
    ]);
    expect(r.flags.start).toBe("2026-07-06");
    expect(r.flags.end).toBe("2026-09-12");
  });

  it("does not default the window to anything", () => {
    const r = success(["purge", "flows", "13"]);
    expect(r.flags.start).toBeUndefined();
    expect(r.flags.end).toBeUndefined();
  });
});
