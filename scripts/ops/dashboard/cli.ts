#!/usr/bin/env tsx
/**
 * dashboard — inspect and edit stored dashboard documents (`dashboards.doc`, the v4 node tree).
 *
 * Declared with `defineCommand` and driven by the shared harness in `lib/cli/` — so it gets
 * arity-aware parsing, `--help` on every subcommand, `--format human|json`, the dry-by-default
 * write gate, the exit-code vocabulary and stdout/stderr separation for free, and so a future MCP
 * server can render its tool list from this same declaration (`lib/cli/tool-schema.ts`).
 *
 * See `docs/migrations.md` § "Data & config-document migrations".
 */
import fs from "node:fs";
import { z } from "zod";
import type { Client } from "pg";
import { Area, Dashboard, Device } from "@/lib/ids";
import { isValidAlias, normalizeAlias } from "@/lib/dashboard/alias";
import {
  CARD_CONFIG_SCHEMAS,
  isKnownCardType,
} from "@/lib/dashboard/card-types";
import {
  countCardNodes,
  countCardsInNode,
  isDashboardV4,
  type CardNode,
  type DashboardV4,
  type GroupNode,
  type NodeId,
} from "@/lib/dashboard/v4";
import { isAliasCollision } from "@/lib/dashboard/dashboards";
import { validateDocV4, type DocIssue } from "@/lib/dashboard/v4-validate";
import {
  countMissingIds,
  findNode,
  insertNode,
  moveNode,
  removeNode,
  setNodeProps,
  subtreeIds,
  type NodePatch,
  type NodePosition,
} from "@/lib/dashboard/node-ops";
import { renderDocTree } from "@/lib/dashboard/v4-tree-text";
import {
  defineCommand,
  failWith,
  kebab,
  run,
  EXIT,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import {
  connect,
  dashLabel,
  listDashboards,
  printTarget,
  resolveDashboard,
  writeDoc,
  type DashRow,
} from "./db";

// ---------------------------------------------------------------------------
// Flag access
// ---------------------------------------------------------------------------

const str = (ctx: Ctx, k: string): string | undefined =>
  ctx.flags[k] as string | undefined;
const bool = (ctx: Ctx, k: string): boolean => ctx.flags[k] === true;
const num = (ctx: Ctx, k: string): number | undefined =>
  ctx.flags[k] as number | undefined;

/**
 * At most one of `names` may be supplied. `names` are DECLARATION keys (`ctx.flags` is keyed by
 * them), but the message shows the kebab form, because that is what the caller typed and what the
 * parser will accept back.
 */
function atMostOne(ctx: Ctx, names: string[]): void {
  const present = names.filter((n) => ctx.flags[n] !== undefined);
  if (present.length > 1)
    throw failWith(
      EXIT.USAGE,
      present.map((n) => `--${kebab(n)}`).join(" and "),
      "these flags are mutually exclusive",
      `pass only one of ${names.map((n) => `--${kebab(n)}`).join(", ")}`,
    );
}

const usage = (what: string, why: string, next: string) =>
  failWith(EXIT.USAGE, what, why, next);

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const issueLines = (issues: DocIssue[], severity: string): string[] =>
  issues.map((i) => `  ${severity} ${i.path}: ${i.message} [${i.code}]`);

/** v4 guard, stored-doc validation, normalized working copy. */
function loadWorkingDoc(row: DashRow): {
  working: DashboardV4;
  missingIds: number;
} {
  if (!isDashboardV4(row.doc))
    throw failWith(
      EXIT.FINDINGS,
      `${dashLabel(row)}: doc is not a v4 document`,
      "this tool only edits v4 node-tree documents",
      "inspect the row directly; there is nothing here to edit",
    );
  // Validate BEFORE walking: isDashboardV4 checks only version + root.kind, so a doc whose root
  // lacks `children` would make countMissingIds' walk throw a raw TypeError instead of this
  // refusal.
  const res = validateDocV4(row.doc);
  if (!res.valid)
    throw failWith(
      EXIT.FINDINGS,
      `${dashLabel(row)}: stored doc is already invalid`,
      issueLines(res.errors, "error").join("\n").trim(),
      "run `dashboard validate` for the full list — refusing to edit a doc that is already broken",
    );
  return { working: res.normalized!, missingIds: countMissingIds(row.doc) };
}

/**
 * Format-check an `--area`/`--device` flag and confirm the row exists in the target database.
 *
 * 🛑 EXISTENCE ONLY — this admin path deliberately skips the API's `checkDocRefsReadable`
 * (readability/no-escalation) check, and that has two concrete consequences:
 *   - Share-token scope is derived from the doc at READ time (`collectRefs` → `allowedSystemIds`),
 *     so writing a ref here on a dashboard with an active share token IMMEDIATELY widens what
 *     anonymous `?access=` viewers can query — no grant row anywhere.
 *   - A ref outside the owner's readable set makes the doc unsaveable via the web editor: every
 *     subsequent UI PUT 403s until this CLI removes the ref.
 * The warning below is emitted on every ref write so neither happens silently.
 */
async function checkRef(
  ctx: Ctx,
  client: Client,
  kind: "area" | "device",
  value: string,
): Promise<void> {
  const codec = kind === "area" ? Area : Device;
  const uuid = codec.toUuidOrNull(value);
  if (!uuid)
    throw usage(
      `"${value}" for --${kind}`,
      `--${kind} expects a ${kind} id`,
      `pass a ${kind === "area" ? "ar_…" : "dv_…"} id`,
    );
  const table = kind === "area" ? "areas" : "devices";
  const res = await client.query(`select 1 from ${table} where id = $1`, [
    uuid,
  ]);
  if (res.rowCount === 0)
    throw usage(
      `--${kind}: no ${kind} ${value} in the target database`,
      "the id is well-formed but names nothing here",
      "check you are pointed at the right database — ids are per-environment",
    );
  ctx.warn(
    `warning: readability of ${value} is NOT checked — on a shared dashboard this ref widens what ` +
      `anonymous viewers can query, and a ref the owner cannot read locks the doc out of the web editor`,
  );
}

/** The unknown-card-type gate — only for the type THIS command introduces. */
function checkCardType(type: string, allowUnknown: boolean): void {
  if (!isKnownCardType(type) && !allowUnknown)
    throw usage(
      `"${type}" is not a known card type`,
      "an unknown type persists but renders as a placeholder, not a card",
      "check the spelling, or pass --allow-unknown-type to write it anyway",
    );
}

/**
 * Parse `--config-json` / `--config-file`. `undefined` = not supplied.
 *
 * 🛑 Reads the DECLARATION keys (`configJson`), not the typed kebab names: `ctx.flags` is keyed by
 * the declaration. Reading `"config-json"` here silently returned undefined, so a supplied
 * `--config-json` was DROPPED and the bare-type check it feeds never fired.
 */
function parseConfigFlags(ctx: Ctx): unknown {
  atMostOne(ctx, ["configJson", "configFile", "config"]);
  const inline = str(ctx, "configJson");
  const file = str(ctx, "configFile");
  const raw =
    inline ?? (file !== undefined ? fs.readFileSync(file, "utf8") : undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw usage(
      `--config-${inline !== undefined ? "json" : "file"}`,
      `the value is not valid JSON: ${err instanceof Error ? err.message : err}`,
      'pass a JSON object, e.g. --config-json=\'{"variant":"lines"}\'',
    );
  }
}

/** A known type absent from CARD_CONFIG_SCHEMAS is BARE — it must carry no config at all. */
function checkConfigAllowed(type: string, config: unknown): void {
  if (config === undefined) return;
  if (isKnownCardType(type) && !CARD_CONFIG_SCHEMAS[type])
    throw usage(
      `config for card type "${type}"`,
      `"${type}" takes no config`,
      "drop the --config-* flag, or set a type that accepts one",
    );
}

/** `--parent/--index/--before/--after` → a NodePosition. Default: append to the root. */
function parsePositionFlags(
  ctx: Ctx,
  rootId: NodeId,
  required: boolean,
): NodePosition {
  atMostOne(ctx, ["index", "before", "after"]);
  const parent = str(ctx, "parent");
  const before = str(ctx, "before");
  const after = str(ctx, "after");
  if (parent !== undefined && (before !== undefined || after !== undefined))
    throw usage(
      "--parent with --before/--after",
      "--parent names a container; --before/--after name a sibling",
      "pass --parent [--index=<k>], or one of --before/--after",
    );
  if (before !== undefined) return { beforeId: before };
  if (after !== undefined) return { afterId: after };
  const index = num(ctx, "index");
  if (parent !== undefined) return { parentId: parent, index };
  if (index !== undefined) return { parentId: rootId, index };
  if (required)
    throw usage(
      "no destination",
      "a move needs somewhere to go",
      "pass --before, --after, or --parent [--index=<k>]",
    );
  return { parentId: rootId };
}

function describePosition(pos: NodePosition): string {
  if ("beforeId" in pos) return `before ${pos.beforeId}`;
  if ("afterId" in pos) return `after ${pos.afterId}`;
  return `under ${pos.parentId}${pos.index !== undefined ? ` at index ${pos.index}` : ""}`;
}

interface Mutation {
  /** Transformed (pre-normalize) doc. */
  next: DashboardV4;
  /** e.g. `insert card "solar" under n_3` — the runner prefixes would/WRITE. */
  action: string;
  /** Highlight a node resolved post-normalize by slot (inserts mint their id late). */
  markerSlot?: { parentId: NodeId; index: number; marker: string };
  /** Highlight known node ids. */
  markerIds?: { ids: NodeId[]; marker: string };
  /** Subtree to render for the preview; undefined = whole doc. */
  renderRootId?: NodeId;
  /** Extra preview lines before the tree (e.g. the removed subtree). */
  extraLines?: string[];
}

/**
 * Validate the result, preview it, and (unless dry) CAS-write it.
 *
 * One model, two renderings: the JSON carries the structured facts and the same preview lines the
 * human sees, so the two can never report different things.
 */
async function runDocMutation(
  ctx: Ctx,
  client: Client,
  row: DashRow,
  working: DashboardV4,
  missingIds: number,
  mutation: Mutation,
): Promise<number> {
  const result = validateDocV4(mutation.next);
  if (!result.valid)
    throw failWith(
      EXIT.FINDINGS,
      `${dashLabel(row)}: the edited doc would be invalid`,
      issueLines(result.errors, "error").join("\n").trim(),
      "adjust the flags so the result validates — nothing was written",
    );
  const final = result.normalized ?? mutation.next;

  const markers = new Map<NodeId, string>();
  for (const id of mutation.markerIds?.ids ?? [])
    markers.set(id, mutation.markerIds!.marker);
  if (mutation.markerSlot) {
    const parent = findNode(final, mutation.markerSlot.parentId);
    if (parent && parent.node.kind === "group") {
      const child = parent.node.children[mutation.markerSlot.index];
      if (child?.id) markers.set(child.id, mutation.markerSlot.marker);
    }
  }

  const before = countCardNodes(working);
  const after = countCardNodes(final);
  const preview = [
    ...(mutation.extraLines ?? []),
    renderDocTree(final, { nodeId: mutation.renderRootId, markers }),
  ];

  if (!ctx.dryRun) await writeDoc(client, row, final);

  ctx.emit(
    {
      dashboard: {
        id: Dashboard.encode(row.id),
        name: row.name,
        revision: ctx.dryRun ? row.revision : row.revision + 1,
      },
      action: mutation.action,
      applied: !ctx.dryRun,
      cards: { before, after },
      assignedNodeIds: missingIds,
      warnings: result.warnings,
      preview,
    },
    (m: never) => {
      const model = m as {
        action: string;
        applied: boolean;
        cards: { before: number; after: number };
        assignedNodeIds: number;
        warnings: DocIssue[];
        preview: string[];
      };
      const out = [
        `${model.applied ? "WRITE" : "would"} ${model.action} in ${dashLabel(row)}`,
      ];
      if (model.assignedNodeIds > 0)
        out.push(
          `  (also assigns ${model.assignedNodeIds} missing node id(s))`,
        );
      out.push(...issueLines(model.warnings, "warning"), ...model.preview);
      if (model.cards.before !== model.cards.after)
        out.push(`cards: ${model.cards.before} -> ${model.cards.after}`);
      out.push(
        model.applied
          ? `wrote revision ${row.revision + 1}`
          : "Re-run with --apply to write.",
      );
      return out.join("\n");
    },
  );
  return EXIT.OK;
}

/**
 * The shared add-card / add-group flow. The caller supplies only the node-specific flags and the
 * summary wording; the envelope flags, position parsing, insertion and the preview/write are one
 * implementation, so a fix to the insert path cannot land in one command and miss the other.
 */
async function runInsert(
  ctx: Ctx,
  makeBareNode: () => CardNode | GroupNode,
  summaryOf: (node: CardNode | GroupNode) => string,
): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, ctx.dryRun ? "dry-run" : "APPLY");
    const node = makeBareNode();
    const area = str(ctx, "area");
    if (area !== undefined) {
      await checkRef(ctx, client, "area", area);
      if (Area.is(area)) node.area = area;
    }
    const device = str(ctx, "device");
    if (device !== undefined) {
      await checkRef(ctx, client, "device", device);
      if (Device.is(device)) node.device = device;
    }
    if (bool(ctx, "hidden")) node.hidden = true;
    const columns = num(ctx, "columns");
    if (columns !== undefined) node.size = { columns };

    const row = await resolveDashboard(client, ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const pos = parsePositionFlags(ctx, working.root.id!, false);
    const res = insertNode(working, node, pos);
    return runDocMutation(ctx, client, row, working, missingIds, {
      next: res.doc,
      action: `${summaryOf(node)} ${describePosition(pos)}`,
      markerSlot: { parentId: res.parentId, index: res.index, marker: "+" },
      renderRootId: res.parentId,
    });
  });
}

// ---------------------------------------------------------------------------
// Shared flag groups
// ---------------------------------------------------------------------------

const DASH_ARG = {
  name: "dash",
  required: true,
  help: "A dashboard: its db_… id, its legacy integer id, or its slug",
} as const;

const NODE_ARG = {
  name: "node",
  required: true,
  help: "The n_… id of the node, as printed by `show`",
} as const;

const POSITION_FLAGS = {
  parent: {
    type: "string",
    placeholder: "n_id",
    help: "Insert inside this group (default: the root)",
  },
  index: {
    type: "number",
    placeholder: "k",
    schema: z.number().int().min(0),
    hint: "0-based position among the parent's children",
    help: "Position within the parent (default: append)",
  },
  before: {
    type: "string",
    placeholder: "n_id",
    help: "Insert immediately before this sibling",
  },
  after: {
    type: "string",
    placeholder: "n_id",
    help: "Insert immediately after this sibling",
  },
} as const;

const ENVELOPE_FLAGS = {
  area: {
    type: "string",
    placeholder: "ar_id",
    help: "Bind the node to an area (scope-bearing; readability is NOT checked)",
  },
  device: {
    type: "string",
    placeholder: "dv_id",
    help: "Bind the node to a device (scope-bearing; readability is NOT checked)",
  },
  hidden: { type: "boolean", help: "Mark the node hidden" },
  columns: {
    type: "number",
    placeholder: "1-12",
    schema: z.number().int().min(1).max(12),
    hint: "1–12 on the 12-column grid",
    help: "Width hint",
  },
} as const;

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export const cmd = defineCommand({
  name: "dashboard",
  summary:
    "Inspect and edit stored dashboard documents (`dashboards.doc`, the v4 node tree).",
  when:
    "Reach for this to read or change what a dashboard SHOWS — its cards, groups, layout and\n" +
    "which area or device each is bound to — directly in the database. For a card-type rename\n" +
    "across every stored document use `scripts/utils/migrate-card-type.ts` instead; for the\n" +
    "areas and devices a dashboard refers to, edit those through the app.",
  description:
    "The connection comes from MIGRATE_DATABASE_URL and nothing else — deliberately NOT the\n" +
    "ambient PLANETSCALE_DATABASE_URL, because the durable target is PROD and 'which database am\n" +
    "I pointed at' must never be answered by whatever happens to be in .env.local. Every command\n" +
    "prints `target: database as user @ host` on stderr before doing anything: READ THAT LINE\n" +
    "before you pass --apply. There is deliberately no 'am I on prod' auto-detection — a freshly\n" +
    "minted `pscale role` connects as pscale_api_… and carries no branch id, so the usual check\n" +
    "would report a confident 'not prod' for the exact connection this tool normally targets. A\n" +
    "false reassurance is worse than none; the printed identity is the check.\n" +
    "\n" +
    "🛑 Durable edits go to PROD. `dashboards` is a config table the 2-hourly prod→dev sync\n" +
    "refreshes, so a dev-only edit is reverted within the hour. Rehearse against dev freely.\n" +
    "🛑 n_… node ids are minted per-document per-ENVIRONMENT, so prod and dev drift. Making the\n" +
    "same edit in both means re-running `show` in each — never reuse an id across environments.",
  uses: ["db"],
  subcommands: {
    list: {
      name: "list",
      summary:
        "List dashboards: id, owner, name, slug, revision and card count.",
      when: "Start here when you do not yet know a dashboard's id.",
      flags: {
        owner: {
          type: "string",
          placeholder: "userId",
          help: "Only this owner's dashboards",
        },
      },
      examples: ["dashboard list", "dashboard list --format json"],
    },

    show: {
      name: "show",
      summary:
        "Render a dashboard's node tree, with the n_… ids edits address.",
      when:
        "Run this before any edit: the n_… ids it prints are the handles every other subcommand\n" +
        "takes, and they are per-environment so they must be read from the database you intend\n" +
        "to change.",
      description:
        "Always renders the NORMALIZED document, so the ids shown are the ids a write would\n" +
        "persist. --format json emits the same normalized doc (or one subtree with --node).",
      args: [DASH_ARG],
      flags: {
        node: {
          type: "string",
          placeholder: "n_id",
          help: "Render only this node's subtree",
        },
      },
      examples: [
        "dashboard show 6",
        "dashboard show db_01kyf18tp3e5brm474zf0fzvkm --node=n_1",
      ],
    },

    validate: {
      name: "validate",
      summary: "Validate a stored dashboard doc, or a doc in a JSON file.",
      when:
        "Use this to find out WHY an edit is being refused, or to check a document you are about\n" +
        "to write from a file.",
      args: [{ ...DASH_ARG, required: false }],
      flags: {
        file: {
          type: "string",
          placeholder: "path",
          help: "Validate this JSON file instead of a stored dashboard",
        },
      },
      exitCodes: { 1: "the document is invalid" },
      examples: ["dashboard validate 6", "dashboard validate --file=doc.json"],
    },

    rename: {
      name: "rename",
      summary:
        "Change a dashboard's name and/or slug. Metadata only — the doc is untouched.",
      when: "Use this for the dashboard's own name or its /dashboard/{user}/{slug} shortname.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        name: {
          type: "string",
          placeholder: "text",
          help: 'New display name, or "none" to clear it',
        },
        slug: {
          type: "string",
          placeholder: "kebab",
          help: 'New owner-unique shortname, or "none" to clear it',
        },
      },
      examples: [
        "dashboard rename 6 --slug=daylesford",
        "dashboard rename 6 --name='Daylesford' --apply",
      ],
    },

    "add-card": {
      name: "add-card",
      summary: "Insert a card node.",
      when: "Use this to put a new card on a dashboard; `add-group` makes a container instead.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        type: {
          type: "string",
          required: true,
          placeholder: "cardType",
          help: "The card type, e.g. solar, chart, heatmap",
        },
        configJson: {
          type: "string",
          placeholder: "json",
          help: "The card's config, inline",
        },
        configFile: {
          type: "string",
          placeholder: "path",
          help: "The card's config, from a JSON file",
        },
        allowUnknownType: {
          type: "boolean",
          help: "Write a type this build does not know (it renders as a placeholder)",
        },
        ...ENVELOPE_FLAGS,
        ...POSITION_FLAGS,
      },
      examples: [
        "dashboard add-card 6 --type=heatmap --device=dv_01kybrhzkmfyxvz63d15rscj19 --after=n_a",
        'dashboard add-card 6 --type=chart --config-json=\'{"variant":"lines"}\' --apply',
      ],
    },

    "add-group": {
      name: "add-group",
      summary: "Insert an empty group node.",
      when:
        "Use this for structure — a row of tiles, or an area section. A group with an area and\n" +
        "heading is what used to be called a section; a row group is what used to be a tiles card.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        direction: {
          type: "string",
          values: ["row", "column"],
          help: "Flex direction (default: column)",
        },
        wrap: { type: "boolean", help: "Allow children to wrap" },
        heading: { type: "boolean", help: "Render the bound area's header" },
        ...ENVELOPE_FLAGS,
        ...POSITION_FLAGS,
      },
      examples: [
        "dashboard add-group 6 --direction=row --wrap --after=n_2",
        "dashboard add-group 6 --area=ar_01kx8km3a3fh5v2csryvhskzep --heading --apply",
      ],
    },

    "remove-node": {
      name: "remove-node",
      summary: "Remove a node and its whole subtree.",
      when: "Removes the node AND everything under it — check `show` first if it is a group.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      examples: [
        "dashboard remove-node 6 n_6",
        "dashboard remove-node 6 n_6 --apply",
      ],
    },

    "move-node": {
      name: "move-node",
      summary: "Move a node, subtree intact and ids preserved.",
      when:
        "Use this to reorder or re-parent. Ids survive the move, so a later edit can still\n" +
        "address the node by the id `show` printed before it.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: { ...POSITION_FLAGS },
      examples: [
        "dashboard move-node 6 n_8 --before=n_7",
        "dashboard move-node 6 n_8 --parent=n_2 --index=0 --apply",
      ],
    },

    "set-prop": {
      name: "set-prop",
      summary:
        "Set or clear a node's envelope props, and a card's type/config.",
      when:
        "Use this to change an existing node in place — bind it to a different device, resize it,\n" +
        "hide it, or replace a card's config. Pass `none` to any property to DELETE that key.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: {
        area: {
          type: "string",
          placeholder: "ar_id|none",
          help: "Bind to an area, or none to clear (readability is NOT checked)",
        },
        device: {
          type: "string",
          placeholder: "dv_id|none",
          help: "Bind to a device, or none to clear (readability is NOT checked)",
        },
        hidden: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Set or clear the hidden flag",
        },
        wrap: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Group only: set or clear wrapping",
        },
        heading: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Group only: set or clear the area header",
        },
        direction: {
          type: "string",
          values: ["row", "column", "none"],
          help: "Group only: flex direction, or none to clear",
        },
        columns: {
          type: "string",
          placeholder: "1-12|none",
          help: "Width hint, or none to clear",
        },
        type: {
          type: "string",
          placeholder: "cardType",
          help: "Card only: change the card type",
        },
        config: {
          type: "string",
          values: ["none"],
          help: "Card only: clear the config (use --config-json/--config-file to set)",
        },
        configJson: {
          type: "string",
          placeholder: "json",
          help: "Card only: replace the config, inline",
        },
        configFile: {
          type: "string",
          placeholder: "path",
          help: "Card only: replace the config, from a JSON file",
        },
        allowUnknownType: {
          type: "boolean",
          help: "Allow a --type this build does not know",
        },
      },
      examples: [
        "dashboard set-prop 6 n_3 --columns=6",
        "dashboard set-prop 6 n_3 --hidden=none --apply",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runList(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, "read-only");
    const owner = str(ctx, "owner");
    if (owner === "")
      // An unset shell variable must not silently widen the query to every owner.
      throw usage(
        "--owner=",
        "the value is empty",
        "omit the flag to list every owner, or pass a real user id",
      );
    const rows = await listDashboards(client, owner);
    const dashboards = rows.map((r) => ({
      id: Dashboard.encode(r.id),
      legacyId: r.legacyId,
      owner: r.ownerUserId,
      name: r.name,
      slug: r.slug,
      revision: r.revision,
      cardCount: isDashboardV4(r.doc) ? countCardNodes(r.doc) : null,
      updatedAt: r.updatedAt.toISOString(),
    }));
    ctx.emit({ count: dashboards.length, dashboards }, (m: never) => {
      const model = m as { count: number; dashboards: typeof dashboards };
      return [
        ...model.dashboards.map(
          (e) =>
            `${e.id}  rev=${String(e.revision).padEnd(3)} cards=${String(e.cardCount ?? "?").padEnd(3)} ` +
            `legacy=${String(e.legacyId ?? "-").padEnd(4)} owner=${e.owner}  ` +
            `${e.slug ? `slug=${e.slug}  ` : ""}${e.name ?? "(unnamed)"}`,
        ),
        "",
        `${model.count} dashboard(s).`,
      ].join("\n");
    });
    return EXIT.OK;
  });
}

async function runShow(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, "read-only");
    const row = await resolveDashboard(client, ctx.args[0]);
    const nodeId = str(ctx, "node");
    const { working, missingIds } = loadWorkingDoc(row);
    if (missingIds > 0)
      ctx.note(
        `note: ${missingIds} node(s) had no id; ids shown will be persisted by the next write`,
      );
    // An unknown --node is an ERROR in both output modes: renderDocTree's "(no node …)"
    // placeholder with exit 0 read as success to scripted callers.
    if (nodeId !== undefined && !findNode(working, nodeId))
      throw failWith(
        EXIT.FINDINGS,
        `no node "${nodeId}"`,
        "this document has no node with that id",
        "run `dashboard show <dash>` for the current ids — they are per-environment",
      );
    const subtree = nodeId ? findNode(working, nodeId)!.node : working.root;
    ctx.emit(
      {
        dashboard: {
          id: Dashboard.encode(row.id),
          name: row.name,
          slug: row.slug,
          legacyId: row.legacyId,
          owner: row.ownerUserId,
          revision: row.revision,
          cards: countCardNodes(working),
        },
        // The normalized doc (or the requested subtree) — the same tree the human sees.
        doc: nodeId ? subtree : working,
      },
      () =>
        [
          `${dashLabel(row)}  owner=${row.ownerUserId}` +
            `${row.slug ? `  slug=${row.slug}` : ""}` +
            `${row.legacyId !== null ? `  legacy=${row.legacyId}` : ""}` +
            `  cards=${countCardNodes(working)}`,
          renderDocTree(working, { nodeId }),
        ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runValidate(ctx: Ctx): Promise<number> {
  const file = str(ctx, "file");
  const ref = ctx.args[0];
  if ((file === undefined) === (ref === undefined))
    throw usage(
      file === undefined
        ? "neither <dash> nor --file"
        : "both <dash> and --file",
      "validate takes exactly one target",
      "pass a dashboard, or --file=<path>",
    );

  let doc: unknown;
  let label: string;
  if (file !== undefined) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw usage(
        file,
        `could not be read as JSON: ${err instanceof Error ? err.message : err}`,
        "check the path and that the file contains a JSON document",
      );
    }
    label = file;
  } else {
    const row = await withClient(async (client) => {
      await printTarget(client, "read-only");
      return resolveDashboard(client, ref!);
    });
    doc = row.doc;
    label = dashLabel(row);
  }

  const result = validateDocV4(doc);
  ctx.emit(
    {
      target: label,
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
    },
    (m: never) => {
      const model = m as typeof result & { target: string };
      return [
        ...issueLines(model.errors, "error"),
        ...issueLines(model.warnings, "warning"),
        `${model.target}: ${model.valid ? "valid" : "INVALID"} ` +
          `(${model.errors.length} error(s), ${model.warnings.length} warning(s))`,
      ].join("\n");
    },
  );
  return result.valid ? EXIT.OK : EXIT.FINDINGS;
}

async function runRename(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, ctx.dryRun ? "dry-run" : "APPLY");
    const rawName = str(ctx, "name");
    const rawSlug = str(ctx, "slug");
    if (rawName === undefined && rawSlug === undefined)
      throw usage(
        "no change requested",
        "rename needs something to change",
        "pass --name and/or --slug",
      );

    const name =
      rawName === undefined ? undefined : rawName === "none" ? null : rawName;
    if (name === "")
      throw usage(
        "--name=",
        "an empty name is not a name",
        "use --name=none to clear it",
      );

    let slug: string | null | undefined;
    if (rawSlug !== undefined) {
      slug = rawSlug === "none" ? null : rawSlug;
      if (slug === "")
        throw usage(
          "--slug=",
          "an empty slug is not a slug",
          "use --slug=none to clear it",
        );
      if (slug !== null && !isValidAlias(slug)) {
        const suggestion = normalizeAlias(slug);
        throw usage(
          `"${slug}" for --slug`,
          "a slug is kebab-case: lowercase a-z/0-9 joined by single hyphens",
          suggestion
            ? `try --slug=${suggestion}`
            : "pick a kebab-case shortname",
        );
      }
    }

    const row = await resolveDashboard(client, ctx.args[0]);
    const changes: Record<string, unknown> = {};
    if (name !== undefined) changes.name = { from: row.name, to: name };
    if (slug !== undefined) changes.slug = { from: row.slug, to: slug };

    if (!ctx.dryRun) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) {
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      if (slug !== undefined) {
        params.push(slug);
        sets.push(`slug = $${params.length}`);
      }
      params.push(row.id);
      try {
        await client.query(
          `update dashboards set ${sets.join(", ")}, updated_at = now() where id = $${params.length}`,
          params,
        );
      } catch (err) {
        if (isAliasCollision(err))
          throw failWith(
            EXIT.FINDINGS,
            `slug "${slug}" is already taken`,
            `another of ${row.ownerUserId}'s dashboards already uses it`,
            "pick a different shortname",
          );
        throw err;
      }
    }

    ctx.emit(
      {
        dashboard: { id: Dashboard.encode(row.id), name: row.name },
        changes,
        applied: !ctx.dryRun,
      },
      (m: never) => {
        const model = m as {
          changes: Record<string, { from: unknown; to: unknown }>;
          applied: boolean;
        };
        const out = [
          `${model.applied ? "WRITE" : "would"} rename ${dashLabel(row)}:`,
        ];
        for (const [k, v] of Object.entries(model.changes))
          out.push(
            `  ${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`,
          );
        out.push(model.applied ? "renamed." : "Re-run with --apply to write.");
        return out.join("\n");
      },
    );
    return EXIT.OK;
  });
}

async function runRemoveNode(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, ctx.dryRun ? "dry-run" : "APPLY");
    const row = await resolveDashboard(client, ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const res = removeNode(working, id);
    const removedMarkers = new Map(
      subtreeIds(res.removed).map((n) => [n, "-"] as const),
    );
    return runDocMutation(ctx, client, row, working, missingIds, {
      next: res.doc,
      action: `remove ${id} (${countCardsInNode(res.removed)} card(s))`,
      extraLines: [
        "removed subtree:",
        renderDocTree(working, { nodeId: id, markers: removedMarkers }),
        "resulting tree:",
      ],
    });
  });
}

async function runMoveNode(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, ctx.dryRun ? "dry-run" : "APPLY");
    const row = await resolveDashboard(client, ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const pos = parsePositionFlags(ctx, working.root.id!, true);
    const res = moveNode(working, id, pos);
    return runDocMutation(ctx, client, row, working, missingIds, {
      next: res.doc,
      action: `move ${id} ${describePosition(pos)}`,
      markerIds: { ids: [id], marker: "*" },
      renderRootId: res.parentId,
    });
  });
}

async function runSetProp(ctx: Ctx): Promise<number> {
  return withClient(async (client) => {
    await printTarget(client, ctx.dryRun ? "dry-run" : "APPLY");
    const row = await resolveDashboard(client, ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const found = findNode(working, id);
    if (!found)
      throw failWith(
        EXIT.FINDINGS,
        `no node "${id}"`,
        "this document has no node with that id",
        "run `dashboard show <dash>` for the current ids",
      );

    const patch: NodePatch = {};
    // The parser has already constrained these to true|false|none via `values`.
    const tri = (name: "hidden" | "wrap" | "heading"): void => {
      const v = str(ctx, name);
      if (v === undefined) return;
      patch[name] = v === "none" ? null : v === "true";
    };
    tri("hidden");
    tri("wrap");
    tri("heading");

    const area = str(ctx, "area");
    if (area !== undefined) {
      if (area === "none") patch.area = null;
      else {
        await checkRef(ctx, client, "area", area);
        if (Area.is(area)) patch.area = area;
      }
    }
    const device = str(ctx, "device");
    if (device !== undefined) {
      if (device === "none") patch.device = null;
      else {
        await checkRef(ctx, client, "device", device);
        if (Device.is(device)) patch.device = device;
      }
    }
    const rawColumns = str(ctx, "columns");
    if (rawColumns !== undefined) {
      if (rawColumns === "none") patch.columns = null;
      else {
        // A free-form string here (rather than a number flag) so it can also carry "none".
        if (!/^\d+$/.test(rawColumns) || +rawColumns < 1 || +rawColumns > 12)
          throw usage(
            `"${rawColumns}" for --columns`,
            "columns is 1–12 on the 12-column grid, or none",
            "pass --columns=<1-12> or --columns=none",
          );
        patch.columns = Number(rawColumns);
      }
    }
    const direction = str(ctx, "direction");
    if (direction !== undefined)
      patch.direction =
        direction === "none" ? null : (direction as "row" | "column");
    const type = str(ctx, "type");
    if (type !== undefined) {
      checkCardType(type, bool(ctx, "allowUnknownType"));
      patch.type = type;
    }
    // Mutual exclusion FIRST: parseConfigFlags holds the check, and the --config=none branch
    // skips it — without this, `--config=none --config-json=…` would silently delete the config
    // and drop the supplied JSON.
    atMostOne(ctx, ["config", "configJson", "configFile"]);
    const rawConfig = str(ctx, "config");
    const config = rawConfig === "none" ? null : parseConfigFlags(ctx);
    if (config !== undefined) {
      patch.config = config;
      if (config !== null)
        checkConfigAllowed(
          patch.type ?? (found.node.kind === "card" ? found.node.type : ""),
          config,
        );
    }
    if (Object.keys(patch).length === 0)
      throw usage(
        "nothing to change",
        "set-prop needs at least one property flag",
        "run `dashboard set-prop --help` for the list",
      );

    const res = setNodeProps(working, id, patch);
    return runDocMutation(ctx, client, row, working, missingIds, {
      next: res.doc,
      action: `set ${Object.keys(patch).join(", ")} on ${id}`,
      markerIds: { ids: [id], marker: "*" },
      renderRootId: found.parent?.id ?? id,
    });
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  validate: runValidate,
  rename: runRename,
  "add-card": (ctx) =>
    runInsert(
      ctx,
      () => {
        const type = str(ctx, "type")!;
        checkCardType(type, bool(ctx, "allowUnknownType"));
        atMostOne(ctx, ["configJson", "configFile"]);
        const config = parseConfigFlags(ctx);
        checkConfigAllowed(type, config);
        const node: CardNode = { kind: "card", type };
        if (config !== undefined) node.config = config;
        return node;
      },
      (node) => `insert card "${(node as CardNode).type}"`,
    ),
  "add-group": (ctx) =>
    runInsert(
      ctx,
      () => {
        const node: GroupNode = { kind: "group", children: [] };
        const direction = str(ctx, "direction");
        if (direction !== undefined)
          node.direction = direction as "row" | "column";
        if (bool(ctx, "wrap")) node.wrap = true;
        if (bool(ctx, "heading")) node.heading = true;
        return node;
      },
      () => "insert group",
    ),
  "remove-node": runRemoveNode,
  "move-node": runMoveNode,
  "set-prop": runSetProp,
};

run(cmd, async (ctx) => HANDLERS[ctx.subcommand!](ctx), import.meta.url);
