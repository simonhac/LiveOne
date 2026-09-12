/**
 * The `device config` flag contract, and the DISPATCH property that makes it safe.
 *
 * 🛑 The dispatch assertions are the point of this file. `runDevice` keyed its handlers on the LAST
 * path element, which was fine while every verb was one segment — and `device config show` shares
 * that last element with `device show`. Dispatching on it would have returned the device aggregate,
 * looked entirely successful, and never touched the config. That is the same collision `runArea`
 * carries its own 🛑 about; this domain simply had nothing to collide with until now.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { deviceCommand } from "../cli";
import { CONFIG_HANDLERS } from "../config";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(deviceCommand, argv, TTY, ["liveone"]);

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
  it.each(["config.show", "config.lint", "config.clean"])(
    "%s is keyed by its full path",
    (key) => {
      expect(Object.keys(CONFIG_HANDLERS)).toContain(key);
    },
  );

  it("does not key a config verb by its last element alone", () => {
    // `show` bare here would collide with `device show` — the exact misroute this file pins.
    for (const bare of ["show", "lint", "clean"])
      expect(Object.keys(CONFIG_HANDLERS)).not.toContain(bare);
  });

  // Paths here are relative to `deviceCommand`, which is what `parse` was handed; under `liveone`
  // they gain the leading "device" that `runDevice` slices back off. What matters is that the two
  // are DIFFERENT and that the nested one keeps its "config" segment — lose that and the lookup
  // collapses to a bare "show".
  it("`device show` and `device config show` are different commands", () => {
    expect(success(["show", "6"]).subcommandPath).toEqual(["show"]);
    expect(success(["config", "show", "6"]).subcommandPath).toEqual([
      "config",
      "show",
    ]);
  });
});

describe("the write gate", () => {
  it("clean is dry by default and offers --apply", () => {
    expect(success(["config", "clean", "6"]).dryRun).toBe(true);
    expect(success(["config", "clean", "6", "--apply"]).dryRun).toBe(false);
  });

  it.each(["show", "lint"])("config %s has no write flags at all", (verb) => {
    expect(failure(["config", verb, "6", "--apply"])).toContain("apply");
  });

  it("--apply off a terminal refuses without --yes", () => {
    const r = parse(
      deviceCommand,
      ["config", "clean", "6", "--apply"],
      { stdoutIsTTY: false, stdinIsTTY: false },
      ["liveone"],
    );
    expect(r.ok).toBe(false);
  });
});

describe("the subject is explicit", () => {
  // `--all` rewrites every device's config. It must never be the thing you get by typing less — the
  // rule `device recompute`'s required window already states for this domain.
  it("lint and clean accept --all", () => {
    expect(success(["config", "lint", "--all"]).flags.all).toBe(true);
    expect(success(["config", "clean", "--all"]).flags.all).toBe(true);
  });

  it("--all is not the default", () => {
    expect(success(["config", "lint", "6"]).flags.all).toBe(false);
  });

  it("show takes a required device and refuses without one", () => {
    expect(failure(["config", "show"])).toBeTruthy();
  });
});
