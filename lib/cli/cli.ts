/**
 * cli.ts — the one argument parser, output contract and error shape for every LiveOne operator CLI.
 *
 * PORTED from nanti's `src/lib/cli.ts` (same author, ~227 commands in production). Kept close to the
 * original on purpose: the value is in the hard-won behaviours below, and a gratuitous rewrite would
 * lose them. Divergences from the source are marked `LiveOne:` so drift stays visible.
 *
 * The consumer of these tools is usually an agent, not a person at a terminal, so this implements
 * clig.dev as a baseline extended for LLM readers. The rules it enforces, and why each exists (every
 * one is a bug that actually happened over there):
 *
 *   - A flag's value can never be read as a positional, because the parser knows each flag's arity.
 *     `quick-search "q" --max 20` used to search the mailbox named "20".
 *   - An unknown flag is refused, never ignored. A tool that silently discards `--help` runs its
 *     real, often mutating, action instead of explaining itself — that one started a two-hour Gmail
 *     sync during an audit.
 *   - Data goes to stdout via `emit()`; everything else to stderr via `note()`/`warn()`. One stray
 *     log line on stdout invalidates an agent's parse. This binds libraries too: a library has no
 *     idea whose stdout it is borrowing.
 *   - Mutating tools are dry by default. `--apply` writes, and off a TTY it also needs `--yes` —
 *     refusing is correct where prompting would be a hang that consumes the agent's whole budget.
 *   - An uncaught throw maps to a distinct exit code. `main().catch(console.error)` printed a stack
 *     trace and exited 0, so a crash looked like a clean run.
 *   - stdout is flushed before every exit path. `process.exit()` discards undrained pipe writes,
 *     silently truncating output at the pipe buffer (~128KB) mid-object.
 *
 * `parse()` and `renderHelp()` are pure — argv and TTY state are passed in — so the contract is
 * testable without a process or a terminal.
 */

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Area, Dashboard, Device } from "@/lib/ids";

// ── exit vocabulary ──────────────────────────────────────────────────────────

/**
 * One meaning per code, across every tool. The alternative — which nanti measured across 53 files —
 * is `exit(1)` standing for "usage error", "findings present" and "crashed" indiscriminately.
 *
 * LiveOne: nanti's `BUDGET: 4` (AI spend cap) has no analogue here. 4 is RESERVED rather than
 * reused, so the two vocabularies can never disagree about what a 4 means.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Ran fine; the answer is non-empty findings or an expected negative result. */
  FINDINGS: 1,
  /** The command line was wrong. Nothing was attempted. */
  USAGE: 2,
  /** Credentials missing, expired or revoked. */
  AUTH: 3,
  /** An upstream dependency (Postgres, the LiveOne API, Clerk) failed. */
  UPSTREAM: 5,
  /** Interrupted (SIGINT). */
  INTERRUPTED: 130,
} as const;

const EXIT_HELP: Record<number, string> = {
  0: "success",
  1: "completed, with findings or no results",
  2: "usage error",
  3: "authentication failure",
  5: "upstream failure",
  130: "interrupted",
};

/**
 * What a tool reaches for, and therefore which failures it can actually have.
 *
 * LiveOne: these are SYSTEMS, not OAuth scopes (nanti's capabilities are Google scopes because every
 * tool there is a Gmail tool). Declared, not inferred — a tool that never talks to Clerk must not
 * report an auth failure, and must not read the word "unauthorized" in an unrelated error as one.
 *
 *   db     — connects directly to Postgres (a `MIGRATE_DATABASE_URL`-style connection string)
 *   api    — calls the deployed LiveOne API as the signed-in user (needs a CLI token)
 *   clerk  — calls the Clerk backend API
 *
 * 🛑 Declarative only for now. nanti pairs this with a RUNTIME gate that throws at the call site
 * before a credential is read, plus a static import-graph check — both directions, because a false
 * statement in `--help` is worse than no statement. Neither is wired up here yet; until they are,
 * `uses` documents intent and drives exit codes but cannot be trusted to be exhaustive.
 */
export type Capability = "db" | "api" | "clerk";

/** Capabilities that involve a credential, and so can fail with EXIT.AUTH. */
const AUTHED: ReadonlySet<Capability> = new Set<Capability>(["api", "clerk"]);

/**
 * LiveOne: `human | json` today. `gcf` (Graph Compact Format — the same data with 30–50% fewer
 * tokens, and nanti's default off a terminal) is a deliberate follow-up: it is one dependency
 * (`@blackwell-systems/gcf`) and one branch in `serialise()`. Adding a value here is additive.
 */
export type Format = "human" | "json";
export const FORMATS: readonly Format[] = ["human", "json"];

/**
 * Validators for value shapes that recur across these tools, so a date means the same thing
 * everywhere rather than being folklore each tool re-implements.
 */
export const V = {
  /**
   * The one date format these CLIs accept: ISO, YYYY-MM-DD.
   *
   * Deliberately the ONLY one, and deliberately zod rather than a regex: shape is not validity.
   * `/^\d{4}-\d{2}-\d{2}$/` happily accepts 2026-02-31, which is not an error but a DIFFERENT query.
   * Slash forms are ambiguous about day/month order and are refused, never translated.
   */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dates are ISO only")
    .refine((v) => {
      const [y, m, d] = v.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      return (
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === m - 1 &&
        dt.getUTCDate() === d
      );
    }, "not a real date"),

  /** LiveOne: the opaque TypeIDs the config-v4 wire vocabulary uses. */
  dashboardId: z
    .string()
    .refine((s) => Dashboard.is(s), "expected a dashboard id (db_…)"),
  areaId: z.string().refine((s) => Area.is(s), "expected an area id (ar_…)"),
  deviceId: z
    .string()
    .refine((s) => Device.is(s), "expected a device id (dv_…)"),
} as const;

/** The exit codes a given command can actually produce. */
export function reachableExitCodes(spec: CommandSpec): number[] {
  const uses = new Set(spec.uses ?? []);
  const codes: number[] = [EXIT.OK, EXIT.FINDINGS, EXIT.USAGE];
  if ([...uses].some((u) => AUTHED.has(u))) codes.push(EXIT.AUTH);
  if (uses.size > 0) codes.push(EXIT.UPSTREAM);
  codes.push(EXIT.INTERRUPTED);
  for (const c of Object.keys(spec.exitCodes ?? {}).map(Number))
    if (!codes.includes(c)) codes.push(c);
  return [...new Set(codes)].sort((a, b) => a - b);
}

// ── spec types ───────────────────────────────────────────────────────────────

export interface ArgSpec {
  name: string;
  help: string;
  required?: boolean;
  /** Sweeps up all remaining positionals. Only valid on the last arg. */
  variadic?: boolean;
}

export type FlagSpec =
  | { type: "boolean"; help: string; default?: boolean; hidden?: boolean }
  | {
      type: "string";
      help: string;
      default?: string;
      values?: readonly string[];
      required?: boolean;
      repeatable?: boolean;
      placeholder?: string;
      hidden?: boolean;
      /** Validate the value — for where a plausible typo changes behaviour silently. */
      schema?: z.ZodType;
      /** What the constraint means, in words. Shown in --help and in the error. */
      hint?: string;
    }
  | {
      type: "number";
      help: string;
      default?: number;
      required?: boolean;
      placeholder?: string;
      hidden?: boolean;
      /** Validate the parsed number — ranges, integrality. */
      schema?: z.ZodType;
      hint?: string;
    };

export interface CommandSpec {
  /** The name an agent types, e.g. "show". */
  name: string;
  /** One line. Shown at the top of --help and in the generated reference. */
  summary: string;
  /**
   * WHEN to reach for this command, and which sibling to use instead. Distinct from `summary`
   * (what it does) and `description` (how to read the answer).
   *
   * Anthropic's guidance for tool definitions is that TRIGGER CONDITIONS, not capability
   * statements, lift a model's should-call rate. This is the only field written to answer that,
   * and the discovery search weights it highest. Authored, never derived.
   */
  when?: string;
  /**
   * Longer prose for --help: how to read the answer, and the traps. NOT routing — that is `when`.
   * These were one field for a long time over there, and almost nothing got written to answer
   * "is this the right command", which is why they are separate.
   */
  description?: string;
  args?: ArgSpec[];
  flags?: Record<string, FlagSpec>;
  /** Complete, copy-pasteable invocations. At least one is required for a tier-A tool. */
  examples?: string[];
  /** Overrides/extends the default exit-code documentation. */
  exitCodes?: Record<number, string>;
  /** External systems this tool reaches. Governs documented exit codes and `classify()`. */
  uses?: readonly Capability[];
  /**
   * True if the tool writes anything. Adds --apply / --dry-run / --yes, and makes NOT writing the
   * default. Declared per subcommand, so a read-only sibling does not inherit a write gate.
   *
   * 🛑 Declaring the gate is not honouring it: read `ctx.dryRun` and branch. Two nanti tools gated
   * only the confirmation prompt, so a dry run listed what it would do and then did it.
   */
  mutates?: boolean;
  /**
   * Named subcommands, each a full command in its own right — each carries its own flags, examples
   * and exit codes rather than being a bare string the parent switches on.
   *
   * A subcommand inherits the parent's `uses` unless it declares its own.
   */
  subcommands?: Record<string, CommandSpec>;
}

export interface CliError {
  code: number;
  /** The offending input, quoted verbatim. */
  what: string;
  /** The constraint that was violated. */
  why: string;
  /** What to do instead: valid values, the right spelling, the missing flag. */
  next: string;
}

export interface Tty {
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
}

export type ParseResult =
  | {
      ok: true;
      help: boolean;
      flags: Record<string, unknown>;
      args: string[];
      format: Format;
      dryRun: boolean;
      color: boolean;
      quiet: boolean;
      /**
       * The subcommand path that ran, root-first — e.g. `["dashboard", "show"]`.
       *
       * An ARRAY rather than a name: nesting is arbitrarily deep, and the previous single field
       * was overwritten by each outer level on the way back up, so a three-level invocation
       * (`liveone dashboard show`) silently reported only "dashboard" and the leaf was lost.
       */
      subcommandPath: string[];
    }
  | { ok: false; error: CliError };

/** Identity, but it pins the type so editors complete flag names at the call site. */
export function defineCommand<const T extends CommandSpec>(spec: T): T {
  return spec;
}

// ── flag naming ──────────────────────────────────────────────────────────────

export const kebab = (s: string) =>
  s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Flags every command gets for free. A tool that declares one of these names itself wins — the
 * globals are defaults, not reservations.
 */
function globalFlags(spec: CommandSpec): Record<string, FlagSpec> {
  const g: Record<string, FlagSpec> = {
    format: {
      type: "string",
      values: FORMATS,
      help: "Output format (default: human on a terminal, json otherwise)",
    },
    json: { type: "boolean", help: "Alias for --format json", hidden: true },
    quiet: { type: "boolean", help: "Suppress non-essential output on stderr" },
    color: {
      type: "boolean",
      help: "Colourise human output (default: on a terminal)",
    },
    help: { type: "boolean", help: "Show this help and exit" },
  };
  if (spec.mutates) {
    g.apply = {
      type: "boolean",
      help: "Actually write. Without it nothing is changed.",
    };
    g.dryRun = {
      type: "boolean",
      help: "Report what would change and write nothing (the default)",
    };
    g.yes = {
      type: "boolean",
      help: "Skip the confirmation prompt. Required with --apply off a terminal.",
    };
  }
  return g;
}

function allFlags(spec: CommandSpec): Record<string, FlagSpec> {
  return { ...globalFlags(spec), ...(spec.flags ?? {}) };
}

// ── suggestions ──────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return m[a.length][b.length];
}

/** The nearest candidate, if one is close enough to be worth offering. */
function nearest(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best !== null && bestD <= Math.max(2, Math.floor(input.length / 3))
    ? best
    : null;
}

// ── parse ────────────────────────────────────────────────────────────────────

/**
 * Lead with why THIS value failed, then the canonical form. A value can satisfy the shape and still
 * be wrong, so an error that only restates the format points the caller at the wrong thing.
 */
function explain(reason: string | undefined, hint: string | undefined): string {
  const parts = [reason, hint ? `expected ${hint}` : null].filter(
    Boolean,
  ) as string[];
  return parts.length ? parts.join("; ") : "see --help";
}

/** Flags validated by V.date always name the accepted format in the error. */
const DATE_HINT = "YYYY-MM-DD, e.g. 2026-08-01";

const fail = (
  code: number,
  what: string,
  why: string,
  next: string,
): ParseResult => ({ ok: false, error: { code, what, why, next } });

/**
 * Pure argument parser. Accepts `--flag value`, `--flag=value`, `--no-<bool>`, `-h`, and `--` as
 * the positional terminator.
 */
export function parse(
  spec: CommandSpec,
  argv: string[],
  tty: Tty,
  /**
   * Names of the commands ABOVE `spec`, root-first. Used only to build error messages that name a
   * command the caller can actually run: the recursion descends into a subcommand's own spec, so
   * without this a failure inside `liveone dashboard` recommended `dashboard --help` — a command
   * that does not exist, since only the root has an entrypoint.
   */
  ancestors: string[] = [],
): ParseResult {
  const invocation = [...ancestors, spec.name].join(" ");
  // Subcommand dispatch happens before anything else: `dashboard show --node x` is a request to
  // parse `show`, and the parent's flag table has nothing to say about --node. A sibling's flag
  // must not quietly succeed here.
  if (spec.subcommands) {
    const names = Object.keys(spec.subcommands);
    const first = argv[0];

    if (first !== undefined && !first.startsWith("-")) {
      const sub = spec.subcommands[first];
      if (!sub) {
        const near = nearest(first, names);
        return fail(
          EXIT.USAGE,
          `unknown subcommand "${first}"`,
          `${invocation} has no subcommand "${first}"`,
          near
            ? `did you mean "${near}"? Subcommands: ${names.join(", ")}`
            : `subcommands: ${names.join(", ")}`,
        );
      }
      // Inherit the parent's declared access unless the subcommand states its own.
      const effective = sub.uses ? sub : { ...sub, uses: spec.uses };
      const r = parse(effective, argv.slice(1), tty, [...ancestors, spec.name]);
      return r.ok ? { ...r, subcommandPath: [first, ...r.subcommandPath] } : r;
    }

    if (argv.includes("--help") || argv.includes("-h"))
      return {
        ok: true,
        help: true,
        flags: {},
        args: [],
        format: tty.stdoutIsTTY ? "human" : "json",
        dryRun: true,
        color: tty.stdoutIsTTY,
        quiet: false,
        subcommandPath: [],
      };

    return fail(
      EXIT.USAGE,
      first === undefined ? "no subcommand given" : `"${first}"`,
      `${invocation} requires a subcommand`,
      `subcommands: ${names.join(", ")} — run \`${invocation} --help\` for what each does`,
    );
  }

  const flagSpecs = allFlags(spec);
  const byCli = new Map<string, string>(); // "--dry-run" -> "dryRun"
  for (const key of Object.keys(flagSpecs)) byCli.set(kebab(key), key);
  const knownCli = [...byCli.keys()].map((k) => `--${k}`);

  const values: Record<string, unknown> = {};
  const seen = new Set<string>();
  const positional: string[] = [];

  // Help is answered before any validation: a tool must be able to explain itself when the caller
  // does not yet know how to invoke it correctly.
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      ok: true,
      help: true,
      flags: {},
      args: [],
      format: tty.stdoutIsTTY ? "human" : "json",
      dryRun: true,
      color: tty.stdoutIsTTY,
      quiet: false,
      subcommandPath: [],
    };
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }

    const eq = tok.indexOf("=");
    const rawName = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineValue = eq === -1 ? null : tok.slice(eq + 1);

    // --no-<bool>
    let negated = false;
    let name = rawName;
    if (
      !byCli.has(name) &&
      name.startsWith("no-") &&
      byCli.has(name.slice(3))
    ) {
      negated = true;
      name = name.slice(3);
    }

    const key = byCli.get(name);
    if (!key) {
      const near = nearest(`--${rawName}`, knownCli);
      return fail(
        EXIT.USAGE,
        `unknown flag "${tok}"`,
        `${invocation} does not accept ${tok}`,
        near
          ? `did you mean ${near}? Run \`${invocation} --help\` for all flags.`
          : `valid flags: ${knownCli.sort().join(", ")}`,
      );
    }

    const fs = flagSpecs[key];

    if (fs.type === "boolean") {
      if (inlineValue !== null && !["true", "false"].includes(inlineValue))
        return fail(
          EXIT.USAGE,
          `"${inlineValue}" for --${name}`,
          `--${name} is a boolean and takes no value`,
          `pass --${name} to enable it or --no-${name} to disable it`,
        );
      values[key] = negated
        ? false
        : inlineValue === null
          ? true
          : inlineValue === "true";
      seen.add(key);
      continue;
    }

    if (negated)
      return fail(
        EXIT.USAGE,
        `"${tok}"`,
        `--no- applies to boolean flags only; --${name} takes a value`,
        `pass --${name} <value>`,
      );

    let raw = inlineValue;
    if (raw === null) {
      const next = argv[i + 1];
      // A value that looks like a flag is a MISSING value, not a value — otherwise
      // `--account --body` silently searches the mailbox "--body". Short flags count too, but a
      // number flag must still accept `-5`.
      const looksLikeFlag =
        next !== undefined &&
        (next.startsWith("--") ||
          (next.startsWith("-") && fs.type !== "number" && next.length > 1));
      if (next === undefined || looksLikeFlag)
        return fail(
          EXIT.USAGE,
          `--${name}`,
          `--${name} requires a value but none was given`,
          `pass --${name} <${("placeholder" in fs && fs.placeholder) || fs.type}>`,
        );
      raw = next;
      i++;
    }

    if (fs.type === "number") {
      // LiveOne: canonical decimal only. `Number("")` is 0 and `Number` also accepts "0x5" and
      // " 3 ", so a bare `--index=` (a shell slip) must not silently mean 0. This was a real
      // finding on the first LiveOne CLI.
      if (!/^-?\d+(\.\d+)?$/.test(raw))
        return fail(
          EXIT.USAGE,
          `"${raw}" for --${name}`,
          `--${name} expects a number`,
          `pass a numeric value, e.g. --${name} 20`,
        );
      const n = Number(raw);
      if (fs.schema) {
        const v = fs.schema.safeParse(n);
        if (!v.success)
          return fail(
            EXIT.USAGE,
            `"${raw}" for --${name}`,
            `--${name} is out of range or the wrong kind of number`,
            explain(v.error.issues[0]?.message, fs.hint),
          );
      }
      values[key] = n;
    } else {
      if (fs.values && !fs.values.includes(raw)) {
        const near = nearest(raw, [...fs.values]);
        return fail(
          EXIT.USAGE,
          `unknown value "${raw}" for --${name}`,
          `--${name} accepts only: ${fs.values.join(", ")}`,
          near
            ? `did you mean "${near}"? Valid values: ${fs.values.join(", ")}`
            : `valid values: ${fs.values.join(", ")}`,
        );
      }
      if (fs.schema) {
        const v = fs.schema.safeParse(raw);
        if (!v.success)
          return fail(
            EXIT.USAGE,
            `"${raw}" for --${name}`,
            `--${name} is not valid`,
            explain(
              v.error.issues[0]?.message,
              fs.hint ?? (fs.schema === V.date ? DATE_HINT : undefined),
            ),
          );
      }
      if (fs.repeatable) ((values[key] ??= []) as string[]).push(raw);
      else values[key] = raw;
    }
    seen.add(key);
  }

  // Defaults for everything not supplied.
  for (const [key, fs] of Object.entries(flagSpecs)) {
    if (seen.has(key)) continue;
    if (fs.default !== undefined) values[key] = fs.default;
    else if (fs.type === "boolean") values[key] = false;
    else if (fs.type === "string" && fs.repeatable) values[key] = [];
  }

  // Required flags.
  for (const [key, fs] of Object.entries(flagSpecs)) {
    if ("required" in fs && fs.required && values[key] === undefined)
      return fail(
        EXIT.USAGE,
        `missing --${kebab(key)}`,
        `--${kebab(key)} is required`,
        `pass --${kebab(key)} <${("placeholder" in fs && fs.placeholder) || fs.type}>`,
      );
  }

  // Positionals.
  const argSpecs = spec.args ?? [];
  const args: string[] = [];
  for (let i = 0; i < argSpecs.length; i++) {
    const a = argSpecs[i];
    if (a.variadic) {
      args.push(...positional.slice(i));
      break;
    }
    if (positional[i] !== undefined) args.push(positional[i]);
    else if (a.required)
      return fail(
        EXIT.USAGE,
        `missing <${a.name}>`,
        `${a.name} is required`,
        `run \`${invocation} --help\` for the argument order`,
      );
  }
  const last = argSpecs[argSpecs.length - 1];
  if (!last?.variadic && positional.length > argSpecs.length)
    return fail(
      EXIT.USAGE,
      `unexpected argument "${positional[argSpecs.length]}"`,
      `${invocation} takes ${argSpecs.length} positional argument(s)`,
      `quote the whole value if it contains spaces, or run \`${invocation} --help\``,
    );

  // Format precedence: --format, then the --json alias, then LIVEONE_FORMAT, then TTY detection.
  // The env var exists because a pipe is ambiguous — it could be `| jq` in a shell script or an
  // agent reading the payload, and the tool cannot tell. Rather than guess, the caller declares
  // its preference once. A bad value fails loudly; it never falls back silently.
  let format: Format;
  const envFormat = process.env.LIVEONE_FORMAT?.trim();
  if (envFormat && !FORMATS.includes(envFormat as Format))
    return fail(
      EXIT.USAGE,
      `LIVEONE_FORMAT="${envFormat}"`,
      "LIVEONE_FORMAT is not one of the supported formats",
      `set it to one of: ${FORMATS.join(", ")} — or unset it to use the default`,
    );

  if (values.format) format = values.format as Format;
  else if (values.json) format = "json";
  else if (envFormat) format = envFormat as Format;
  else format = tty.stdoutIsTTY ? "human" : "json";
  values.format = format;

  // Write gate.
  let dryRun = true;
  if (spec.mutates) {
    if (values.apply && values.dryRun)
      return fail(
        EXIT.USAGE,
        "--apply --dry-run",
        "--apply and --dry-run are contradictory",
        "pass --apply to write, or neither to preview",
      );
    dryRun = !values.apply;
    // Refusing beats prompting: an interactive prompt with no terminal attached blocks until the
    // caller's time budget is gone.
    if (values.apply && !values.yes && !tty.stdinIsTTY)
      return fail(
        EXIT.USAGE,
        "--apply without --yes",
        `${invocation} will not write without confirmation, and stdin is not a terminal so it cannot ask`,
        `pass --yes to confirm non-interactively, or drop --apply to preview the change`,
      );
  }

  // Only supply the TTY-derived default when `color` is ours. A tool that declares its own
  // --color owns its default too.
  if (!("color" in (spec.flags ?? {})) && !seen.has("color"))
    values.color = tty.stdoutIsTTY && !process.env.NO_COLOR;
  const color = !!values.color;

  return {
    ok: true,
    help: false,
    flags: values,
    args,
    format,
    dryRun,
    color,
    quiet: !!values.quiet,
    subcommandPath: [],
  };
}

// ── help ─────────────────────────────────────────────────────────────────────

/**
 * `--help` is frequently an agent's only specification, so this documents every flag, its default,
 * the format values and the exit codes — not just a usage line.
 */
export function renderHelp(
  spec: CommandSpec,
  ancestors: CommandSpec[] = [],
): string {
  // A subcommand inherits declared access from its NEAREST ancestor that states any, the same way
  // parse() does — walking the chain rather than looking at one parent, so a three-level tree does
  // not lose the middle level's declaration to the root's silence.
  if (!spec.uses)
    for (let i = ancestors.length - 1; i >= 0; i--)
      if (ancestors[i].uses) {
        spec = { ...spec, uses: ancestors[i].uses };
        break;
      }
  const flagSpecs = allFlags(spec);
  const out: string[] = [];

  out.push(spec.summary, "");
  // `when` sits directly under the summary, because a reader deciding whether this is the right
  // command has to answer that before anything else is worth reading. `description` follows: it is
  // about the answer, not the choice.
  if (spec.when)
    out.push("When to use:", ...spec.when.split("\n").map((l) => `  ${l}`), "");
  if (spec.description) out.push(spec.description, "");

  const argSig = (spec.args ?? [])
    .map(
      (a) =>
        (a.required ? `<${a.name}>` : `[${a.name}]`) +
        (a.variadic ? "..." : ""),
    )
    .join(" ");
  const invocation = [...ancestors.map((a) => a.name), spec.name].join(" ");
  out.push(
    "Usage:",
    spec.subcommands
      ? `  ${invocation} <subcommand> [options]`
      : `  ${invocation}${argSig ? " " + argSig : ""} [options]`,
    "",
  );
  out.push(
    spec.mutates
      ? "  This command WRITES. It is dry by default: nothing changes without --apply."
      : "  Read-only. This command changes nothing.",
  );
  out.push("");

  if (spec.subcommands) {
    out.push("Subcommands:");
    for (const [name, sub] of Object.entries(spec.subcommands))
      out.push(
        `  ${name.padEnd(22)} ${sub.summary}${sub.mutates ? "  (writes)" : ""}`,
      );
    out.push(
      "",
      `Run \`${invocation} <subcommand> --help\` for a subcommand's own options.`,
      "",
    );
  }

  if (spec.args?.length) {
    out.push("Arguments:");
    for (const a of spec.args)
      out.push(
        `  ${(a.required ? `<${a.name}>` : `[${a.name}]`).padEnd(22)} ${a.help}`,
      );
    out.push("");
  }

  const render = (keys: string[]) =>
    keys.map((key) => {
      const fs = flagSpecs[key];
      const ph =
        fs.type === "boolean"
          ? ""
          : ` <${("placeholder" in fs && fs.placeholder) || fs.type}>`;
      const bits: string[] = [];
      if ("values" in fs && fs.values)
        bits.push(`one of: ${fs.values.join(", ")}`);
      if (fs.default !== undefined) bits.push(`default: ${fs.default}`);
      if ("hint" in fs && fs.hint) bits.push(fs.hint);
      if ("repeatable" in fs && fs.repeatable) bits.push("repeatable");
      if ("required" in fs && fs.required) bits.push("required");
      const tail = bits.length ? `  (${bits.join("; ")})` : "";
      return `  --${(kebab(key) + ph).padEnd(24)} ${fs.help}${tail}`;
    });

  const own = Object.keys(spec.flags ?? {}).filter((k) => !flagSpecs[k].hidden);
  if (own.length) out.push("Options:", ...render(own), "");

  const common = Object.keys(globalFlags(spec)).filter(
    (k) => !flagSpecs[k].hidden && !(k in (spec.flags ?? {})),
  );
  out.push("Common options:", ...render(common), "");

  out.push(
    "Output:",
    `  --format human   aligned text — the default at a terminal`,
    `  --format json    JSON on stdout — the default when stdout is not a terminal`,
    `  Data goes to stdout; all diagnostics go to stderr.`,
    "",
  );

  // Stated outright rather than left to be inferred from the exit codes. A caller deciding whether
  // a run will touch the production database should not have to reason about what the absence of
  // exit 3 implies.
  const uses = new Set(spec.uses ?? []);
  out.push("External access:");
  if (uses.has("db"))
    out.push(
      "  Database  Connects DIRECTLY to Postgres using the connection string in the environment.",
      "            Read the printed `target:` line before writing — it names the database, the",
      "            role and the host. A connection or query failure is exit 5.",
    );
  if (uses.has("api"))
    out.push(
      "  API       Calls the deployed LiveOne API as the signed-in user, with a stored CLI token.",
      "            A missing, expired or revoked token is exit 3; an API failure is exit 5.",
    );
  if (uses.has("clerk"))
    out.push(
      "  Clerk     Calls the Clerk backend API. An auth failure is exit 3.",
    );
  if (uses.size === 0)
    out.push(
      "  None. This command is pure — it reaches no database, API or credential.",
    );
  out.push("");

  if (spec.examples?.length) {
    out.push("Examples:");
    for (const e of spec.examples) out.push(`  ${e}`);
    out.push("");
  }

  const all = { ...EXIT_HELP, ...spec.exitCodes };
  out.push("Exit codes:");
  for (const code of reachableExitCodes(spec))
    out.push(`  ${String(code).padEnd(4)} ${all[code] ?? "(undocumented)"}`);

  return out.join("\n");
}

// ── output ───────────────────────────────────────────────────────────────────

let activeFormat: Format = "json";
let activeQuiet = false;

/**
 * One data model, two serialisers — so the human and JSON renderings of a command cannot drift into
 * reporting different things. (nanti measured exactly that: `naming-lint --json` serialised only
 * part of the model and exited on its length, so the same command gave two different verdicts
 * depending on the output flag.) Pure, so parity is testable.
 *
 * LiveOne: the `gcf` branch goes here when the dependency lands.
 */
export function serialise(
  model: unknown,
  format: Format,
  human: (m: never) => string,
): string {
  // Each format ends in exactly one newline: JSON.stringify supplies none, and a human renderer
  // may do either.
  if (format === "json") return JSON.stringify(model, null, 2) + "\n";
  return (human as (m: unknown) => string)(model).replace(/\n*$/, "\n");
}

/**
 * Writes still in flight. When stdout is a pipe, `write()` is asynchronous and `process.exit()`
 * discards whatever has not drained — silently truncating any payload over the pipe buffer
 * (64–128KB). A JSON document cut mid-object is exactly the corruption the stream rules exist to
 * prevent, so run() waits for these. Measured over there at exactly 131,072 bytes.
 */
const pendingWrites: Promise<void>[] = [];

function writeStdout(s: string): void {
  pendingWrites.push(
    new Promise<void>((resolve) => {
      if (process.stdout.write(s)) resolve();
      else process.stdout.once("drain", () => resolve());
    }),
  );
}

/** Resolves once everything written to stdout has actually been flushed. */
export async function flushStdout(): Promise<void> {
  while (pendingWrites.length) await pendingWrites.shift();
}

/** The only path from a tool to stdout. */
export function emit(model: unknown, human: (m: never) => string): void {
  writeStdout(serialise(model, activeFormat, human));
}

/** Progress and commentary. stderr, and silent under --quiet. */
export function note(msg: string): void {
  if (!activeQuiet) process.stderr.write(msg + "\n");
}

/** A warning that is not fatal. Always stderr, never suppressed. */
export function warn(msg: string): void {
  process.stderr.write(msg + "\n");
}

/**
 * Ask before doing something destructive — but only when there is someone to ask. Off a terminal
 * this never blocks: parse() has already refused `--apply` without `--yes`, so reaching here
 * without a TTY means the caller passed `--yes`.
 */
export async function confirm(
  question: string,
  yes: boolean,
): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${question} (y/N) `, resolve),
  );
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

/** Throw this to exit with a specific code and an actionable message. */
export class CliFailure extends Error {
  constructor(readonly detail: CliError) {
    super(detail.why);
    this.name = "CliFailure";
  }
}

export const failWith = (
  code: number,
  what: string,
  why: string,
  next: string,
) => new CliFailure({ code, what, why, next });

function renderError(e: CliError): string {
  return [`error: ${e.what}`, `  ${e.why}`, `  → ${e.next}`].join("\n");
}

// ── run ──────────────────────────────────────────────────────────────────────

export interface Ctx {
  flags: Record<string, unknown>;
  args: string[];
  /** The subcommand path that ran, root-first — e.g. `["dashboard", "show"]`. */
  subcommandPath: string[];
  /** The leaf subcommand, for the common single-level case. */
  subcommand?: string;
  format: Format;
  dryRun: boolean;
  quiet: boolean;
  emit: (model: unknown, human: (m: never) => string) => void;
  note: (msg: string) => void;
  warn: (msg: string) => void;
  /** Prompt at a terminal; returns immediately when --yes was passed. */
  confirm: (question: string) => Promise<boolean>;
}

/**
 * True when `importMetaUrl`'s module is the file node was asked to execute.
 *
 * Both sides go through realpathSync, because they disagree otherwise: on macOS /tmp and /var are
 * symlinks, so `process.argv[1]` can read /var/folders/… while `import.meta.url` reads
 * /private/var/folders/… — the same file, two strings. Comparing them literally makes run() no-op,
 * and a tool that silently produces nothing is the worst possible failure here.
 */
export function isEntrypoint(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  try {
    return real(process.argv[1]) === real(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/**
 * Wraps a tool's main so that an uncaught throw becomes a documented exit code rather than a stack
 * trace and a misleading exit 0.
 *
 * `entrypoint` is always `import.meta.url`, and it is REQUIRED rather than optional: tools export
 * their engine for other tools (and the doc generator) to import, and `run()` executes at module
 * load. Without this check, importing a tool would silently run its CLI — which is how nanti's
 * reference generator started a real inbox scan on its first run.
 */
export async function run(
  spec: CommandSpec,
  main: (ctx: Ctx) => Promise<number | void>,
  entrypoint: string,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (!isEntrypoint(entrypoint)) return;

  const tty = {
    stdoutIsTTY: !!process.stdout.isTTY,
    stdinIsTTY: !!process.stdin.isTTY,
  };
  const r = parse(spec, argv, tty);

  if (!r.ok) {
    process.stderr.write(renderError(r.error) + "\n");
    process.exit(r.error.code);
  }
  if (r.help) {
    // Walk the path so `liveone dashboard show --help` documents the leaf, with the whole
    // invocation on its usage line.
    const ancestors: CommandSpec[] = [];
    let target: CommandSpec = spec;
    for (const name of r.subcommandPath) {
      const next = target.subcommands?.[name];
      if (!next) break;
      ancestors.push(target);
      target = next;
    }
    writeStdout(renderHelp(target, ancestors) + "\n");
    await flushStdout();
    process.exit(EXIT.OK);
  }

  activeFormat = r.format;
  activeQuiet = r.quiet;

  process.on("SIGINT", () => process.exit(EXIT.INTERRUPTED));

  try {
    const code = await main({
      flags: r.flags,
      args: r.args,
      subcommandPath: r.subcommandPath,
      subcommand: r.subcommandPath[r.subcommandPath.length - 1],
      format: r.format,
      dryRun: r.dryRun,
      quiet: r.quiet,
      emit,
      note,
      warn,
      confirm: (q: string) => confirm(q, !!r.flags.yes),
    });
    await flushStdout();
    process.exit(code ?? EXIT.OK);
  } catch (e) {
    await flushStdout();
    if (e instanceof CliFailure) {
      process.stderr.write(renderError(e.detail) + "\n");
      process.exit(e.detail.code);
    }
    const c = classify(e, spec);
    process.stderr.write(renderError(c) + "\n");
    if (process.env.LIVEONE_DEBUG)
      process.stderr.write(String((e as Error)?.stack ?? e) + "\n");
    process.exit(c.code);
  }
}

/** Map a thrown error onto the exit vocabulary, with a next step where we know one. */
export function classify(e: unknown, spec: CommandSpec): CliError {
  const msg = String((e as Error)?.message ?? e);
  const uses = new Set(spec.uses ?? []);
  const authed = [...uses].some((u) => AUTHED.has(u));

  // Gated on the declaration, for the same reason nanti gates its budget check: "unauthorized" is
  // an ordinary word, and a database tool throwing it about a Postgres role must not send the
  // agent off to re-authenticate a Clerk session it never used.
  if (
    authed &&
    /invalid[_ ]grant|unauthorized|unauthenticated|\b401\b|token (expired|revoked)/i.test(
      msg,
    )
  )
    return {
      code: EXIT.AUTH,
      what: msg,
      why: "the stored credential is missing, expired or revoked",
      next: uses.has("api")
        ? "re-authenticate the CLI, then retry"
        : "refresh the Clerk credential, then retry",
    };

  if (
    /\b(429|403|5\d\d)\b|quota|rate limit|ECONN|ETIMEDOUT|ENOTFOUND|connection terminated/i.test(
      msg,
    )
  )
    return {
      code: EXIT.UPSTREAM,
      what: msg,
      why: "an upstream call failed",
      next: "retry with a smaller window; if it persists the dependency is degraded, not the input",
    };

  return {
    code: EXIT.UPSTREAM,
    what: msg,
    why: `${spec.name} failed`,
    next: "re-run with LIVEONE_DEBUG=1 for the stack trace",
  };
}
