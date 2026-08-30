#!/usr/bin/env tsx
/**
 * Add the `generator` tile to every stored dashboard whose bound area actually has a generator
 * LiveOne can command — the data half of shipping the tile.
 *
 *   MIGRATE_DATABASE_URL="<url>" npx tsx scripts/utils/add-generator-tile.ts [--id db_…] [--apply]
 *
 * DRY-RUN BY DEFAULT. Without `--apply` it connects, reports what it would change, writes nothing.
 *
 * WHY A SCRIPT AT ALL. A dashboard document is DATA, not code (CLAUDE.md § "A rename is only half a
 * change when documents persist the old name"). Registering a new tile type makes it *renderable*;
 * it does not put it on anyone's dashboard, because the layout lives in `dashboards.doc`. The
 * capability catalog only governs what the SEED lays out for a NEW dashboard — every existing one
 * has to be migrated, and this is that migration.
 *
 * 🛑 Fix PROD, not dev. `dashboards` is a config table the 2-hourly prod→dev sync refreshes, so a
 * dev-only edit reverts within the hour. Dry-run against dev freely; apply to prod.
 *
 * The connection comes from `MIGRATE_DATABASE_URL` and nothing else — deliberately NOT the ambient
 * `PLANETSCALE_DATABASE_URL`, because this script's normal target is PROD and "which database am I
 * pointed at" must never be answered by whatever happens to be in `.env.local`. It prints
 * `database as user @ host` before doing anything: read that line before you pass `--apply`.
 * (It does not try to auto-detect prod, for the reason `migrate-card-type.ts` documents: a freshly
 * minted `pscale role` carries no branch id, so the usual check would confidently say "not prod".)
 *
 * Safety properties, all mirroring `migrate-card-type.ts`:
 *   - ELIGIBILITY IS READ FROM THE DATABASE, never assumed: only an area that owns an active
 *     `source.generator.control.request/duration` point gets the tile, which is exactly the
 *     `generator/control` capability the catalog requires. A dashboard for a generator LiveOne can
 *     only watch is left alone, because a Start button there would be a lie;
 *   - IDEMPOTENT: a row that already holds a `generator` card is skipped, so re-running is a no-op;
 *   - the tile is inserted at its `TILE_ORDER` position, so the migrated row matches what the seed
 *     would lay out for a fresh dashboard;
 *   - every rewritten doc must pass `validateDocV4` before it is written;
 *   - each write is its own transaction with `SELECT … FOR UPDATE` and a `revision` bump, mirroring
 *     `updateDashboardDoc` — a concurrent editor's `If-Match` conflicts instead of being clobbered.
 */
// Connection + identity print + CAS write are the dashboard CLI's shared plumbing — one
// implementation of the "mirrors updateDashboardDoc" transaction, not three hand-kept copies.
import { connect, printTarget, writeDoc } from "../ops/dashboard/db";
import { TILE_ORDER } from "@/lib/capabilities/catalog";
import { isTileViewType } from "@/lib/dashboard/card-types";
import {
  isDashboardV4,
  type DashboardNode,
  type DashboardV4,
  type GroupNode,
} from "@/lib/dashboard/v4";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { Area, Dashboard } from "@/lib/ids";

const TILE_TYPE = "generator";
/** The point whose presence IS the `generator/control` capability (lib/capabilities/registry.ts). */
const CONTROL_STEM = "source.generator.control.request";
const CONTROL_METRIC = "duration";

interface Args {
  onlyId?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = argv.filter((a) => a.startsWith("--"));
  const idFlag = flags.find((f) => f.startsWith("--id="));
  const unknown = flags.find((f) => f !== "--apply" && !f.startsWith("--id="));
  if (unknown) throw new Error(`unknown flag ${unknown}`);
  return {
    onlyId: idFlag?.slice("--id=".length),
    apply: flags.includes("--apply"),
  };
}

/** Where a `generator` card belongs among the tiles already in a row. */
function insertionIndex(children: DashboardNode[]): number {
  const rank = (type: string): number => {
    const i = TILE_ORDER.indexOf(type as (typeof TILE_ORDER)[number]);
    // A non-catalog tile (`oe-grid`) or a non-tile card sorts to the end, which is where the seed
    // appends `oe-grid` too — so the generator lands before it, as TILE_ORDER intends.
    return i === -1 ? TILE_ORDER.length : i;
  };
  const mine = rank(TILE_TYPE);
  const at = children.findIndex((c) => {
    if (c.kind !== "card") return true; // a nested group ends the run of tiles
    return rank(c.type) > mine;
  });
  return at === -1 ? children.length : at;
}

/**
 * A tile row: a `row` group whose children are ALL tile-view cards (§8.1) — the only place a tile
 * belongs.
 */
function isTileRow(node: DashboardNode): node is GroupNode {
  return (
    node.kind === "group" &&
    node.direction === "row" &&
    node.children.length > 0 &&
    node.children.every((c) => c.kind === "card" && isTileViewType(c.type))
  );
}

/**
 * Visit every node with the area scope it inherits — the same downward inheritance the renderer
 * applies (`childContext` in components/dashboard/v4/node-view.tsx).
 */
function eachNode(
  node: DashboardNode,
  area: string | null,
  visit: (node: DashboardNode, area: string | null) => void,
): void {
  const scope = (node.area ? Area.toUuidOrNull(node.area) : null) ?? area;
  visit(node, scope);
  if (node.kind === "group") {
    for (const c of node.children) eachNode(c, scope, visit);
  }
}

/**
 * Insert the tile into ONE tile row per eligible area. Returns the new doc plus a human-readable
 * path per insertion. Pure — the caller decides whether to write it.
 *
 * 🛑 ONE ROW PER AREA, and idempotency is judged over the WHOLE area subtree, not per row. Both
 * real dashboards carry two `row` groups under one area — the main tile row, and a trailing row
 * holding `renewables` alone — and both match `isTileRow`. Inserting into each would give the area
 * two generator tiles; checking "does THIS row already have one" would add a second on every re-run.
 */
function addGeneratorTile(
  doc: DashboardV4,
  eligibleAreaUuids: ReadonlySet<string>,
): { doc: DashboardV4; inserted: string[] } {
  const inserted: string[] = [];

  // Pass 1 — which areas already show the tile anywhere in their subtree. An area bound to no
  // area at all (`null`) is never eligible, so it needs no entry.
  const alreadyHave = new Set<string>();
  eachNode(doc.root, null, (node, area) => {
    if (area && node.kind === "card" && node.type === TILE_TYPE) {
      alreadyHave.add(area);
    }
  });

  // Pass 2 — insert into the FIRST tile row of each remaining eligible area, in document order.
  const filled = new Set<string>();
  function walk(
    node: DashboardNode,
    area: string | null,
    path: string,
  ): DashboardNode {
    const scope = (node.area ? Area.toUuidOrNull(node.area) : null) ?? area;
    if (node.kind !== "group") return node;

    // Decide BEFORE recursing, so sibling rows are considered in document order: the main tile row
    // precedes the trailing `renewables` row, and it is the one a user expects the tile in.
    let children = node.children;
    if (
      isTileRow(node) &&
      scope &&
      eligibleAreaUuids.has(scope) &&
      !alreadyHave.has(scope) &&
      !filled.has(scope)
    ) {
      const at = insertionIndex(children);
      children = [
        ...children.slice(0, at),
        // No `id`: `normalizeDocV4` assigns one, the same way the seed's nodes get theirs.
        { kind: "card", type: TILE_TYPE } as DashboardNode,
        ...children.slice(at),
      ];
      filled.add(scope);
      inserted.push(`${path} (position ${at}, area ${Area.encode(scope)})`);
    }

    return {
      ...node,
      children: children.map((c, i) => walk(c, scope, `${path}/${c.id ?? i}`)),
    } as GroupNode;
  }

  return {
    doc: { ...doc, root: walk(doc.root, null, "root") as GroupNode },
    inserted,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connect();
  try {
    await printTarget(client, args.apply ? "APPLY" : "dry-run");
    console.log(`add tile: "${TILE_TYPE}"\n`);

    // Eligibility, straight from the data: which areas have a commandable generator.
    const areas = await client.query<{ id: string; name: string }>(
      `select distinct a.id, a.name
         from areas a
         join area_members m on m.area_id = a.id
         join devices d      on d.id = m.device_id
         join points p       on p.device_id = d.id
        where p.logical_path = $1 and p.metric_type = $2 and p.active
        order by a.name`,
      [CONTROL_STEM, CONTROL_METRIC],
    );
    if (areas.rowCount === 0) {
      console.log(
        `No area has an active ${CONTROL_STEM}/${CONTROL_METRIC} point — nothing to do.`,
      );
      return;
    }
    console.log("eligible areas:");
    for (const a of areas.rows) {
      console.log(`  ${a.name} (${Area.encode(a.id)})`);
    }
    console.log("");
    const eligible = new Set(areas.rows.map((r) => r.id));

    const onlyUuid = args.onlyId ? Dashboard.toUuidOrNull(args.onlyId) : null;
    if (args.onlyId && !onlyUuid) {
      throw new Error(`--id: not a dashboard id: ${args.onlyId}`);
    }
    const rows = await client.query<{
      id: string;
      name: string;
      revision: number;
      doc: unknown;
    }>(
      `select id, name, revision, doc from dashboards
        ${onlyUuid ? "where id = $1" : ""}
        order by name`,
      onlyUuid ? [onlyUuid] : [],
    );

    let touched = 0;
    let skipped = 0;
    for (const row of rows.rows) {
      const label = `${row.name} (${Dashboard.encode(row.id)}, rev ${row.revision})`;
      if (!isDashboardV4(row.doc)) {
        console.warn(`  SKIP ${label}: doc is not a v4 document`);
        skipped++;
        continue;
      }
      const { doc, inserted } = addGeneratorTile(row.doc, eligible);
      if (inserted.length === 0) continue;

      const result = validateDocV4(doc);
      if (!result.valid) {
        console.error(`  FAIL ${label}: rewritten doc is invalid`);
        for (const e of result.errors)
          console.error(`       ${e.path}: ${e.message}`);
        skipped++;
        continue;
      }
      // The whole point is that the tile RENDERS. If the doc still warns that the type is unknown,
      // this build does not know it and writing it would just add a grey box.
      const stillUnknown = result.warnings.some(
        (w) =>
          w.code === "unknown-card-type" &&
          w.message.includes(`"${TILE_TYPE}"`),
      );
      if (stillUnknown) {
        console.error(
          `  FAIL ${label}: "${TILE_TYPE}" is not a known card type — refusing to write`,
        );
        skipped++;
        continue;
      }

      console.log(`  ${args.apply ? "WRITE" : "would write"} ${label}`);
      for (const path of inserted) console.log(`       ${path}`);
      touched++;

      if (!args.apply) continue;
      await writeDoc(
        client,
        row,
        result.normalized ?? doc,
        "script:add-generator-tile",
      );
    }

    console.log(
      `\n${touched} dashboard(s) ${args.apply ? "updated" : "would change"}, ${skipped} skipped, ${rows.rowCount} scanned.`,
    );
    if (touched > 0 && !args.apply) {
      console.log("Re-run with --apply to write.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
