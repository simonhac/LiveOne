/**
 * The dashboard CLI flag parser. Mutual exclusion, unknown-flag rejection and arity are exactly
 * the kind of plumbing that regresses silently, so they are pinned here (jest's roots include
 * `scripts/`, so this file IS collected).
 */
import { describe, it, expect } from "@jest/globals";
import {
  atMostOneOf,
  bool,
  intFlag,
  parseCommandArgs,
  str,
  UsageError,
  type CommandSpec,
} from "../args";

const SPEC: CommandSpec = {
  minPositionals: 1,
  maxPositionals: 2,
  booleans: ["apply"],
  strings: ["type", "index"],
  usage: "dashboard test <a> [<b>] [--type=<t>] [--index=<k>] [--apply]",
};

describe("parseCommandArgs", () => {
  it("splits positionals from flags and reads values", () => {
    const parsed = parseCommandArgs(
      ["db_x", "n_1", "--type=chart", "--apply"],
      SPEC,
    );
    expect(parsed.positionals).toEqual(["db_x", "n_1"]);
    expect(str(parsed, "type")).toBe("chart");
    expect(bool(parsed, "apply")).toBe(true);
    expect(str(parsed, "index")).toBeUndefined();
    expect(bool(parsed, "help")).toBe(false);
  });

  it("keeps '=' inside a flag value intact", () => {
    const parsed = parseCommandArgs(["x", '--type={"a":"b=c"}'], SPEC);
    expect(str(parsed, "type")).toBe('{"a":"b=c"}');
  });

  it("rejects unknown flags, valued booleans, and bare string flags", () => {
    expect(() => parseCommandArgs(["x", "--aply"], SPEC)).toThrow(UsageError);
    expect(() => parseCommandArgs(["x", "--apply=yes"], SPEC)).toThrow(
      /--apply takes no value/,
    );
    expect(() => parseCommandArgs(["x", "--type"], SPEC)).toThrow(
      /--type needs a value/,
    );
  });

  it("enforces positional arity", () => {
    expect(() => parseCommandArgs([], SPEC)).toThrow(UsageError);
    expect(() => parseCommandArgs(["a", "b", "c"], SPEC)).toThrow(UsageError);
  });

  it("accepts --help/-h anywhere and skips the arity check", () => {
    expect(bool(parseCommandArgs(["--help"], SPEC), "help")).toBe(true);
    expect(bool(parseCommandArgs(["-h"], SPEC), "help")).toBe(true);
  });
});

describe("atMostOneOf", () => {
  it("passes with zero or one present and throws on two", () => {
    const one = parseCommandArgs(["x", "--type=chart"], SPEC);
    expect(() => atMostOneOf(one, ["type", "index"])).not.toThrow();
    const two = parseCommandArgs(["x", "--type=chart", "--index=1"], SPEC);
    expect(() => atMostOneOf(two, ["type", "index"])).toThrow(
      /--type and --index are mutually exclusive/,
    );
  });
});

describe("intFlag", () => {
  it("parses within bounds and rejects outside/garbage", () => {
    expect(
      intFlag(parseCommandArgs(["x", "--index=3"], SPEC), "index", 0, 12),
    ).toBe(3);
    expect(
      intFlag(parseCommandArgs(["x"], SPEC), "index", 0, 12),
    ).toBeUndefined();
    expect(() =>
      intFlag(parseCommandArgs(["x", "--index=13"], SPEC), "index", 0, 12),
    ).toThrow(UsageError);
    expect(() =>
      intFlag(parseCommandArgs(["x", "--index=1.5"], SPEC), "index", 0, 12),
    ).toThrow(UsageError);
    expect(() =>
      intFlag(parseCommandArgs(["x", "--index=abc"], SPEC), "index", 0, 12),
    ).toThrow(UsageError);
  });
});
