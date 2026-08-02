#!/usr/bin/env tsx
/**
 * Rename a card `type` across every stored dashboard document — the migration path a card-type
 * rename in code requires. See `docs/migrations.md` § "Data & config-document migrations".
 *
 *   MIGRATE_DATABASE_URL="<url>" npx tsx scripts/utils/migrate-card-type.ts <old> <new> [--id db_…] [--apply]
 *
 * DRY-RUN BY DEFAULT. Without `--apply` it connects, reports what it would change, and writes nothing.
 *
 * The connection comes from `MIGRATE_DATABASE_URL` and nothing else — deliberately NOT the ambient
 * `PLANETSCALE_DATABASE_URL`, because this script's normal target is PROD and "which database am I
 * pointed at" must never be answered by whatever happens to be in `.env.local`. Mint a short-TTL role
 * (`pscale role create liveone sydney … --ttl 1h`), pass it here, delete it after. The script prints
 * `database as user @ host` before doing anything: read that line before you pass `--apply`.
 *
 * It deliberately does NOT try to auto-detect "am I on prod". The usual `PLANETSCALE_PROD_BRANCH_ID`
 * check matches the branch id inside a `postgres.<branch-id>` username, but a freshly minted
 * `pscale role` connects as `pscale_api_…` and carries no branch id — so the check would report a
 * confident "not prod" for the exact connection this script is normally pointed at. A false
 * reassurance is worse than none; the printed identity is the check.
 *
 * 🛑 Fix PROD, not dev. `dashboards` is a config table the 2-hourly prod→dev sync refreshes, so a
 * dev-only edit is reverted within the hour. Dry-run against dev freely; apply to prod.
 *
 * Safety properties:
 *   - the rewrite is pure (`lib/dashboard/migrate-card-type.ts`) and idempotent;
 *   - every rewritten doc must pass `validateDocV4`, and must NOT still warn `unknown-card-type` for
 *     the new name — a typo'd target is caught before it is written, not after;
 *   - each write is its own transaction with `SELECT … FOR UPDATE` and a `revision` bump, mirroring
 *     `updateDashboardDoc` — so a concurrent editor's `If-Match` conflicts instead of clobbering.
 */
import { Client } from "pg";
import { rewriteCardType } from "@/lib/dashboard/migrate-card-type";
import { isDashboardV4 } from "@/lib/dashboard/v4";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { Dashboard } from "@/lib/ids";

interface Args {
  from: string;
  to: string;
  onlyId?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [from, to] = positional;
  if (!from || !to) {
    throw new Error(
      "usage: migrate-card-type.ts <old-type> <new-type> [--id db_…] [--apply]",
    );
  }
  const idFlag = flags.find((f) => f.startsWith("--id="));
  const unknown = flags.find((f) => f !== "--apply" && !f.startsWith("--id="));
  if (unknown) throw new Error(`unknown flag ${unknown}`);
  return {
    from,
    to,
    onlyId: idFlag?.slice("--id=".length),
    apply: flags.includes("--apply"),
  };
}

async function connect(): Promise<Client> {
  const raw = process.env.MIGRATE_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "set MIGRATE_DATABASE_URL to the connection string of the database to migrate",
    );
  }
  // `pg` rejects the PlanetScale ssl params; strip them exactly as getPoolConfig does for the pool.
  const u = new URL(raw);
  for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    u.searchParams.delete(p);
  }
  const client = new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connect();
  try {
    const who = await client.query("select current_user, current_database()");
    console.log(
      `target: ${who.rows[0].current_database} as ${who.rows[0].current_user} @ ${client.host}`,
    );
    console.log(
      `rename: "${args.from}" -> "${args.to}"   mode: ${
        args.apply ? "APPLY" : "dry-run"
      }\n`,
    );

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
      const { doc, changed } = rewriteCardType(row.doc, args.from, args.to);
      if (changed.length === 0) continue;

      const result = validateDocV4(doc);
      if (!result.valid) {
        console.error(`  FAIL ${label}: rewritten doc is invalid`);
        for (const e of result.errors)
          console.error(`       ${e.path}: ${e.message}`);
        skipped++;
        continue;
      }
      // The whole point of the rename is that the new type RENDERS. If it is still unknown, the
      // target name is wrong (or unregistered) and writing it would just move the grey box.
      const stillUnknown = result.warnings.some(
        (w) =>
          w.code === "unknown-card-type" && w.message.includes(`"${args.to}"`),
      );
      if (stillUnknown) {
        console.error(
          `  FAIL ${label}: "${args.to}" is not a known card type — refusing to write`,
        );
        skipped++;
        continue;
      }

      console.log(`  ${args.apply ? "WRITE" : "would write"} ${label}`);
      for (const path of changed) console.log(`       ${path}`);
      touched++;

      if (!args.apply) continue;
      await client.query("begin");
      try {
        // Mirrors `updateDashboardDoc`: lock, bump the revision (the ETag/If-Match token), write.
        const locked = await client.query<{ revision: number }>(
          "select revision from dashboards where id = $1 for update",
          [row.id],
        );
        if (locked.rows[0]?.revision !== row.revision) {
          throw new Error(
            `revision moved under us (${row.revision} -> ${locked.rows[0]?.revision}); re-run`,
          );
        }
        await client.query(
          "update dashboards set doc = $1, revision = revision + 1, updated_at = now() where id = $2",
          [JSON.stringify(result.normalized ?? doc), row.id],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
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
