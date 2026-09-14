#!/usr/bin/env tsx
/**
 * Move the three OpenElectricity market signals from the `grid.*` logical-path namespace into
 * `bidi.grid.*` — the DATA half of the code change in `lib/vendors/openelectricity/point-metadata.ts`.
 *
 *   MIGRATE_DATABASE_URL="<url>" npx tsx scripts/utils/rename-oe-grid-stems.ts [--revert] [--apply]
 *
 * DRY-RUN BY DEFAULT. Without `--apply` it connects, reports exactly which rows it would change, and
 * writes nothing. `--revert` maps the other way, so the change is reversible in one command.
 *
 *   grid.emissionsIntensity → bidi.grid.emissionsIntensity
 *   grid.price              → bidi.grid.spot
 *   grid.renewables         → bidi.grid.renewables
 *   grid.demand             → UNCHANGED, deliberately (see the point-metadata header)
 *
 * **Why the code alone does not do this.** `ensurePointInfo` short-circuits on an existing point
 * (keyed by `physical_path`, which does not change here) and `mintPoint`'s `ON CONFLICT DO UPDATE`
 * SET clause does not include `logical_path`. So a stored row is neither healed by the new code nor
 * reverted by the old — the two halves are independent, and this script is the whole data half.
 *
 * **No history moves.** `points.id` is a uuidv5 over `(vendor, vendorSiteId, physicalPathTail)` and
 * readings key on `point_rid`, so neither identity depends on the logical path. This is a rename of
 * a label, not a re-addressing of a series.
 *
 * **Afterwards, rebuild the KV cache** — the subscription registry and the `latest` map are keyed by
 * `logicalPath/metricType`, so they carry the old keys until rebuilt:
 *   dev:  npx tsx scripts/utils/rebuild-dev-kv-from-db.ts
 *   prod: npx tsx scripts/build-subscription-registry.ts
 *
 * Connection handling, and why there is no automatic prod check, is
 * `scripts/ops/dashboard/db.ts` — the identity line printed before any work IS the check.
 */
import { connect, printTarget } from "../ops/dashboard/db";

/** old → new. The single source of truth for the new names is point-metadata.ts; they are restated
 *  as literals here because this script must also be able to name the OLD ones, which no longer
 *  exist in code. */
const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["grid.emissionsIntensity", "bidi.grid.emissionsIntensity"],
  ["grid.price", "bidi.grid.spot"],
  ["grid.renewables", "bidi.grid.renewables"],
];

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.find((a) => a !== "--apply" && a !== "--revert");
  if (unknown) {
    throw new Error(
      `unknown argument ${unknown}\n` +
        "usage: rename-oe-grid-stems.ts [--revert] [--apply]",
    );
  }
  const apply = argv.includes("--apply");
  const revert = argv.includes("--revert");
  const pairs = revert
    ? RENAMES.map(([from, to]) => [to, from] as const)
    : RENAMES;

  const client = await connect();
  try {
    await printTarget(
      client,
      `${revert ? "revert" : "rename"} ${apply ? "APPLY" : "dry-run"}`,
    );

    // Scope: the OpenElectricity devices only. The stems are distinctive, but `bidi.grid.renewables`
    // and `bidi.grid.spot` are ALSO Amber's — so on the revert leg an unscoped UPDATE would drag
    // Amber's points into the retired `grid.*` namespace. Scoping both legs keeps the pair
    // symmetric, which is what makes --revert an honest inverse.
    const before = await client.query<{
      rid: number;
      vendor_site_id: string | null;
      logical_path: string | null;
      metric_type: string;
      unit: string | null;
    }>(
      `SELECT d.rid, d.vendor_site_id, p.logical_path, p.metric_type, p.unit
         FROM points p JOIN devices d ON d.id = p.device_id
        WHERE d.vendor = 'openelectricity'
        ORDER BY d.rid, p.logical_path`,
    );
    console.log(`OpenElectricity points found: ${before.rows.length}`);
    for (const r of before.rows) {
      const target = pairs.find(([from]) => from === r.logical_path)?.[1];
      const note = target ? `→ ${target}` : "(unchanged)";
      console.log(
        `  rid ${r.rid} ${r.vendor_site_id}  ${r.logical_path}/${r.metric_type} [${r.unit}]  ${note}`,
      );
    }

    let changed = 0;
    // One transaction for all six rows: a half-renamed device is a state no reader is written for
    // (the battery-provenance loader would find emissions and silently miss renewables).
    await client.query("BEGIN");
    try {
      for (const [from, to] of pairs) {
        const res = await client.query(
          `UPDATE points p
              SET logical_path = $2, updated_at = now()
             FROM devices d
            WHERE d.id = p.device_id
              AND d.vendor = 'openelectricity'
              AND p.logical_path = $1`,
          [from, to],
        );
        const n = res.rowCount ?? 0;
        changed += n;
        console.log(`  ${from} → ${to}: ${n} row(s)`);
      }
      if (apply) {
        await client.query("COMMIT");
        console.log(`\nApplied. ${changed} row(s) renamed.`);
        console.log(
          "Now rebuild the KV cache — the `latest` map still carries the old keys.",
        );
      } else {
        await client.query("ROLLBACK");
        console.log(
          `\nDry run — rolled back. ${changed} row(s) would be renamed. Re-run with --apply to write.`,
        );
      }
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
