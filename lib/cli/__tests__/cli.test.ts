/**
 * The CLI harness contract. `parse()` and `renderHelp()` are pure — argv and TTY state are passed
 * in — so every rule is testable without a process or a terminal, which is the whole reason they
 * take those as arguments.
 *
 * Each block names the failure it prevents. These are not hypotheticals: every one is a bug that
 * happened in the tree this was ported from, or (the number-parsing one) in the first LiveOne CLI.
 */
import { describe, it, expect } from "@jest/globals";
import {
  defineCommand,
  parse,
  renderHelp,
  serialise,
  reachableExitCodes,
  isEntrypoint,
  classify,
  failWith,
  CliFailure,
  EXIT,
  kebab,
  V,
  type CommandSpec,
  type Tty,
} from "../cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const PIPE: Tty = { stdoutIsTTY: false, stdinIsTTY: false };

const simple = defineCommand({
  name: "demo",
  summary: "A demo command.",
  args: [{ name: "query", required: true, help: "What to look for" }],
  flags: {
    limit: { type: "number", default: 10, help: "Max results" },
    account: {
      type: "string",
      values: ["home", "work"],
      help: "Which account",
    },
    body: { type: "boolean", help: "Include the body" },
    tag: { type: "string", repeatable: true, help: "Repeatable tag" },
    allowUnknownType: { type: "boolean", help: "camelCase declaration" },
  },
  examples: ["demo hello"],
  uses: ["db"],
});

const mutating = defineCommand({
  name: "writer",
  summary: "A mutating command.",
  mutates: true,
  uses: ["db"],
});

/** parse() but assert success, so tests read as assertions about values not unions. */
function ok(spec: CommandSpec, argv: string[], tty: Tty = TTY) {
  const r = parse(spec, argv, tty);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
}
function err(spec: CommandSpec, argv: string[], tty: Tty = TTY) {
  const r = parse(spec, argv, tty);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return r.error;
}

describe("parse — arity", () => {
  it("never reads a flag's value as a positional", () => {
    // The original bug: `quick-search "q" --max 20` searched the mailbox named "20".
    const r = ok(simple, ["hello", "--limit", "20"]);
    expect(r.args).toEqual(["hello"]);
    expect(r.flags.limit).toBe(20);
  });

  it("treats a following flag as a MISSING value, not a value", () => {
    const e = err(simple, ["hello", "--account", "--body"]);
    expect(e.code).toBe(EXIT.USAGE);
    expect(e.why).toMatch(/requires a value/);
  });

  it("still accepts a negative number for a number flag", () => {
    const spec = {
      ...simple,
      flags: { ...simple.flags, limit: { type: "number", help: "n" } },
    } as CommandSpec;
    expect(ok(spec, ["hello", "--limit", "-5"]).flags.limit).toBe(-5);
  });

  it("accepts --flag=value, keeping '=' inside the value", () => {
    const r = ok(simple, ["hello", "--account=work"]);
    expect(r.flags.account).toBe("work");
  });

  it("stops flag parsing at --", () => {
    const r = ok(simple, ["--", "--not-a-flag"]);
    expect(r.args).toEqual(["--not-a-flag"]);
  });
});

describe("parse — refusal", () => {
  it("refuses an unknown flag and suggests the nearest", () => {
    const e = err(simple, ["hello", "--bodyy"]);
    expect(e.code).toBe(EXIT.USAGE);
    expect(e.next).toMatch(/--body/);
  });

  it("refuses an unknown enum value and lists the valid ones", () => {
    const e = err(simple, ["hello", "--account=hme"]);
    expect(e.why).toMatch(/home, work/);
    expect(e.next).toMatch(/did you mean "home"/);
  });

  it("refuses a non-canonical number (Number('') is 0, '0x5' is 5)", () => {
    // The LiveOne finding: a bare `--index=` from a shell slip must not mean index 0.
    for (const bad of ["", "0x5", " 3 ", "abc"]) {
      expect(err(simple, ["hello", `--limit=${bad}`]).why).toMatch(
        /expects a number/,
      );
    }
  });

  it("refuses a missing required positional and an excess one", () => {
    expect(err(simple, []).what).toMatch(/missing <query>/);
    expect(err(simple, ["a", "b"]).what).toMatch(/unexpected argument "b"/);
  });

  it("refuses a value for a boolean flag", () => {
    expect(err(simple, ["hello", "--body=maybe"]).why).toMatch(
      /takes no value/,
    );
  });
});

describe("parse — booleans and defaults", () => {
  it("supports --no-<bool> and fills declared defaults", () => {
    expect(ok(simple, ["hello", "--body"]).flags.body).toBe(true);
    expect(ok(simple, ["hello", "--no-body"]).flags.body).toBe(false);
    expect(ok(simple, ["hello"]).flags.body).toBe(false);
    expect(ok(simple, ["hello"]).flags.limit).toBe(10);
  });

  it("collects a repeatable flag into an array, defaulting to []", () => {
    expect(ok(simple, ["hello", "--tag=a", "--tag=b"]).flags.tag).toEqual([
      "a",
      "b",
    ]);
    expect(ok(simple, ["hello"]).flags.tag).toEqual([]);
  });

  it("accepts a camelCase declaration only in its kebab form", () => {
    expect(kebab("allowUnknownType")).toBe("allow-unknown-type");
    expect(
      ok(simple, ["hello", "--allow-unknown-type"]).flags.allowUnknownType,
    ).toBe(true);
    expect(err(simple, ["hello", "--allowUnknownType"]).what).toMatch(
      /unknown flag/,
    );
  });
});

describe("parse — help", () => {
  it("answers --help before any validation", () => {
    // A tool must explain itself when the caller does not yet know how to invoke it — the
    // alternative is the audit incident where --help ran a two-hour sync.
    const r = ok(simple, ["--help"]);
    expect(r.help).toBe(true);
    expect(ok(simple, ["-h"]).help).toBe(true);
  });
});

describe("parse — format precedence", () => {
  const clearEnv = () => delete process.env.LIVEONE_FORMAT;

  it("defaults to human at a terminal and json off one", () => {
    clearEnv();
    expect(ok(simple, ["hello"], TTY).format).toBe("human");
    expect(ok(simple, ["hello"], PIPE).format).toBe("json");
  });

  it("prefers --format over --json over the env var", () => {
    process.env.LIVEONE_FORMAT = "human";
    expect(ok(simple, ["hello"], PIPE).format).toBe("human");
    expect(ok(simple, ["hello", "--json"], PIPE).format).toBe("json");
    expect(ok(simple, ["hello", "--format=human", "--json"], PIPE).format).toBe(
      "human",
    );
    clearEnv();
  });

  it("fails loudly on a bad env value rather than falling back", () => {
    process.env.LIVEONE_FORMAT = "yaml";
    const e = err(simple, ["hello"]);
    expect(e.code).toBe(EXIT.USAGE);
    expect(e.next).toMatch(/human, json/);
    clearEnv();
  });

  it("accepts --format csv only on a command that declares it", () => {
    clearEnv();
    const csvCapable = defineCommand({
      name: "downloader",
      summary: "A csv-capable command.",
      formats: ["human", "json", "csv"],
      uses: ["api"],
    });
    expect(ok(csvCapable, ["--format=csv"], PIPE).format).toBe("csv");
    // The default set stays closed: a non-declaring command rejects csv with the usual enum error.
    const e = err(simple, ["hello", "--format=csv"]);
    expect(e.code).toBe(EXIT.USAGE);
    expect(e.why).toMatch(/human, json/);
    // ...and csv is never a valid session-wide env preference, even for a declaring command.
    process.env.LIVEONE_FORMAT = "csv";
    expect(err(csvCapable, []).code).toBe(EXIT.USAGE);
    clearEnv();
  });
});

describe("parse — the write gate", () => {
  it("is dry by default and writes only with --apply", () => {
    expect(ok(mutating, []).dryRun).toBe(true);
    expect(ok(mutating, ["--apply"]).dryRun).toBe(false);
  });

  it("refuses --apply without --yes off a terminal, rather than prompting", () => {
    // Refusing beats prompting: a prompt with no terminal is a hang that consumes the caller's
    // entire time budget.
    const e = err(mutating, ["--apply"], PIPE);
    expect(e.code).toBe(EXIT.USAGE);
    expect(e.what).toBe("--apply without --yes");
    expect(ok(mutating, ["--apply", "--yes"], PIPE).dryRun).toBe(false);
  });

  it("refuses contradictory --apply --dry-run", () => {
    expect(err(mutating, ["--apply", "--dry-run"]).why).toMatch(
      /contradictory/,
    );
  });

  it("gives a read-only command no write flags at all", () => {
    expect(err(simple, ["hello", "--apply"]).what).toMatch(/unknown flag/);
  });
});

describe("parse — subcommands", () => {
  const parent = defineCommand({
    name: "tool",
    summary: "Parent.",
    uses: ["db"],
    subcommands: {
      list: { name: "list", summary: "List things." },
      add: {
        name: "add",
        summary: "Add a thing.",
        mutates: true,
        uses: ["api"],
      },
    },
  });

  it("dispatches to the subcommand and reports which ran", () => {
    const r = ok(parent, ["list"]);
    expect(r.subcommandPath).toEqual(["list"]);
  });

  it("refuses a missing or unknown subcommand, suggesting the nearest", () => {
    expect(err(parent, []).why).toMatch(/requires a subcommand/);
    expect(err(parent, ["lst"]).next).toMatch(/did you mean "list"/);
  });

  it("applies the write gate per subcommand, not to the family", () => {
    expect(ok(parent, ["add", "--apply"]).dryRun).toBe(false);
    // `list` is read-only, so it has no --apply to accept.
    expect(err(parent, ["list", "--apply"]).what).toMatch(/unknown flag/);
  });

  it("answers --help for the bare parent", () => {
    expect(ok(parent, ["--help"]).help).toBe(true);
  });
});

describe("parse — nested subcommands (three levels)", () => {
  // The shape `liveone dashboard show` needs: a PATH out of parse (the old single field was
  // overwritten by each outer level on the way back up, so the leaf was silently lost), and help
  // that resolves along it.
  const root = defineCommand({
    name: "liveone",
    summary: "Root.",
    uses: ["db"],
    subcommands: {
      dashboard: {
        name: "dashboard",
        summary: "Dashboard things.",
        subcommands: {
          show: { name: "show", summary: "Show one." },
          "set-prop": {
            name: "set-prop",
            summary: "Change one.",
            mutates: true,
          },
        },
      },
    },
  });

  it("reports the whole path, not just the outermost name", () => {
    expect(ok(root, ["dashboard", "show"]).subcommandPath).toEqual([
      "dashboard",
      "show",
    ]);
  });

  it("applies the leaf's own write gate, not the root's", () => {
    expect(ok(root, ["dashboard", "show"]).dryRun).toBe(true);
    expect(ok(root, ["dashboard", "set-prop", "--apply"]).dryRun).toBe(false);
    // `show` is read-only, so it has no --apply to accept even though a sibling does.
    expect(err(root, ["dashboard", "show", "--apply"]).what).toMatch(
      /unknown flag/,
    );
  });

  it("suggests a sibling at the level where the typo happened", () => {
    expect(err(root, ["dashboard", "shwo"]).next).toMatch(
      /did you mean "show"/,
    );
    expect(err(root, ["dashbord"]).next).toMatch(/did you mean "dashboard"/);
  });

  it("renders the full invocation on a leaf's usage line", () => {
    const help = renderHelp(root.subcommands!.dashboard.subcommands!.show, [
      root,
      root.subcommands!.dashboard,
    ]);
    expect(help).toContain("liveone dashboard show");
  });

  it("inherits `uses` from the nearest ancestor that declares it", () => {
    // The middle level declares nothing, so the leaf must still pick up the root's access rather
    // than reporting none.
    const help = renderHelp(root.subcommands!.dashboard.subcommands!.show, [
      root,
      root.subcommands!.dashboard,
    ]);
    expect(help).toMatch(/Database {2}Connects DIRECTLY to Postgres/);
  });
});

describe("reachableExitCodes", () => {
  it("documents only what a command can actually produce", () => {
    const pure = { name: "p", summary: "s" } as CommandSpec;
    expect(reachableExitCodes(pure)).toEqual([0, 1, 2, 130]);
    // db can fail upstream but carries no credential, so no exit 3.
    expect(reachableExitCodes(simple)).toEqual([0, 1, 2, 5, 130]);
    // api is credential-bearing.
    expect(reachableExitCodes({ ...simple, uses: ["api"] })).toEqual([
      0, 1, 2, 3, 5, 130,
    ]);
  });

  it("folds in a command's own documented codes", () => {
    expect(
      reachableExitCodes({ ...simple, exitCodes: { 7: "custom" } }),
    ).toContain(7);
  });
});

describe("renderHelp", () => {
  it("documents flags, defaults, output, access and only reachable exit codes", () => {
    const h = renderHelp(simple);
    expect(h).toContain("--limit <number>");
    expect(h).toContain("default: 10");
    expect(h).toContain("one of: home, work");
    expect(h).toContain("Data goes to stdout; all diagnostics go to stderr.");
    expect(h).toContain("Read-only. This command changes nothing.");
    expect(h).toMatch(/Database {2}Connects DIRECTLY to Postgres/);
    expect(h).not.toContain("authentication failure"); // db carries no credential
  });

  it("says plainly that a mutating command is dry by default", () => {
    expect(renderHelp(mutating)).toContain("dry by default");
  });

  it("lets a subcommand inherit the parent's declared access", () => {
    const parent = { name: "t", summary: "p", uses: ["api"] } as CommandSpec;
    const child = { name: "c", summary: "c" } as CommandSpec;
    expect(renderHelp(child, [parent])).toMatch(
      /API {7}Calls the deployed LiveOne API/,
    );
  });
});

describe("serialise", () => {
  it("renders one data model two ways, each ending in exactly one newline", () => {
    // The failure this prevents: nanti's naming-lint serialised only part of the model in its
    // --json branch, so the same command gave two different verdicts by output flag.
    const model = { count: 2, items: ["a", "b"] };
    const json = serialise(model, "json", () => "unused");
    expect(JSON.parse(json)).toEqual(model);
    expect(json.endsWith("}\n")).toBe(true);
    expect(
      serialise(
        model,
        "human",
        (m: never) => `count=${(m as typeof model).count}\n\n\n`,
      ),
    ).toBe("count=2\n");
  });

  it("uses the csv renderer under csv, and falls back to JSON without one", () => {
    const model = { count: 2, items: ["a", "b"] };
    expect(
      serialise(
        model,
        "csv",
        () => "unused",
        (m: never) => (m as typeof model).items.join(","),
      ),
    ).toBe("a,b\n");
    // A csv-format emit with no csv renderer (a summary or diagnostic model) must stay
    // machine-parseable: JSON, never the human rendering.
    expect(JSON.parse(serialise(model, "csv", () => "unused"))).toEqual(model);
  });
});

describe("classify", () => {
  it("maps an auth failure to exit 3 only for a credential-bearing command", () => {
    const msg = new Error("401 unauthorized");
    expect(classify(msg, { ...simple, uses: ["api"] }).code).toBe(EXIT.AUTH);
    // A database tool saying "unauthorized" about a Postgres role must not send the agent off to
    // re-authenticate something it never used.
    expect(classify(msg, simple).code).toBe(EXIT.UPSTREAM);
  });

  it("maps transport failures to upstream, and anything else to a debuggable upstream", () => {
    expect(classify(new Error("ETIMEDOUT"), simple).code).toBe(EXIT.UPSTREAM);
    expect(classify(new Error("something odd"), simple).next).toMatch(
      /LIVEONE_DEBUG=1/,
    );
  });
});

describe("failWith / isEntrypoint", () => {
  it("carries the four-part error shape", () => {
    const e = failWith(EXIT.USAGE, "what", "why", "next");
    expect(e).toBeInstanceOf(CliFailure);
    expect(e.detail).toEqual({
      code: 2,
      what: "what",
      why: "why",
      next: "next",
    });
  });

  it("is false for a module that is not the executed file", () => {
    // The guard that stops importing a tool from RUNNING it.
    expect(isEntrypoint("file:///definitely/not/the/entrypoint.ts")).toBe(
      false,
    );
  });
});

describe("V", () => {
  it("accepts only real ISO dates", () => {
    expect(V.date.safeParse("2026-08-01").success).toBe(true);
    // Shape is not validity: a regex alone accepts both of these.
    expect(V.date.safeParse("2026-02-31").success).toBe(false);
    expect(V.date.safeParse("2026-13-01").success).toBe(false);
    expect(V.date.safeParse("01/08/2026").success).toBe(false);
  });
});
