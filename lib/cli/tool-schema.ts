/**
 * tool-schema.ts — render a `CommandSpec` into an Anthropic / MCP tool definition.
 *
 * PORTED from nanti's `src/lib/tool-schema.ts`; LiveOne divergences are marked `LiveOne:`.
 *
 * WHY THIS DIRECTION AND NOT THE OTHER. A Claude tool definition is a flat
 * `{name, description, input_schema}`, and that is strictly LESS than a CommandSpec carries: no
 * exit codes, no capability declaration, no dry-by-default gate, no worked examples, no
 * positional-vs-flag distinction, and no TypeScript inference into `ctx.flags`. `CommandSpec` is
 * already a superset, so the mapping runs one way — spec to tool — and authoring stays in
 * `defineCommand()`. Hand-writing the JSON and generating the CLI from it would lose all of the
 * above, permanently.
 *
 * NOTHING IS DROPPED. What JSON Schema cannot express becomes prose in `description`, which is
 * exactly what Anthropic's format intends that field for: it is the only place the model reads
 * about when to call a tool and what its answer means.
 *
 * ZOD VALIDATORS ARE DELIBERATELY NOT EMITTED AS CONSTRAINTS. The reliably-accepted JSON-Schema
 * subset has no `minLength`/`maximum`/`pattern` story worth depending on, and `V.date`'s real
 * constraint — "is a real date", so 2026-02-31 fails — is not expressible at any strictness. A
 * half-expressed constraint reads as a complete one; the `hint` and `placeholder` prose does not.
 *
 * 🛑 THIS IS A DISCOVERY SURFACE, NOT A BRIDGE. Carried over verbatim from nanti's mcp-bridge
 * plan, because it is the trap: exposing every command, most of which write, would be "the
 * rejected option wearing a generated file as a hat". A real MCP server should be a handful of
 * narrow verbs — declared with `defineCommand` and rendered through this same mapping, so they are
 * not hand-written a second time.
 *
 * Every function here is pure: a spec in, a value out. No I/O, no clock, no database.
 */

import {
  kebab,
  FORMATS,
  EXIT,
  reachableExitCodes,
  type Capability,
  type CommandSpec,
  type FlagSpec,
} from "./cli";

/** Anthropic's tool-name charset. A name outside it is a 400, not a warning. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Globals worth emitting. `--format` changes the shape of the answer and `--apply`/`--yes` change
 * whether anything happens at all, so all three belong in the schema. `--quiet`, `--color`,
 * `--help` and the `--json` alias are noise in every definition and are documented once in the
 * generated file's preamble instead.
 */
const EMITTED_GLOBALS = ["format", "apply", "yes"] as const;

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** One invocable command: a top-level tool, or one leaf of a subcommand tree. */
export interface FlatCommand {
  /** e.g. ["dashboard", "show"] */
  path: string[];
  spec: CommandSpec;
  /** Resolved, with the parent's declaration inherited where the child has none. */
  uses: readonly Capability[];
  /**
   * The parent's `when`, where there is one.
   *
   * A SEPARATE FIELD, not copied into `spec.when`. The parent's sentence answers "is this the
   * right TOOL" and the child's answers "which verb" — merging them would make every sibling
   * identical on the highest-weighted search field, so the family would come into contention and
   * nothing could then choose between them. Kept apart, the parent's phrase lifts the whole family
   * and the child's own text picks the member.
   */
  parentWhen?: string;
}

/**
 * Every invocable command under a spec.
 *
 * A parent that has subcommands is NOT itself emitted: `parse()` exits 2 on a missing subcommand,
 * so a tool for the bare parent would advertise a command that cannot run.
 *
 * `uses` is inherited exactly as `parse()` does — a subcommand that declares its own wins, one
 * that does not takes the parent's. Getting this backwards would put "authentication failure" in
 * the description of a command that touches no credential.
 */
export function flattenCommands(spec: CommandSpec): FlatCommand[] {
  const subs = Object.values(spec.subcommands ?? {});
  if (!subs.length) return [{ path: [spec.name], spec, uses: spec.uses ?? [] }];
  return subs.flatMap((sub) =>
    flattenCommands({ ...sub, uses: sub.uses ?? spec.uses }).map((c) => ({
      ...c,
      path: [spec.name, ...c.path],
      // Nearest ancestor that declares one wins, so a three-level tree does not lose the middle
      // level's routing to the root's.
      parentWhen: c.parentWhen ?? spec.when,
    })),
  );
}

/** `["dashboard","show"]` → `dashboard__show`. */
export function toolNameFor(path: string[]): string {
  const name = path.join("__");
  if (!TOOL_NAME.test(name))
    throw new Error(
      `tool name "${name}" is outside Anthropic's charset\n` +
        `  a tool name must match ${TOOL_NAME} — the API rejects anything else\n` +
        `  → rename the command (or subcommand) to lowercase letters, digits, - and _`,
    );
  return name;
}

/** The property description: help, then the shape, then what the constraint means. */
function describeFlag(flag: FlagSpec): string {
  let d = flag.help;
  const placeholder = "placeholder" in flag ? flag.placeholder : undefined;
  if (placeholder) d += ` (${placeholder})`;
  const hint = "hint" in flag ? flag.hint : undefined;
  if (hint) d += ` — ${hint}`;
  return d;
}

function propertyForFlag(flag: FlagSpec): Record<string, unknown> {
  const description = describeFlag(flag);
  if (flag.type === "boolean") {
    const p: Record<string, unknown> = { type: "boolean", description };
    // `!== undefined`, not truthiness: `default: false` is a DECLARED default. Reporting none of
    // them made a nanti flag read as off-by-default when it is on.
    if (flag.default !== undefined) p.default = flag.default;
    return p;
  }
  if (flag.type === "number") {
    const p: Record<string, unknown> = { type: "number", description };
    if (flag.default !== undefined) p.default = flag.default;
    return p;
  }
  if (flag.repeatable)
    return { type: "array", items: { type: "string" }, description };
  const p: Record<string, unknown> = { type: "string", description };
  if (flag.values) p.enum = [...flag.values];
  if (flag.default !== undefined) p.default = flag.default;
  return p;
}

/**
 * The flat object schema.
 *
 * A CLI has two namespaces — positionals and flags — and JSON Schema has one. This THROWS on the
 * first collision, because the alternative is one of the two silently overwriting the other and
 * the agent never learning which.
 */
export function inputSchemaFor(spec: CommandSpec): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const claim = (name: string, by: string) => {
    if (name in properties)
      throw new Error(
        `"${name}" is claimed twice in ${spec.name} (${by})\n` +
          `  a tool's input_schema has ONE namespace, but a CLI has two — positionals and flags\n` +
          `  → rename the positional or the flag so the two do not collide`,
      );
  };

  for (const arg of spec.args ?? []) {
    claim(arg.name, "a positional and something else");
    properties[arg.name] = arg.variadic
      ? { type: "array", items: { type: "string" }, description: arg.help }
      : { type: "string", description: arg.help };
    if (arg.required) required.push(arg.name);
  }

  // Kebab, because that is what gets TYPED. A camelCase declaration key (`allowUnknownType`) is
  // only accepted by the parser in its kebab form (`--allow-unknown-type`); emitting the
  // declaration key would hand the agent an invocation that exits 2.
  for (const [key, flag] of Object.entries(spec.flags ?? {})) {
    if (flag.hidden) continue;
    const name = kebab(key);
    claim(name, "a flag and something else");
    properties[name] = propertyForFlag(flag);
    if ("required" in flag && flag.required) required.push(name);
  }

  for (const g of EMITTED_GLOBALS) {
    if (g !== "format" && !spec.mutates) continue;
    claim(g, `a positional or flag and the global --${g}`);
    properties[g] =
      g === "format"
        ? {
            type: "string",
            enum: [...FORMATS],
            description: "Output format (default: json off a terminal)",
          }
        : g === "apply"
          ? {
              type: "boolean",
              description:
                "Actually write. Without it nothing changes and the report says what would.",
            }
          : {
              type: "boolean",
              description:
                "Confirm without prompting. Required alongside --apply when stdin is not a terminal.",
            };
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

/** `<query>` / `[path...]` — the positional half of the compact signature. */
function signatureArg(arg: {
  name: string;
  required?: boolean;
  variadic?: boolean;
}): string {
  const body = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${body}>` : `[${body}]`;
}

function signatureType(flag: FlagSpec): string {
  if (flag.type === "boolean") return "boolean";
  if (flag.type === "number") return "number";
  if (flag.repeatable) return "string[]";
  if (flag.values) return flag.values.map((v) => `"${v}"`).join("|");
  return "string";
}

/**
 * One bounded line — the cheap half of search → describe.
 *
 * A search hit carries this instead of a full `input_schema`, because it is usually enough to
 * construct the call, and the whole catalogue of full schemas is far more than anyone wanted to
 * read. Globals are omitted: they are universal, and `mutates` is reported beside the hit.
 */
export function signatureFor(cmd: FlatCommand, maxChars = 160): string {
  const parts = [cmd.path.join(" ")];
  for (const arg of cmd.spec.args ?? []) parts.push(signatureArg(arg));
  const flags = Object.entries(cmd.spec.flags ?? {})
    .filter(([, f]) => !f.hidden)
    .map(([k, f]) => {
      const opt = "required" in f && f.required ? "" : "?";
      return `--${kebab(k)}${opt}: ${signatureType(f)}`;
    });
  let sig = parts.join(" ");
  if (flags.length) sig += ` { ${flags.join("; ")} }`;
  return sig.length > maxChars
    ? `${sig.slice(0, maxChars - 2).trimEnd()} …`
    : sig;
}

/**
 * The one flat `description` field, carrying everything the schema cannot.
 *
 * Order is deliberate and stable — the generated file is committed, so a reordering here is a diff
 * on every entry. Invocation first, because that is what the agent has to construct; `when`
 * second, because Anthropic's guidance is that trigger conditions are what lift the should-call
 * rate.
 */
export function descriptionFor(
  cmd: FlatCommand,
  opts: { file: string },
): string {
  const { spec } = cmd;
  const out: string[] = [];
  // LiveOne: tools are invoked through their npm script, not a raw path.
  const invocation = `npm run ${cmd.path[0]} --${cmd.path.length > 1 ? ` ${cmd.path.slice(1).join(" ")}` : ""}`;

  out.push(`${invocation} — ${spec.summary}`);
  if (spec.when) out.push(spec.when);
  // The parent's routing, for a subcommand — a model reading `dashboard__set-prop` in isolation
  // otherwise has no idea what `dashboard` is for.
  if (cmd.parentWhen)
    out.push(`About \`${cmd.path[0]}\` generally: ${cmd.parentWhen}`);
  if (spec.description) out.push(spec.description);

  out.push(
    spec.mutates
      ? "WRITES. Dry by default: without --apply nothing changes and the report says what would. " +
          "Off a terminal --apply additionally requires --yes, or it refuses with exit 2."
      : "Read-only. This command changes nothing.",
  );

  // LiveOne: systems rather than OAuth scopes.
  const uses = new Set(cmd.uses);
  if (uses.has("db"))
    out.push(
      "Connects DIRECTLY to Postgres using the connection string in the environment. The printed " +
        "`target:` line names the database, role and host — read it before writing.",
    );
  if (uses.has("api"))
    out.push(
      `Calls the deployed LiveOne API as the signed-in user. A missing, expired or revoked CLI token is exit ${EXIT.AUTH}.`,
    );
  if (uses.has("clerk"))
    out.push(
      `Calls the Clerk backend API. An auth failure is exit ${EXIT.AUTH}.`,
    );

  const codes = reachableExitCodes(spec);
  const specific = Object.entries(spec.exitCodes ?? {}).map(
    ([c, m]) => `${c} = ${m}`,
  );
  out.push(
    `Exit codes: ${codes.join(", ")}.${specific.length ? ` For this command, ${specific.join("; ")}.` : ""}`,
  );

  // The examples are already written as complete invocations in the tool's own declaration. Emit
  // them as written — they are required to be copy-pasteable, so re-decorating them here would
  // only make them wrong.
  if (spec.examples?.length)
    out.push(`Examples:\n${spec.examples.map((e) => `  ${e}`).join("\n")}`);

  return out.join("\n\n");
}

/** The whole thing: exactly the three members Anthropic's format defines. */
export function toAnthropicTool(
  cmd: FlatCommand,
  opts: { file: string },
): AnthropicTool {
  return {
    name: toolNameFor(cmd.path),
    description: descriptionFor(cmd, opts),
    input_schema: inputSchemaFor(cmd.spec),
  };
}

/** Every tool for one source file's exported command. */
export function toolsFor(
  spec: CommandSpec,
  opts: { file: string },
): AnthropicTool[] {
  return flattenCommands(spec).map((c) => toAnthropicTool(c, opts));
}
