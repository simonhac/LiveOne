/**
 * The `dashboard` domain of the `liveone` CLI — inspect and edit stored dashboard documents
 * (`dashboards.doc`, the v4 node tree).
 *
 * A COMPOSABLE module, not an entrypoint: it exports the spec and a dispatcher, and
 * `scripts/ops/liveone.ts` mounts it. That is what lets one CLI carry several domains
 * (`liveone dashboard show`, and later `liveone device …`) instead of one npm script per domain.
 * Deliberately no `run()` here — a module with an entrypoint cannot be composed, and importing it
 * would execute it.
 *
 * Driven by the shared harness in `lib/cli/`, so it gets arity-aware parsing, `--help` at every
 * level, `--format human|json`, the dry-by-default write gate, the exit-code vocabulary and
 * stdout/stderr separation for free — and a future MCP server renders its tool list from this same
 * declaration (`lib/cli/tool-schema.ts`).
 *
 * See `docs/migrations.md` § "Data & config-document migrations".
 */
import fs from "node:fs";
import { z } from "zod";
import { Area, Device } from "@/lib/ids";
import { isValidAlias, normalizeAlias } from "@/lib/dashboard/alias";
import {
  CARD_CONFIG_SCHEMAS,
  isKnownCardType,
} from "@/lib/dashboard/card-types";
import {
  countCardNodes,
  countCardsInNode,
  isDashboardV4,
  walkNodes,
  type CardNode,
  type DashboardV4,
  type GroupNode,
  type NodeId,
} from "@/lib/dashboard/v4";
import { validateDocV4, type DocIssue } from "@/lib/dashboard/v4-validate";
import {
  countMissingIds,
  findNode,
  insertNode,
  moveNode,
  remintNodeIds,
  removeNode,
  setNodeProps,
  subtreeIds,
  type NodePatch,
  type NodePosition,
} from "@/lib/dashboard/node-ops";
import { NodeOpError } from "@/lib/dashboard/node-ops";
import { renderDocTree } from "@/lib/dashboard/v4-tree-text";
import {
  defineCommand,
  failWith,
  kebab,
  EXIT,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { DocInvalidError } from "@/lib/cli-kit/http";
import {
  dashLabelLike as dashLabel,
  withTransport,
  type DashboardTransport,
  type DashRowLike as DashRow,
} from "./transport";

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
      "run `liveone dashboard validate` for the full list — refusing to edit a doc that is already broken",
    );
  return { working: res.normalized!, missingIds: countMissingIds(row.doc) };
}

/**
 * Pre-check an `--area`/`--device` ref where the transport can (db: existence query + the
 * scope-widening warning). Over http there is deliberately NO pre-check: the PUT's server-side
 * `checkDocRefsReadable` verifies existence AND readability, which is strictly stronger — a bad
 * ref surfaces as the mapped 403/422 instead.
 */
async function checkRef(
  t: DashboardTransport,
  kind: "area" | "device",
  value: string,
): Promise<void> {
  if (t.checkRef) await t.checkRef(kind, value);
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
  /** e.g. `insert card "solar" under n_VX15` — the runner prefixes would/WRITE. */
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
  t: DashboardTransport,
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

  let newRevision = row.revision + 1;
  if (!ctx.dryRun) {
    try {
      newRevision = (await t.writeDoc(row, final)).revision;
    } catch (err) {
      // Local validation passed but the server refused — the deployed build's schemas may be
      // older than this checkout. Surface its issues in the house format.
      if (err instanceof DocInvalidError)
        throw failWith(
          EXIT.FINDINGS,
          `${dashLabel(row)}: the SERVER rejected the edited doc`,
          issueLines(err.rejection.errors, "error").join("\n").trim(),
          "the deployed build may predate this card type/config — deploy first, or use --via=db",
        );
      throw err;
    }
  }

  ctx.emit(
    {
      dashboard: {
        id: row.id,
        name: row.name,
        revision: ctx.dryRun ? row.revision : newRevision,
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
          ? `wrote revision ${newRevision}`
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
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const node = makeBareNode();
    const area = str(ctx, "area");
    if (area !== undefined) {
      await checkRef(t, "area", area);
      if (Area.is(area)) node.area = area;
    }
    const device = str(ctx, "device");
    if (device !== undefined) {
      await checkRef(t, "device", device);
      if (Device.is(device)) node.device = device;
    }
    if (bool(ctx, "hidden")) node.hidden = true;
    const columns = num(ctx, "columns");
    if (columns !== undefined) node.size = { columns };

    const row = await t.resolve(ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const pos = parsePositionFlags(ctx, working.root.id!, false);
    const res = insertNode(working, node, pos);
    return runDocMutation(ctx, t, row, working, missingIds, {
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
  help: "A dashboard: its db_… id or its slug",
} as const;

const NODE_ARG = {
  name: "node",
  required: true,
  help: "The n_… id of the node, as printed by `show`",
} as const;

/**
 * Transport selection, on EVERY verb. `http` is the default — the deployed API, as you, via
 * `liveone auth login`. `db` is explicit-only and keeps its own credential story
 * (MIGRATE_DATABASE_URL / the liveone:dev fallback); an ambient env var never silently chooses
 * the target.
 */
const TRANSPORT_FLAGS = {
  via: {
    type: "string",
    values: ["http", "db"],
    default: "http",
    help: "How to reach the data: the deployed API (http) or Postgres directly (db)",
  },
  baseUrl: {
    type: "string",
    placeholder: "origin",
    help: "http only: target origin (default: your stored default, else https://www.liveone.energy)",
  },
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

export const dashboardCommand = defineCommand({
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
  uses: ["db", "api"],
  subcommands: {
    list: {
      name: "list",
      summary:
        "List dashboards: id, owner, name, slug, revision and card count.",
      when: "Start here when you do not yet know a dashboard's id.",
      flags: {
        ...TRANSPORT_FLAGS,
        owner: {
          type: "string",
          placeholder: "userId",
          help: "Only this owner's dashboards",
        },
      },
      examples: [
        "liveone dashboard list",
        "liveone dashboard list --format json",
      ],
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
        ...TRANSPORT_FLAGS,
        node: {
          type: "string",
          placeholder: "n_id",
          help: "Render only this node's subtree",
        },
      },
      examples: [
        "liveone dashboard show kink",
        "liveone dashboard show db_01kyf18tp3e5brm474zf0fzvkm --node=n_2XRX",
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
        ...TRANSPORT_FLAGS,
        file: {
          type: "string",
          placeholder: "path",
          help: "Validate this JSON file instead of a stored dashboard",
        },
      },
      exitCodes: { 1: "the document is invalid" },
      examples: [
        "liveone dashboard validate kink",
        "liveone dashboard validate --file=doc.json",
      ],
    },

    rename: {
      name: "rename",
      summary:
        "Change a dashboard's name and/or slug. Metadata only — the doc is untouched.",
      when: "Use this for the dashboard's own name or its /dashboard/{user}/{slug} shortname.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
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
        "liveone dashboard rename kink --slug=kinkora",
        "liveone dashboard rename kink --name='Kinkora' --apply",
      ],
    },

    "add-card": {
      name: "add-card",
      summary: "Insert a card node.",
      when: "Use this to put a new card on a dashboard; `add-group` makes a container instead.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
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
        "liveone dashboard add-card kink --type=heatmap --device=dv_01kybrhzkmfyxvz63d15rscj19 --after=n_2VF4",
        'liveone dashboard add-card kink --type=chart --config-json=\'{"variant":"lines"}\' --apply',
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
        ...TRANSPORT_FLAGS,
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
        "liveone dashboard add-group kink --direction=row --wrap --after=n_CBEX",
        "liveone dashboard add-group kink --area=ar_01kx8km3a3fh5v2csryvhskzep --heading --apply",
      ],
    },

    "remove-node": {
      name: "remove-node",
      summary: "Remove a node and its whole subtree.",
      when: "Removes the node AND everything under it — check `show` first if it is a group.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "liveone dashboard remove-node kink n_5CKF",
        "liveone dashboard remove-node kink n_5CKF --apply",
      ],
    },

    "remint-ids": {
      name: "remint-ids",
      summary: "Re-mint every node id in a document (one-time migration).",
      when:
        "A MIGRATION, not an edit: run it once per document to move ids off the retired sequential\n" +
        "form (n_0, n_1, …) onto the random form. Every id changes, so any id noted from an earlier\n" +
        "`show` stops resolving — which is the point, because a sequential id could be RECYCLED onto\n" +
        "a different node after a removal. Structure, refs and config are untouched.",
      mutates: true,
      args: [DASH_ARG],
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "liveone dashboard remint-ids db_01kyf18tp3e5brm474zf0fzvkm",
        "liveone dashboard remint-ids db_01kyf18tp3e5brm474zf0fzvkm --apply",
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
      flags: { ...TRANSPORT_FLAGS, ...POSITION_FLAGS },
      examples: [
        "liveone dashboard move-node kink n_FS02 --before=n_E7Z1",
        "liveone dashboard move-node kink n_FS02 --parent=n_CBEX --index=0 --apply",
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
        ...TRANSPORT_FLAGS,
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
        "liveone dashboard set-prop kink n_VX15 --columns=6",
        "liveone dashboard set-prop kink n_VX15 --hidden=none --apply",
      ],
    },
    history: {
      name: "history",
      summary:
        "The dashboard's edit history — who changed it, when, revision by revision.",
      when:
        "Run this before `restore`, and any time an edit surprises you. Every write records a\n" +
        "post-image row, so revision N here IS version N of the document.",
      description:
        "savedBy is a provenance string, not always a person: routes record the caller's Clerk\n" +
        "userId, the CLI records `cli`, scripts `script:<name>`, and the backfill `backfill`.\n" +
        "History is per-environment — the prod→dev sync deliberately does not carry it.",
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        limit: {
          type: "number",
          default: 20,
          schema: z.number().int().min(1).max(500),
          hint: "1–500",
          help: "How many revisions to show, newest first",
        },
      },
      exitCodes: { 1: "no history recorded (run backfill-history)" },
      examples: [
        "liveone dashboard history kink",
        "liveone dashboard history kink --limit=5",
      ],
    },
    restore: {
      name: "restore",
      summary:
        "Restore a recorded revision — as a NEW revision, never a counter rewind.",
      when:
        "The undo. Find the revision with `history`, preview the restore dry, then --apply. The\n" +
        "restore itself is recorded, so history shows what happened and is itself restorable.",
      description:
        "The recorded doc is re-validated against TODAY'S card vocabulary before writing — a\n" +
        "months-old snapshot may name a type this build no longer knows, and restoring it blindly\n" +
        "would write a grey box. A doc that no longer validates is refused with its issues.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        revision: {
          type: "number",
          required: true,
          schema: z.number().int().min(1),
          hint: "a revision number from `history`",
          help: "The recorded revision to restore",
        },
      },
      examples: [
        "liveone dashboard restore kink --revision=3",
        "liveone dashboard restore kink --revision=3 --apply",
      ],
    },
    "backfill-history": {
      name: "backfill-history",
      summary:
        "Seed a history row for every dashboard whose current revision has none.",
      when:
        "Run ONCE per environment after the revisions writers land, so `restore` has a floor for\n" +
        "documents that predate them. Idempotent — a dashboard already recorded is skipped.",
      description:
        "db transport only: it writes rows the API deliberately has no endpoint for (history is\n" +
        "server-written, not client-supplied). Rows are inserted with savedBy=backfill at each\n" +
        "dashboard's CURRENT revision, ON CONFLICT DO NOTHING.",
      mutates: true,
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "npm run liveone:dev -- dashboard backfill-history",
        "liveone dashboard backfill-history --via=db --apply",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runList(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget("read-only");
    const owner = str(ctx, "owner");
    if (owner === "")
      // An unset shell variable must not silently widen the query to every owner.
      throw usage(
        "--owner=",
        "the value is empty",
        "omit the flag to list every owner, or pass a real user id",
      );
    const dashboards = await t.list(owner);
    ctx.emit({ count: dashboards.length, dashboards }, (m: never) => {
      const model = m as { count: number; dashboards: typeof dashboards };
      return [
        ...model.dashboards.map(
          (e) =>
            `${e.id}  rev=${String(e.revision).padEnd(3)} cards=${String(e.cardCount ?? "?").padEnd(3)} ` +
            // db lists every owner; http lists the CALLER's reachable set, tagged by access.
            `${e.owner !== undefined ? `owner=${e.owner}` : `access=${e.access}`}  ` +
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
  return withTransport(ctx, async (t) => {
    await t.describeTarget("read-only");
    const row = await t.resolve(ctx.args[0]);
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
        "run `liveone dashboard show <dash>` for the current ids — they are per-environment",
      );
    const subtree = nodeId ? findNode(working, nodeId)!.node : working.root;
    ctx.emit(
      {
        dashboard: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          owner: row.owner ?? null,
          revision: row.revision,
          cards: countCardNodes(working),
        },
        // The normalized doc (or the requested subtree) — the same tree the human sees.
        doc: nodeId ? subtree : working,
      },
      () =>
        [
          `${dashLabel(row)}${row.owner ? `  owner=${row.owner}` : ""}` +
            `${row.slug ? `  slug=${row.slug}` : ""}` +
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
    const row = await withTransport(ctx, async (t) => {
      await t.describeTarget("read-only");
      return t.resolve(ref!);
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
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
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

    const row = await t.resolve(ctx.args[0]);
    const changes: Record<string, unknown> = {};
    if (name !== undefined) changes.name = { from: row.name, to: name };
    if (slug !== undefined) changes.slug = { from: row.slug, to: slug };

    if (!ctx.dryRun) {
      // The transport owns the write: db = direct UPDATE with the alias-collision mapping,
      // http = PATCH (the 409 mapper renders the same refusal).
      const patch: { name?: string | null; slug?: string | null } = {};
      if (name !== undefined) patch.name = name;
      if (slug !== undefined) patch.slug = slug;
      await t.patchMeta(row, patch);
    }

    ctx.emit(
      {
        dashboard: { id: row.id, name: row.name },
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
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const row = await t.resolve(ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const res = removeNode(working, id);
    const removedMarkers = new Map(
      subtreeIds(res.removed).map((n) => [n, "-"] as const),
    );
    return runDocMutation(ctx, t, row, working, missingIds, {
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

/**
 * Re-mint every node id. Deliberately whole-document and one dashboard at a time: there is no
 * `--all`, because each run must be read and confirmed against the tree it prints.
 */
async function runRemintIds(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const row = await t.resolve(ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const next = remintNodeIds(working);

    // The old→new map, in document order, so the change is auditable line by line. Both walks visit
    // the same tree in the same order, so the two id lists correspond positionally.
    const before: NodeId[] = [];
    const after: NodeId[] = [];
    walkNodes(working, (n) => before.push(n.id!));
    walkNodes(next, (n) => after.push(n.id!));

    return runDocMutation(ctx, t, row, working, missingIds, {
      next,
      action: `re-mint ${before.length} node id(s)`,
      markerIds: { ids: after, marker: "~" },
      extraLines: [
        "id map:",
        ...before.map((id, i) => `  ${id} → ${after[i]}`),
        "resulting tree:",
      ],
    });
  });
}

async function runMoveNode(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const row = await t.resolve(ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const pos = parsePositionFlags(ctx, working.root.id!, true);
    const res = moveNode(working, id, pos);
    return runDocMutation(ctx, t, row, working, missingIds, {
      next: res.doc,
      action: `move ${id} ${describePosition(pos)}`,
      markerIds: { ids: [id], marker: "*" },
      renderRootId: res.parentId,
    });
  });
}

async function runSetProp(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const row = await t.resolve(ctx.args[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const id = ctx.args[1];
    const found = findNode(working, id);
    if (!found)
      throw failWith(
        EXIT.FINDINGS,
        `no node "${id}"`,
        "this document has no node with that id",
        "run `liveone dashboard show <dash>` for the current ids",
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
        await checkRef(t, "area", area);
        if (Area.is(area)) patch.area = area;
      }
    }
    const device = str(ctx, "device");
    if (device !== undefined) {
      if (device === "none") patch.device = null;
      else {
        await checkRef(t, "device", device);
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
        "run `liveone dashboard set-prop --help` for the list",
      );

    const res = setNodeProps(working, id, patch);
    return runDocMutation(ctx, t, row, working, missingIds, {
      next: res.doc,
      action: `set ${Object.keys(patch).join(", ")} on ${id}`,
      markerIds: { ids: [id], marker: "*" },
      renderRootId: found.parent?.id ?? id,
    });
  });
}

async function runHistory(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget("read-only");
    const row = await t.resolve(ctx.args[0]);
    const limit = (ctx.flags.limit as number | undefined) ?? 20;
    const revisions = await t.history(row, limit);
    ctx.emit(
      {
        dashboard: { id: row.id, name: row.name, revision: row.revision },
        revisions,
      },
      (m: never) => {
        const model = m as {
          revisions: Array<{
            revision: number;
            savedBy: string;
            savedAt: string;
          }>;
        };
        if (!model.revisions.length)
          return `No history recorded for ${dashLabel(row)} — run \`liveone dashboard backfill-history\`.`;
        return [
          `${dashLabel(row)}:`,
          ...model.revisions.map(
            (r) =>
              `  r${String(r.revision).padEnd(4)} ${r.savedAt}  ${r.savedBy}` +
              (r.revision === row.revision ? "  <- current" : ""),
          ),
        ].join("\n");
      },
    );
    return revisions.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function runRestore(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    const row = await t.resolve(ctx.args[0]);
    const revision = ctx.flags.revision as number;
    if (revision === row.revision)
      throw usage(
        `--revision=${revision}`,
        "that IS the current revision — restoring it would change nothing",
        "pick an earlier revision from `liveone dashboard history`",
      );
    const rec = await t.getRevision(row, revision);
    if (!rec)
      throw failWith(
        EXIT.FINDINGS,
        `no revision ${revision} recorded for ${dashLabel(row)}`,
        "history only reaches back to when the writers (or the backfill) started recording",
        "run `liveone dashboard history` to see what exists",
      );
    // Re-validate under TODAY'S vocabulary: a snapshot may predate a card-type change, and
    // restoring it blindly would write a grey box.
    const result = validateDocV4(rec.doc);
    if (!result.valid)
      throw failWith(
        EXIT.FINDINGS,
        `revision ${revision} no longer validates`,
        issueLines(result.errors, "error").join("\n").trim(),
        "it predates a schema change — restore a newer revision, or repair via --via=db",
      );
    const { working, missingIds } = loadWorkingDoc(row);
    return runDocMutation(ctx, t, row, working, missingIds, {
      next: result.normalized!,
      action: `restore revision ${revision} (saved ${rec.savedAt} by ${rec.savedBy})`,
    });
  });
}

async function runBackfillHistory(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    if (!t.backfillHistory)
      throw usage(
        "--via=http",
        "the backfill writes history rows directly, and the API deliberately has no endpoint for that",
        "re-run with --via=db (dev: `npm run liveone:dev -- dashboard backfill-history`)",
      );
    const { inserted, skipped } = await t.backfillHistory(!ctx.dryRun);
    ctx.emit({ applied: !ctx.dryRun, inserted, skipped }, (m: never) => {
      const model = m as {
        applied: boolean;
        inserted: string[];
        skipped: string[];
      };
      return [
        ...model.inserted.map(
          (l) => `  ${model.applied ? "SEEDED" : "would seed"} ${l}`,
        ),
        ...model.skipped.map((l) => `  skip (already recorded) ${l}`),
        `${model.inserted.length} seeded, ${model.skipped.length} already recorded.`,
        ...(model.applied || !model.inserted.length
          ? []
          : ["Re-run with --apply to write."]),
      ].join("\n");
    });
    return EXIT.OK;
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
  "remint-ids": runRemintIds,
  "move-node": runMoveNode,
  "set-prop": runSetProp,
  history: runHistory,
  restore: runRestore,
  "backfill-history": runBackfillHistory,
};

/**
 * Run whichever `dashboard` verb was selected. Reads the LAST element of the path, because under
 * `liveone` the path is `["dashboard", "<verb>"]`.
 */
export async function runDashboard(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw failWith(
      EXIT.USAGE,
      `unknown dashboard command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- dashboard --help`",
    );
  try {
    return await handler(ctx);
  } catch (err) {
    // A structural refusal (no such node, root-immutable, cycle, …) is a FINDING about the
    // caller's request, not an upstream failure. Without this, classify() mapped NodeOpError to
    // exit 5 with a "re-run with LIVEONE_DEBUG" hint — misleading for what is a clean refusal.
    if (err instanceof NodeOpError)
      throw failWith(
        EXIT.FINDINGS,
        err.message,
        `the requested edit is not structurally possible (${err.code})`,
        "run `liveone dashboard show <dash>` and pick a valid target",
      );
    throw err;
  }
}
