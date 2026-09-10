/**
 * The `dashboard` domain's shared plumbing: issue rendering, node addressing, doc reads and the
 * read-modify-write envelope every editing verb goes through.
 *
 * Split out of `cli.ts` so the command tree and the verbs can each be read on their own.
 */
import fs from "node:fs";
import { Area, Device } from "@/lib/ids";
import {
  CARD_CONFIG_SCHEMAS,
  isKnownCardType,
} from "@/lib/dashboard/card-types";
import {
  countCardNodes,
  isDashboardV4,
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
  type NodePosition,
} from "@/lib/dashboard/node-ops";
import { renderDocTree } from "@/lib/dashboard/v4-tree-text";
import { bool, failWith, num, str, EXIT, type Ctx } from "@/lib/cli/cli";
import { DocInvalidError } from "@/lib/cli-kit/http";
import { atMostOne, usage } from "../shared";
import {
  dashLabelLike as dashLabel,
  withTransport,
  type DashboardTransport,
  type DashRowLike as DashRow,
} from "./transport";

export const issueLines = (issues: DocIssue[], severity: string): string[] =>
  issues.map((i) => `  ${severity} ${i.path}: ${i.message} [${i.code}]`);

/** v4 guard, stored-doc validation, normalized working copy. */
export function loadWorkingDoc(row: DashRow): {
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
export async function checkRef(
  t: DashboardTransport,
  kind: "area" | "device",
  value: string,
): Promise<void> {
  if (t.checkRef) await t.checkRef(kind, value);
}

/** The unknown-card-type gate — only for the type THIS command introduces. */
export function checkCardType(type: string, allowUnknown: boolean): void {
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
export function parseConfigFlags(ctx: Ctx): unknown {
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
export function checkConfigAllowed(type: string, config: unknown): void {
  if (config === undefined) return;
  if (isKnownCardType(type) && !CARD_CONFIG_SCHEMAS[type])
    throw usage(
      `config for card type "${type}"`,
      `"${type}" takes no config`,
      "drop the --config-* flag, or set a type that accepts one",
    );
}

/** `--parent/--index/--before/--after` → a NodePosition. Default: append to the root. */
export function parsePositionFlags(
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

export function describePosition(pos: NodePosition): string {
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
export async function runDocMutation(
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
export async function runInsert(
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
