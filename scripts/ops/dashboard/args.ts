/**
 * Flag parsing for the dashboard CLI — deliberately tiny and dependency-free (the repo has no
 * commander/yargs, and the house style is `--key=value`).
 *
 * Rules (clig.dev-flavoured):
 *   - long options only, `--flag` (boolean) or `--key=value` (valued); `-h` is the one short alias;
 *   - unknown flags are REJECTED (a typo'd `--aply` must not silently dry-run);
 *   - `--help`/`-h` is accepted by every command;
 *   - usage problems throw {@link UsageError} → exit code 2.
 *
 * The `none` sentinel (delete-this-key) is a per-command convention on top of string flags, not
 * something this parser knows about.
 */

export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CommandSpec {
  /** Positional arity. */
  minPositionals: number;
  maxPositionals: number;
  /** Bare flags (`--apply`). `help` is implied. */
  booleans: readonly string[];
  /** Valued flags (`--type=chart`). */
  strings: readonly string[];
  /** One-line usage string, shown on arity/flag errors. */
  usage: string;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseCommandArgs(
  argv: readonly string[],
  spec: CommandSpec,
): ParsedArgs {
  const booleans = new Set([...spec.booleans, "help"]);
  const strings = new Set(spec.strings);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (const token of argv) {
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (booleans.has(name)) {
      if (eq !== -1) {
        throw new UsageError(`--${name} takes no value\nusage: ${spec.usage}`);
      }
      flags.set(name, true);
    } else if (strings.has(name)) {
      if (eq === -1) {
        throw new UsageError(
          `--${name} needs a value: --${name}=<value>\nusage: ${spec.usage}`,
        );
      }
      flags.set(name, token.slice(eq + 1));
    } else {
      throw new UsageError(`unknown flag --${name}\nusage: ${spec.usage}`);
    }
  }

  if (flags.has("help")) return { positionals, flags };
  if (
    positionals.length < spec.minPositionals ||
    positionals.length > spec.maxPositionals
  ) {
    throw new UsageError(`usage: ${spec.usage}`);
  }
  return { positionals, flags };
}

/** The string value of a valued flag, or `undefined` when absent. */
export function str(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** Whether a boolean flag was passed. */
export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/** Reject combinations: at most one of `names` may be present. */
export function atMostOneOf(
  parsed: ParsedArgs,
  names: readonly string[],
): void {
  const present = names.filter((n) => parsed.flags.has(n));
  if (present.length > 1) {
    throw new UsageError(
      `${present.map((n) => `--${n}`).join(" and ")} are mutually exclusive`,
    );
  }
}

/** Parse an integer-valued flag, bounds inclusive. */
export function intFlag(
  parsed: ParsedArgs,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = str(parsed, name);
  if (raw === undefined) return undefined;
  // Canonical decimal digits only: Number("") is 0 and Number also accepts "0x5" / " 3 ", so a
  // bare `--index=` (a shell slip) must not silently mean index 0.
  if (!/^-?\d+$/.test(raw)) {
    throw new UsageError(`--${name} must be an integer ${min}..${max}`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new UsageError(`--${name} must be an integer ${min}..${max}`);
  }
  return n;
}
