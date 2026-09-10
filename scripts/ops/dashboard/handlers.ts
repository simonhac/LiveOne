/**
 * The `dashboard` verbs, and the dispatcher that selects one.
 */
import fs from "node:fs";
import { Area, Device } from "@/lib/ids";
import { isValidAlias, normalizeAlias } from "@/lib/dashboard/alias";
import {
  countCardNodes,
  countCardsInNode,
  walkNodes,
  type CardNode,
  type GroupNode,
  type NodeId,
} from "@/lib/dashboard/v4";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import {
  findNode,
  moveNode,
  remintNodeIds,
  removeNode,
  setNodeProps,
  subtreeIds,
  type NodePatch,
} from "@/lib/dashboard/node-ops";
import { NodeOpError } from "@/lib/dashboard/node-ops";
import { renderDocTree } from "@/lib/dashboard/v4-tree-text";
import { bool, failWith, str, EXIT, type Ctx } from "@/lib/cli/cli";
import { atMostOne, usage } from "../shared";
import { dashLabelLike as dashLabel, withTransport } from "./transport";
import {
  checkCardType,
  checkConfigAllowed,
  checkRef,
  describePosition,
  issueLines,
  loadWorkingDoc,
  parseConfigFlags,
  parsePositionFlags,
  runDocMutation,
  runInsert,
} from "./plumbing";
import { SHARING_HANDLERS } from "./sharing";

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

/**
 * Copy a dashboard through `POST /api/v4/dashboards`. Ids are stripped client-side so the server
 * re-mints them — reusing the source's ids would let a stale note about the source address nodes
 * in the copy, which is exactly the recycled-id hazard remint-ids exists to kill.
 */
async function runDuplicate(ctx: Ctx): Promise<number> {
  return withTransport(ctx, async (t) => {
    await t.describeTarget(ctx.dryRun ? "dry-run" : "APPLY");
    if (!t.create)
      throw usage(
        "--via=db",
        "duplicate creates through the API's POST (validation, ref readability, slug rules)",
        "re-run with --via=http",
      );
    const name = str(ctx, "name")!;
    if (name === "")
      throw usage(
        "--name=",
        "an empty name is not a name",
        "pass a display name",
      );
    const slug = str(ctx, "slug");
    if (slug !== undefined && !isValidAlias(slug)) {
      const suggestion = normalizeAlias(slug);
      throw usage(
        `"${slug}" for --slug`,
        "a slug is kebab-case: lowercase a-z/0-9 joined by single hyphens",
        suggestion ? `try --slug=${suggestion}` : "pick a kebab-case shortname",
      );
    }

    const row = await t.resolve(ctx.args[0]);
    const { working } = loadWorkingDoc(row);
    const doc = structuredClone(working);
    walkNodes(doc, (n) => {
      delete (n as { id?: NodeId }).id;
    });

    let created: { id: string; revision: number } | undefined;
    if (!ctx.dryRun) created = await t.create({ name, slug, doc });

    ctx.emit(
      {
        source: { id: row.id, name: row.name, revision: row.revision },
        name,
        slug: slug ?? null,
        cards: countCardNodes(working),
        applied: !ctx.dryRun,
        ...(created ?? {}),
      },
      () =>
        [
          `${ctx.dryRun ? "would" : "WRITE"} duplicate ${dashLabel(row)} as "${name}"${slug ? ` (slug=${slug})` : ""}`,
          renderDocTree(working, {}),
          created
            ? `created ${created.id} at revision ${created.revision} — node ids were re-minted; run \`show\` on the copy`
            : "Re-run with --apply to create it.",
        ].join("\n"),
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
  duplicate: runDuplicate,
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
  // 🛑 Keyed on the FULL path under `dashboard`, not its last element: `share list` and `link list`
  // share one, and dispatching on it would route a grant read to a share-link read.
  const path = ctx.subcommandPath.slice(1);
  const verb = path[path.length - 1] ?? "";
  const handler = SHARING_HANDLERS[path.join(".")] ?? HANDLERS[verb];
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
