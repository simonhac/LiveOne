#!/usr/bin/env tsx
/**
 * dashboard — inspect and edit stored dashboard documents (`dashboards.doc`, the v4 node tree)
 * directly in Postgres. See `docs/migrations.md` § "Data & config-document migrations".
 *
 *   MIGRATE_DATABASE_URL="<url>" npm run dashboard -- <command> [options]
 *
 * Commands: list, show, validate, rename, add-card, add-group, remove-node, move-node, set-prop.
 * Run `npm run dashboard -- <command> --help` for each command's options.
 *
 * MUTATIONS ARE DRY-RUN BY DEFAULT. Without `--apply` a mutating command connects, reports what it
 * would change (validated, with a tree preview), and writes nothing.
 *
 * The connection comes from `MIGRATE_DATABASE_URL` and nothing else — deliberately NOT the ambient
 * `PLANETSCALE_DATABASE_URL` (see scripts/ops/dashboard/db.ts for why, including why there is no
 * "am I on prod" auto-detection). Mint a short-TTL role for prod
 * (`pscale role create liveone sydney … --ttl 1h`), pass it here, delete it after. The tool prints
 * `target: database as user @ host` before doing anything: READ THAT LINE before you pass `--apply`.
 *
 * 🛑 Durable edits go to PROD. `dashboards` is a config table the 2-hourly prod→dev sync refreshes,
 * so a dev-only edit is reverted within the hour. Dry-run and rehearse against dev freely; apply the
 * edit you want to keep to prod.
 *
 * Safety properties (all mirroring scripts/utils/migrate-card-type.ts):
 *   - transforms are pure (`lib/dashboard/node-ops.ts`) and unit-tested;
 *   - every new doc must pass `validateDocV4` before it is written; an unknown card `type` is only
 *     accepted with an explicit `--allow-unknown-type`;
 *   - `--area`/`--device` refs are format-checked AND looked up in the target database (this path
 *     bypasses the API's readability check; ownership/grants are deliberately NOT checked — this is
 *     an operator tool). 🛑 Consequences of the bypass: share-token scope is derived from the doc at
 *     read time, so a ref written here on a SHARED dashboard immediately widens anonymous viewers'
 *     scope; and a ref the owner cannot read makes the doc unsaveable via the web editor (every UI
 *     PUT 403s until the ref is removed). A warning is printed on every ref write;
 *   - `n_…` node ids are minted per-document per-ENVIRONMENT (`normalizeDocV4`) and are NOT portable
 *     between prod and dev — the same edit in both means re-running `show` in each;
 *   - each write is its own transaction with `SELECT … FOR UPDATE` and a `revision` bump, mirroring
 *     `updateDashboardDoc` — a concurrent editor's `If-Match` conflicts instead of being clobbered.
 *
 * Exit codes: 0 ok · 1 failure · 2 usage error · 3 document invalid (`validate`).
 */
import fs from "node:fs";
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
  atMostOneOf,
  bool,
  intFlag,
  parseCommandArgs,
  str,
  UsageError,
  type CommandSpec,
  type ParsedArgs,
} from "./args";
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

function printIssues(issues: DocIssue[], severity: string): void {
  for (const i of issues) {
    console.error(`  ${severity} ${i.path}: ${i.message} [${i.code}]`);
  }
}

/** Steps 1–2 of every mutation: v4 guard, stored-doc validation, normalized working copy. */
function loadWorkingDoc(row: DashRow): {
  working: DashboardV4;
  missingIds: number;
} {
  if (!isDashboardV4(row.doc)) {
    throw new Error(`${dashLabel(row)}: doc is not a v4 document`);
  }
  // Validate BEFORE walking: isDashboardV4 checks only version + root.kind, so a doc whose root
  // lacks `children` would make countMissingIds' walk throw a raw TypeError instead of the
  // refusal below. Once the envelope parsed, walking the raw doc is safe.
  const res = validateDocV4(row.doc);
  if (!res.valid) {
    printIssues(res.errors, "error");
    throw new Error(
      `${dashLabel(row)}: stored doc is already invalid — refusing to edit (see \`dashboard validate\`)`,
    );
  }
  const missingIds = countMissingIds(row.doc);
  return { working: res.normalized!, missingIds };
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
 * The warning below is printed on every ref write so neither happens silently.
 */
async function checkRef(
  client: Client,
  kind: "area" | "device",
  value: string,
): Promise<void> {
  const codec = kind === "area" ? Area : Device;
  const uuid = codec.toUuidOrNull(value);
  if (!uuid) {
    throw new UsageError(
      `--${kind}: not a valid ${kind} id (expected ${kind === "area" ? "ar" : "dv"}_…): ${value}`,
    );
  }
  const table = kind === "area" ? "areas" : "devices";
  const res = await client.query(`select 1 from ${table} where id = $1`, [
    uuid,
  ]);
  if (res.rowCount === 0) {
    throw new Error(`--${kind}: no ${kind} ${value} in the target database`);
  }
  console.error(
    `warning: readability of ${value} is NOT checked — on a shared dashboard this ref widens what ` +
      `anonymous viewers can query, and a ref the owner cannot read locks the doc out of the web editor`,
  );
}

/** The unknown-card-type gate — only for the type THIS command introduces. */
function checkCardType(type: string, allowUnknown: boolean): void {
  if (!isKnownCardType(type) && !allowUnknown) {
    throw new Error(
      `"${type}" is not a known card type — pass --allow-unknown-type to write it anyway ` +
        `(it will render as a placeholder)`,
    );
  }
}

/** Parse `--config-json` / `--config-file` (mutually exclusive). `undefined` = not supplied. */
function parseConfigFlags(parsed: ParsedArgs): unknown {
  atMostOneOf(parsed, ["config-json", "config-file", "config"]);
  const inline = str(parsed, "config-json");
  const file = str(parsed, "config-file");
  const raw =
    inline ?? (file !== undefined ? fs.readFileSync(file, "utf8") : undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `--config-${inline !== undefined ? "json" : "file"}: not valid JSON: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/** A known type absent from CARD_CONFIG_SCHEMAS is BARE — it must carry no config at all. */
function checkConfigAllowed(type: string, config: unknown): void {
  if (config === undefined) return;
  if (isKnownCardType(type) && !CARD_CONFIG_SCHEMAS[type]) {
    throw new Error(`card type "${type}" takes no config`);
  }
}

/** `--parent/--index/--before/--after` → a NodePosition. Default: append to the root. */
function parsePositionFlags(
  parsed: ParsedArgs,
  rootId: NodeId,
  required: boolean,
): NodePosition {
  atMostOneOf(parsed, ["index", "before", "after"]);
  const parent = str(parsed, "parent");
  const before = str(parsed, "before");
  const after = str(parsed, "after");
  if (parent !== undefined && (before !== undefined || after !== undefined)) {
    throw new UsageError("--parent combines only with --index");
  }
  if (before !== undefined) return { beforeId: before };
  if (after !== undefined) return { afterId: after };
  const index = intFlag(parsed, "index", 0, 10_000);
  if (parent !== undefined) return { parentId: parent, index };
  if (index !== undefined) return { parentId: rootId, index };
  if (required) {
    throw new UsageError("give a destination: --before, --after, or --parent");
  }
  return { parentId: rootId };
}

function describePosition(pos: NodePosition): string {
  if ("beforeId" in pos) return `before ${pos.beforeId}`;
  if ("afterId" in pos) return `after ${pos.afterId}`;
  return `under ${pos.parentId}${pos.index !== undefined ? ` at index ${pos.index}` : ""}`;
}

/** What a mutating command hands the shared runner. */
interface Mutation {
  /** Transformed (pre-normalize) doc. */
  next: DashboardV4;
  /** e.g. `insert card "solar" under n_3` — the runner prefixes would/WRITE. */
  summary: string;
  /** Highlight a node resolved post-normalize by slot (for inserts, whose ids are minted late). */
  markerSlot?: { parentId: NodeId; index: number; marker: string };
  /** Highlight known node ids. */
  markerIds?: { ids: NodeId[]; marker: string };
  /** Subtree to render for the preview (in the result doc); undefined = whole doc. */
  renderRootId?: NodeId;
  /** Extra preview lines printed before the tree (e.g. the removed subtree). */
  extraLines?: string[];
}

/** Steps 4–7 of every mutation: validate the result, preview, and (with --apply) CAS-write it. */
async function runDocMutation(
  client: Client,
  row: DashRow,
  working: DashboardV4,
  missingIds: number,
  mutation: Mutation,
  apply: boolean,
): Promise<number> {
  const result = validateDocV4(mutation.next);
  if (!result.valid) {
    console.error(`FAIL ${dashLabel(row)}: the edited doc would be invalid:`);
    printIssues(result.errors, "error");
    return 1;
  }
  printIssues(result.warnings, "warning");
  const final = result.normalized ?? mutation.next;

  console.log(
    `${apply ? "WRITE" : "would"} ${mutation.summary} in ${dashLabel(row)}`,
  );
  if (missingIds > 0) {
    console.log(`  (also assigns ${missingIds} missing node id(s))`);
  }

  const markers = new Map<NodeId, string>();
  if (mutation.markerIds) {
    for (const id of mutation.markerIds.ids) {
      markers.set(id, mutation.markerIds.marker);
    }
  }
  if (mutation.markerSlot) {
    const parent = findNode(final, mutation.markerSlot.parentId);
    if (parent && parent.node.kind === "group") {
      const child = parent.node.children[mutation.markerSlot.index];
      if (child?.id) markers.set(child.id, mutation.markerSlot.marker);
    }
  }
  for (const line of mutation.extraLines ?? []) console.log(line);
  console.log(renderDocTree(final, { nodeId: mutation.renderRootId, markers }));

  const before = countCardNodes(working);
  const after = countCardNodes(final);
  if (before !== after) console.log(`cards: ${before} -> ${after}`);

  if (!apply) {
    console.log("Re-run with --apply to write.");
    return 0;
  }
  await writeDoc(client, row, final);
  console.log(`wrote revision ${row.revision + 1}`);
  return 0;
}

/**
 * The shared add-card / add-group flow. The caller supplies only the node-specific flags (via
 * `makeBareNode`) and the summary wording; the envelope flags (`--area`/`--device`/`--hidden`/
 * `--columns`), position parsing, insertion and the preview/write are one implementation, so a fix
 * to the insert path cannot land in one command and miss the other.
 */
async function runInsert(
  parsed: ParsedArgs,
  makeBareNode: (parsed: ParsedArgs) => CardNode | GroupNode,
  summaryOf: (node: CardNode | GroupNode) => string,
): Promise<number> {
  return withClient(async (client) => {
    const apply = bool(parsed, "apply");
    await printTarget(client, apply ? "APPLY" : "dry-run");
    const node = makeBareNode(parsed);
    const area = str(parsed, "area");
    if (area !== undefined) {
      await checkRef(client, "area", area);
      if (Area.is(area)) node.area = area;
    }
    const device = str(parsed, "device");
    if (device !== undefined) {
      await checkRef(client, "device", device);
      if (Device.is(device)) node.device = device;
    }
    if (bool(parsed, "hidden")) node.hidden = true;
    const columns = intFlag(parsed, "columns", 1, 12);
    if (columns !== undefined) node.size = { columns };

    const row = await resolveDashboard(client, parsed.positionals[0]);
    const { working, missingIds } = loadWorkingDoc(row);
    const pos = parsePositionFlags(parsed, working.root.id!, false);
    const res = insertNode(working, node, pos);
    return runDocMutation(
      client,
      row,
      working,
      missingIds,
      {
        next: res.doc,
        summary: `${summaryOf(node)} ${describePosition(pos)}`,
        markerSlot: { parentId: res.parentId, index: res.index, marker: "+" },
        renderRootId: res.parentId,
      },
      apply,
    );
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Command {
  spec: CommandSpec;
  summary: string;
  run(parsed: ParsedArgs): Promise<number>;
}

const POSITION_STRINGS = ["parent", "index", "before", "after"] as const;

const commands: Record<string, Command> = {
  list: {
    summary: "List dashboards (id, owner, name, slug, revision, card count)",
    spec: {
      minPositionals: 0,
      maxPositionals: 0,
      booleans: ["json"],
      strings: ["owner"],
      usage: "dashboard list [--owner=<userId>] [--json]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        await printTarget(client, "read-only");
        const owner = str(parsed, "owner");
        if (owner === "") {
          // An unset shell variable must not silently widen the query to every dashboard.
          throw new UsageError(
            "--owner: empty (omit the flag to list all owners)",
          );
        }
        const rows = await listDashboards(client, owner);
        const entries = rows.map((r) => ({
          id: Dashboard.encode(r.id),
          legacyId: r.legacyId,
          owner: r.ownerUserId,
          name: r.name,
          slug: r.slug,
          revision: r.revision,
          cardCount: isDashboardV4(r.doc) ? countCardNodes(r.doc) : null,
          updatedAt: r.updatedAt.toISOString(),
        }));
        if (bool(parsed, "json")) {
          console.log(JSON.stringify(entries, null, 2));
          return 0;
        }
        for (const e of entries) {
          console.log(
            `${e.id}  rev=${String(e.revision).padEnd(3)} cards=${String(e.cardCount ?? "?").padEnd(3)} ` +
              `legacy=${String(e.legacyId ?? "-").padEnd(4)} owner=${e.owner}  ` +
              `${e.slug ? `slug=${e.slug}  ` : ""}${e.name ?? "(unnamed)"}`,
          );
        }
        console.log(`\n${entries.length} dashboard(s).`);
        return 0;
      }),
  },

  show: {
    summary: "Render a dashboard's node tree (ids are the handles for edits)",
    spec: {
      minPositionals: 1,
      maxPositionals: 1,
      booleans: ["json"],
      strings: ["node"],
      usage: "dashboard show <dash> [--node=<n_id>] [--json]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        await printTarget(client, "read-only");
        const row = await resolveDashboard(client, parsed.positionals[0]);
        const nodeId = str(parsed, "node");
        // Always the NORMALIZED form — the JSON carries the same n_… ids the tree prints, so an
        // id copied from either view addresses the same node in an edit command.
        const { working, missingIds } = loadWorkingDoc(row);
        if (missingIds > 0) {
          console.error(
            `note: ${missingIds} node(s) had no id; ids shown will be persisted by the next write`,
          );
        }
        // An unknown --node is an ERROR in both output modes (renderDocTree's "(no node …)"
        // placeholder with exit 0 read as success to scripted callers).
        if (nodeId !== undefined && !findNode(working, nodeId)) {
          throw new Error(`no node "${nodeId}"`);
        }
        if (bool(parsed, "json")) {
          const out =
            nodeId === undefined ? working : findNode(working, nodeId)!.node;
          console.log(JSON.stringify(out, null, 2));
          return 0;
        }
        console.log(
          `${dashLabel(row)}  owner=${row.ownerUserId}` +
            `${row.slug ? `  slug=${row.slug}` : ""}` +
            `${row.legacyId !== null ? `  legacy=${row.legacyId}` : ""}  cards=${countCardNodes(working)}`,
        );
        console.log(renderDocTree(working, { nodeId }));
        return 0;
      }),
  },

  validate: {
    summary: "Validate a stored dashboard doc, or a doc in a JSON file",
    spec: {
      minPositionals: 0,
      maxPositionals: 1,
      booleans: ["json"],
      strings: ["file"],
      usage: "dashboard validate (<dash> | --file=<path>) [--json]",
    },
    run: async (parsed) => {
      const file = str(parsed, "file");
      const ref = parsed.positionals[0];
      if ((file === undefined) === (ref === undefined)) {
        throw new UsageError("give exactly one of <dash> or --file=<path>");
      }
      let doc: unknown;
      let label: string;
      if (file !== undefined) {
        try {
          doc = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (err) {
          throw new Error(
            `${file}: ${err instanceof Error ? err.message : err}`,
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
      if (bool(parsed, "json")) {
        console.log(
          JSON.stringify(
            {
              valid: result.valid,
              errors: result.errors,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
      } else {
        printIssues(result.errors, "error");
        printIssues(result.warnings, "warning");
        console.log(
          `${label}: ${result.valid ? "valid" : "INVALID"} ` +
            `(${result.errors.length} error(s), ${result.warnings.length} warning(s))`,
        );
      }
      return result.valid ? 0 : 3;
    },
  },

  rename: {
    summary:
      "Change a dashboard's name and/or slug (metadata only, no doc change)",
    spec: {
      minPositionals: 1,
      maxPositionals: 1,
      booleans: ["apply"],
      strings: ["name", "slug"],
      usage:
        "dashboard rename <dash> [--name=<text>|--name=none] [--slug=<slug>|--slug=none] [--apply]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        const apply = bool(parsed, "apply");
        await printTarget(client, apply ? "APPLY" : "dry-run");
        const rawName = str(parsed, "name");
        const rawSlug = str(parsed, "slug");
        if (rawName === undefined && rawSlug === undefined) {
          throw new UsageError("give --name and/or --slug");
        }
        const name =
          rawName === undefined
            ? undefined
            : rawName === "none"
              ? null
              : rawName;
        if (name === "")
          throw new UsageError("--name: empty (use --name=none)");
        let slug: string | null | undefined;
        if (rawSlug !== undefined) {
          slug = rawSlug === "none" ? null : rawSlug;
          if (slug !== null && !isValidAlias(slug)) {
            const suggestion = normalizeAlias(slug);
            throw new UsageError(
              `--slug: "${slug}" is not a valid slug (kebab-case a-z/0-9)` +
                (suggestion ? ` — try --slug=${suggestion}` : ""),
            );
          }
          if (slug === "")
            throw new UsageError("--slug: empty (use --slug=none)");
        }
        const row = await resolveDashboard(client, parsed.positionals[0]);
        console.log(`${apply ? "WRITE" : "would"} rename ${dashLabel(row)}:`);
        if (name !== undefined) {
          console.log(
            `  name: ${JSON.stringify(row.name)} -> ${JSON.stringify(name)}`,
          );
        }
        if (slug !== undefined) {
          console.log(
            `  slug: ${JSON.stringify(row.slug)} -> ${JSON.stringify(slug)}`,
          );
        }
        if (!apply) {
          console.log("Re-run with --apply to write.");
          return 0;
        }
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
          if (isAliasCollision(err)) {
            throw new Error(
              `slug "${slug}" is already used by another of ${row.ownerUserId}'s dashboards`,
            );
          }
          throw err;
        }
        console.log("renamed.");
        return 0;
      }),
  },

  "add-card": {
    summary: "Insert a card node",
    spec: {
      minPositionals: 1,
      maxPositionals: 1,
      booleans: ["apply", "hidden", "allow-unknown-type"],
      strings: [
        "type",
        "config-json",
        "config-file",
        "area",
        "device",
        "columns",
        ...POSITION_STRINGS,
      ],
      usage:
        "dashboard add-card <dash> --type=<type> [--config-json=<json>|--config-file=<path>]\n" +
        "         [--area=ar_…] [--device=dv_…] [--hidden] [--columns=<1-12>]\n" +
        "         [--parent=<n_id>] [--index=<k>|--before=<n_id>|--after=<n_id>]\n" +
        "         [--allow-unknown-type] [--apply]",
    },
    run: (parsed) =>
      runInsert(
        parsed,
        (p) => {
          const type = str(p, "type");
          if (type === undefined) throw new UsageError("--type is required");
          checkCardType(type, bool(p, "allow-unknown-type"));
          const config = parseConfigFlags(p);
          checkConfigAllowed(type, config);
          const node: CardNode = { kind: "card", type };
          if (config !== undefined) node.config = config;
          return node;
        },
        (node) => `insert card "${(node as CardNode).type}"`,
      ),
  },

  "add-group": {
    summary: "Insert an (empty) group node",
    spec: {
      minPositionals: 1,
      maxPositionals: 1,
      booleans: ["apply", "hidden", "wrap", "heading"],
      strings: ["direction", "area", "device", "columns", ...POSITION_STRINGS],
      usage:
        "dashboard add-group <dash> [--direction=row|column] [--wrap] [--heading]\n" +
        "         [--area=ar_…] [--device=dv_…] [--hidden] [--columns=<1-12>]\n" +
        "         [--parent=<n_id>] [--index=<k>|--before=<n_id>|--after=<n_id>] [--apply]",
    },
    run: (parsed) =>
      runInsert(
        parsed,
        (p) => {
          const direction = str(p, "direction");
          if (
            direction !== undefined &&
            direction !== "row" &&
            direction !== "column"
          ) {
            throw new UsageError("--direction must be row or column");
          }
          const node: GroupNode = { kind: "group", children: [] };
          if (direction !== undefined) node.direction = direction;
          if (bool(p, "wrap")) node.wrap = true;
          if (bool(p, "heading")) node.heading = true;
          return node;
        },
        () => "insert group",
      ),
  },

  "remove-node": {
    summary: "Remove a node and its whole subtree",
    spec: {
      minPositionals: 2,
      maxPositionals: 2,
      booleans: ["apply"],
      strings: [],
      usage: "dashboard remove-node <dash> <n_id> [--apply]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        const apply = bool(parsed, "apply");
        await printTarget(client, apply ? "APPLY" : "dry-run");
        const row = await resolveDashboard(client, parsed.positionals[0]);
        const { working, missingIds } = loadWorkingDoc(row);
        const id = parsed.positionals[1];
        const res = removeNode(working, id);
        const removedCards = countCardsInNode(res.removed);
        const removedMarkers = new Map(
          subtreeIds(res.removed).map((n) => [n, "-"] as const),
        );
        return runDocMutation(
          client,
          row,
          working,
          missingIds,
          {
            next: res.doc,
            summary: `remove ${id} (${removedCards} card(s))`,
            extraLines: [
              "removed subtree:",
              renderDocTree(working, { nodeId: id, markers: removedMarkers }),
              "resulting tree:",
            ],
          },
          apply,
        );
      }),
  },

  "move-node": {
    summary: "Move a node (subtree intact, ids preserved)",
    spec: {
      minPositionals: 2,
      maxPositionals: 2,
      booleans: ["apply"],
      strings: [...POSITION_STRINGS],
      usage:
        "dashboard move-node <dash> <n_id> (--before=<n_id>|--after=<n_id>|--parent=<n_id> [--index=<k>]) [--apply]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        const apply = bool(parsed, "apply");
        await printTarget(client, apply ? "APPLY" : "dry-run");
        const row = await resolveDashboard(client, parsed.positionals[0]);
        const { working, missingIds } = loadWorkingDoc(row);
        const id = parsed.positionals[1];
        const pos = parsePositionFlags(parsed, working.root.id!, true);
        const res = moveNode(working, id, pos);
        return runDocMutation(
          client,
          row,
          working,
          missingIds,
          {
            next: res.doc,
            summary: `move ${id} ${describePosition(pos)}`,
            markerIds: { ids: [id], marker: "*" },
            renderRootId: res.parentId,
          },
          apply,
        );
      }),
  },

  "set-prop": {
    summary: "Set/clear a node's envelope props (and, for cards, type/config)",
    spec: {
      minPositionals: 2,
      maxPositionals: 2,
      booleans: ["apply", "allow-unknown-type"],
      strings: [
        "area",
        "device",
        "hidden",
        "columns",
        "direction",
        "wrap",
        "heading",
        "type",
        "config",
        "config-json",
        "config-file",
      ],
      usage:
        "dashboard set-prop <dash> <n_id> [--area=ar_…|none] [--device=dv_…|none]\n" +
        "         [--hidden=true|false|none] [--columns=<1-12>|none]\n" +
        "         [--direction=row|column|none] [--wrap=true|false|none] [--heading=true|false|none]\n" +
        "         [--type=<type>] [--config-json=<json>|--config-file=<path>|--config=none]\n" +
        "         [--allow-unknown-type] [--apply]",
    },
    run: (parsed) =>
      withClient(async (client) => {
        const apply = bool(parsed, "apply");
        await printTarget(client, apply ? "APPLY" : "dry-run");
        const row = await resolveDashboard(client, parsed.positionals[0]);
        const { working, missingIds } = loadWorkingDoc(row);
        const id = parsed.positionals[1];
        const found = findNode(working, id);
        if (!found) throw new Error(`no node "${id}"`);

        const patch: NodePatch = {};
        const tri = (name: "hidden" | "wrap" | "heading"): void => {
          const v = str(parsed, name);
          if (v === undefined) return;
          if (v === "true") patch[name] = true;
          else if (v === "false") patch[name] = false;
          else if (v === "none") patch[name] = null;
          else throw new UsageError(`--${name} must be true, false or none`);
        };
        tri("hidden");
        tri("wrap");
        tri("heading");

        const area = str(parsed, "area");
        if (area !== undefined) {
          if (area === "none") patch.area = null;
          else {
            await checkRef(client, "area", area);
            if (Area.is(area)) patch.area = area;
          }
        }
        const device = str(parsed, "device");
        if (device !== undefined) {
          if (device === "none") patch.device = null;
          else {
            await checkRef(client, "device", device);
            if (Device.is(device)) patch.device = device;
          }
        }
        const rawColumns = str(parsed, "columns");
        if (rawColumns !== undefined) {
          patch.columns =
            rawColumns === "none" ? null : intFlag(parsed, "columns", 1, 12)!;
        }
        const direction = str(parsed, "direction");
        if (direction !== undefined) {
          if (direction === "none") patch.direction = null;
          else if (direction === "row" || direction === "column") {
            patch.direction = direction;
          } else
            throw new UsageError("--direction must be row, column or none");
        }
        const type = str(parsed, "type");
        if (type !== undefined) {
          checkCardType(type, bool(parsed, "allow-unknown-type"));
          patch.type = type;
        }
        // Mutual exclusion FIRST: parseConfigFlags holds the atMostOneOf check, and the
        // --config=none branch skips it — without this, `--config=none --config-json=…` would
        // silently delete the config and drop the supplied JSON.
        atMostOneOf(parsed, ["config", "config-json", "config-file"]);
        const rawConfig = str(parsed, "config");
        if (rawConfig !== undefined && rawConfig !== "none") {
          throw new UsageError(
            "--config only accepts none (use --config-json/--config-file to set)",
          );
        }
        const config = rawConfig === "none" ? null : parseConfigFlags(parsed);
        if (config !== undefined) {
          patch.config = config;
          if (config !== null) {
            const effectiveType =
              patch.type ?? (found.node.kind === "card" ? found.node.type : "");
            checkConfigAllowed(effectiveType, config);
          }
        }
        if (Object.keys(patch).length === 0) {
          throw new UsageError(
            "nothing to change — give at least one property flag",
          );
        }

        const res = setNodeProps(working, id, patch);
        const parentId = found.parent?.id;
        return runDocMutation(
          client,
          row,
          working,
          missingIds,
          {
            next: res.doc,
            summary: `set ${Object.keys(patch).join(", ")} on ${id}`,
            markerIds: { ids: [id], marker: "*" },
            renderRootId: parentId ?? id,
          },
          apply,
        );
      }),
  },
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function globalUsage(): string {
  const lines = Object.entries(commands).map(
    ([name, c]) => `  ${name.padEnd(12)} ${c.summary}`,
  );
  return [
    "usage: MIGRATE_DATABASE_URL=<url> npm run dashboard -- <command> [options]",
    "",
    "commands:",
    ...lines,
    "",
    "Run `npm run dashboard -- <command> --help` for a command's options.",
    "Mutations are DRY-RUN by default; pass --apply to write.",
    "The connection comes from MIGRATE_DATABASE_URL only (prod: a short-TTL `pscale role` url);",
    "`npm run dashboard:dev` reads the dev URL from .env.local and refuses a prod URL.",
    "Read the printed `target:` line before --apply.",
    "🛑 Durable edits go to PROD — the 2-hourly prod→dev sync reverts dev-only dashboard edits.",
    "🛑 n_… node ids are per-environment — never reuse an id from prod against dev or vice versa.",
  ].join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmdName = argv[0];
  if (cmdName === undefined || cmdName === "--help" || cmdName === "-h") {
    console.log(globalUsage());
    return 0;
  }
  const command = commands[cmdName];
  if (!command) {
    throw new UsageError(`unknown command "${cmdName}"\n\n${globalUsage()}`);
  }
  const parsed = parseCommandArgs(argv.slice(1), command.spec);
  if (bool(parsed, "help")) {
    console.log(`usage: ${command.spec.usage}\n\n${command.summary}`);
    return 0;
  }
  return command.run(parsed);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    // Usage errors are exit 2; everything else (NodeOpError included) is a plain failure, exit 1.
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
