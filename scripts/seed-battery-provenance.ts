#!/usr/bin/env tsx
/**
 * Seed + run the battery-provenance PROD DRIVER on the dev mirror (path a). The recompute ensures the
 * Area's HELPER device, registers the 3 derived blend points on it, binds them into the Area, and writes
 * a window into their agg_5m + KV latest. DRY-RUN by default; pass --apply to write. Target DB = whatever
 * .env.local points at (liveone-dev; prod has no stored URL).
 *
 * Usage:
 *   npx tsx scripts/seed-battery-provenance.ts --system=8 --start=2025-10-25 --end=2025-11-05
 *   npx tsx scripts/seed-battery-provenance.ts --system=8 --start=2025-10-25 --end=2025-11-05 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
if (
  !process.env.PLANETSCALE_DATABASE_URL &&
  process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS
) {
  process.env.PLANETSCALE_DATABASE_URL =
    process.env.PLANETSCALE_DATABASE_URL_MIGRATIONS;
}

import { and, eq, sql } from "drizzle-orm";
import { planetscaleDb } from "../lib/db/planetscale";
import { pointReadingsAgg5m } from "../lib/db/planetscale/schema";
import { loadProvenanceInputs } from "../lib/battery-provenance/load";
import { recomputeBatteryProvenanceForWindow } from "../lib/db/planetscale/battery-provenance-pg";

const argOf = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const APPLY = process.argv.includes("--apply");
const SYSTEM = Number(argOf("system"));
const START = argOf("start");
const END = argOf("end");

async function main() {
  const db = planetscaleDb;
  if (!db) throw new Error("No Postgres connection.");
  const [id]: any =
    (
      await db.execute(
        sql`select current_user as usr, current_database() as dbname`,
      )
    ).rows ?? [];
  console.log(
    `[DB] ${id?.usr}@${id?.dbname}  ${APPLY ? "[APPLY]" : "[DRY-RUN]"}`,
  );
  if (!SYSTEM || !START || !END) {
    console.log(
      "Pass --system=<handle> --start=YYYY-MM-DD --end=YYYY-MM-DD [--apply]",
    );
    return;
  }
  const winStartMs = Date.parse(`${START}T00:00:00Z`);
  const winEndMs = Date.parse(`${END}T23:59:59Z`);

  const inputs = await loadProvenanceInputs(SYSTEM, {
    startMs: winStartMs,
    endMs: winEndMs,
  });
  if (!inputs || inputs.batterySystemId == null) {
    console.log("No battery-bearing Area for that handle.");
    return;
  }
  console.log(
    `handle ${SYSTEM} → area ${inputs.areaId}, battery device ${inputs.batterySystemId}, ${inputs.timeline.length} intervals`,
  );

  if (!APPLY) {
    console.log(
      "Dry run — would ensure a HELPER device for the Area, register 3 blend points on it, bind them into the Area, and write the window. Pass --apply.",
    );
    return;
  }

  const r = await recomputeBatteryProvenanceForWindow(
    db,
    SYSTEM,
    winStartMs,
    winEndMs,
    {
      updateLatest: true,
      writeRollup: true,
    },
  );
  console.log(
    `helper device ${r.helperSystemId}; wrote ${r.rowsWritten} agg_5m rows; points ${JSON.stringify(r.pointIds)}`,
  );
  for (const [metric, pid] of Object.entries(r.pointIds)) {
    const [row]: any = await db
      .select({
        n: sql<number>`count(*)`,
        last: sql<string>`max(${pointReadingsAgg5m.intervalEnd})`,
      })
      .from(pointReadingsAgg5m)
      .where(
        and(
          eq(pointReadingsAgg5m.systemId, r.helperSystemId!),
          eq(pointReadingsAgg5m.pointId, pid),
        ),
      );
    console.log(
      `  bidi.battery/${metric} (helper ${r.helperSystemId}.${pid}): ${row.n} rows, last ${row.last}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
