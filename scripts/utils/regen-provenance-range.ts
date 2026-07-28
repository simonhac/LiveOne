/**
 * Step 2 of the Sigenergy repair (see `rebuild-sigenergy-readings.ts`): drop an area's learned
 * battery-provenance params and re-derive 1d + provenance over a range.
 *
 * The learned params (eta / capacity / charge-efficiency / idle loss) live in
 * `battery_provenance_daily`, fitted from the battery series. After a sign correction they were
 * fitted to INVERTED data — on the live case eta came back 0.708 against a plausible ~0.95 — and
 * `loadProvenanceInputs` reads them back in preference to re-learning, so they must be deleted or
 * the corrected fold keeps consuming garbage. `aggregateRange` then re-learns and rebuilds
 * `point_readings_flow_attr_1d` from the corrected 5m data.
 *
 * Usage: npx tsx --env-file=.env.local scripts/utils/regen-provenance-range.ts <areaUuid> <from> <to>
 */
import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { aggregateRange } from "@/lib/aggregation/daily-points";
import { parseDateISO } from "@/lib/date-utils";

async function main() {
  const [areaId, from, to] = process.argv.slice(2);
  if (!areaId || !from || !to) {
    console.error(
      "usage: regen-sigen-range.ts <areaUuid> <YYYY-MM-DD> <YYYY-MM-DD>",
    );
    process.exit(1);
  }
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection");

  const del = await db.execute(
    sql`delete from battery_provenance_daily where area_id = ${areaId}::uuid`,
  );
  console.log(
    `Cleared battery_provenance_daily rows for area ${areaId}: ${del.rowCount ?? "?"}`,
  );

  console.log(`Aggregating ${from} → ${to} …`);
  await aggregateRange(parseDateISO(from), parseDateISO(to));
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
