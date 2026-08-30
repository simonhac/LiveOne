/**
 * `liveone find` — which command does X, answered offline from the generated catalogue.
 *
 * A ROOT-LEVEL verb rather than a domain group: "which command" is a question about the whole
 * tool, not about one domain, and the harness is happy to carry a leaf beside the domain groups.
 *
 * 🛑 IT IMPORTS NO TOOLS. It reads `docs/cli-tools.json` and nothing else — the same discipline the
 * doc generator learned the hard way (importing an unconverted tool RAN it, and nanti's first
 * generator run started a real inbox scan). Discovery must never be able to do anything.
 *
 * The ranking lives in `lib/cli/search.ts` (BM25, ported with its measured constants); this file is
 * the verb: read the catalogue, classify a missing one usefully, render.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  defineCommand,
  failWith,
  EXIT,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import {
  buildIndex,
  search,
  nearestNames,
  type CatalogueTool,
} from "@/lib/cli/search";

const CATALOGUE = "docs/cli-tools.json";

/**
 * Read the committed catalogue. A missing or unparseable one is a USAGE failure naming the
 * regenerate command — not an upstream error, because nothing upstream is involved and the fix is
 * one command away.
 */
function readCatalogue(): CatalogueTool[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(process.cwd(), CATALOGUE), "utf8");
  } catch {
    throw failWith(
      EXIT.USAGE,
      `${CATALOGUE} is missing`,
      "the generated command catalogue is not present",
      "run `npm run cli:reference -- --apply` (and run find from the repo root)",
    );
  }
  try {
    const parsed = JSON.parse(raw) as { tools?: CatalogueTool[] };
    if (!Array.isArray(parsed.tools)) throw new Error("no tools array");
    return parsed.tools;
  } catch {
    throw failWith(
      EXIT.USAGE,
      `${CATALOGUE} is not a catalogue`,
      "the file exists but does not parse as the generated catalogue",
      "regenerate it with `npm run cli:reference -- --apply`",
    );
  }
}

export const findCommand = defineCommand({
  name: "find",
  summary: "Find the command for a job, in plain English.",
  when:
    "Reach for this FIRST when you know what you want to do but not which command does it —\n" +
    "instead of reading CLI_README.md end to end, or grepping the generated prose. Offline and\n" +
    "instant: it ranks the committed catalogue, and imports nothing.",
  description:
    "Prints the best few matches with a one-line signature each — enough to construct the call.\n" +
    "Use --show <name> for one command's full argument schema, and --index for the whole\n" +
    "name+summary spine. Results are trimmed to a character budget, and `truncated` is always\n" +
    "reported rather than a short list quietly looking complete.",
  args: [
    {
      name: "query",
      variadic: true,
      help: "What you are trying to do, in words",
    },
  ],
  flags: {
    show: {
      type: "string",
      placeholder: "name",
      help: "Print one command's full catalogue entry, including its input schema",
    },
    index: {
      type: "boolean",
      help: "List every command — name and summary only",
    },
    limit: {
      type: "number",
      default: 5,
      schema: z.number().int().positive(),
      hint: "a positive integer",
      help: "How many matches to return",
    },
    budget: {
      type: "number",
      default: 4000,
      schema: z.number().int().positive(),
      hint: "a positive integer",
      help: "Character budget for the results",
    },
  },
  exitCodes: { 1: "nothing matched" },
  examples: [
    'liveone find "edit a dashboard card"',
    'liveone find "log in" --limit=3',
    "liveone find --show liveone__dashboard__set-prop",
    "liveone find --index",
  ],
});

export async function runFind(ctx: Ctx): Promise<number> {
  const tools = readCatalogue();

  if (ctx.flags.index === true) {
    const commands = tools.map((t) => ({
      name: t.name,
      summary: t.summary,
      writes: "apply" in (t.input_schema.properties ?? {}),
    }));
    ctx.emit({ count: commands.length, commands }, (m: never) => {
      const model = m as { count: number; commands: typeof commands };
      return [
        ...model.commands.map(
          (c) =>
            `  ${c.name.padEnd(34)} ${c.summary}${c.writes ? "  (writes)" : ""}`,
        ),
        `${model.count} command(s).`,
      ].join("\n");
    });
    return EXIT.OK;
  }

  const showName = ctx.flags.show as string | undefined;
  if (showName !== undefined) {
    const hit = tools.find((t) => t.name === showName);
    if (!hit) {
      const near = nearestNames(
        showName,
        tools.map((t) => t.name),
      );
      throw failWith(
        EXIT.USAGE,
        `no command named "${showName}"`,
        "that name is not in the catalogue",
        near.length
          ? `did you mean: ${near.join(", ")}`
          : "run `liveone find --index` for every command",
      );
    }
    ctx.emit(hit, (m: never) => {
      const t = m as CatalogueTool;
      return [
        `${t.name}${"apply" in (t.input_schema.properties ?? {}) ? "  (writes)" : ""}`,
        `  ${t.invocation}`,
        `  ${t.signature}`,
        "",
        t.description,
        "",
        "input_schema:",
        JSON.stringify(t.input_schema, null, 2),
      ].join("\n");
    });
    return EXIT.OK;
  }

  const query = ctx.args.join(" ").trim();
  if (!query)
    throw failWith(
      EXIT.USAGE,
      "no query",
      "find needs something to search for",
      'try `liveone find "edit a dashboard card"`, or --index for everything',
    );

  const result = search(buildIndex(tools), query, {
    limit: ctx.flags.limit as number,
    budgetChars: ctx.flags.budget as number,
    // Keep this tool out of its own results: its vocabulary is "find the command for a job", which
    // matches essentially every query and would take a slot from a real answer.
    exclude: "liveone__find",
  });

  ctx.emit({ query, count: result.hits.length, ...result }, (m: never) => {
    const model = m as typeof result & { query: string; count: number };
    if (!model.hits.length)
      return `Nothing matched "${model.query}". Try fewer or more common words, or --index.`;
    return [
      ...model.hits.flatMap((h) => [
        `${h.name}${h.writes ? "  (writes)" : ""}`,
        `  ${h.summary}`,
        `  ${h.signature}`,
        `  ${h.invocation}`,
        "",
      ]),
      ...(model.truncated
        ? [
            "(more matches were dropped to stay inside the budget — raise --limit/--budget)",
          ]
        : []),
    ]
      .join("\n")
      .trimEnd();
  });

  return result.hits.length ? EXIT.OK : EXIT.FINDINGS;
}
