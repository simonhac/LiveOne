#!/usr/bin/env tsx
/**
 * Amber import backfill — PHASE 2 of 2: INSERT
 *
 * Reads the raw `/usage` JSON saved by `backfill-import-fetch.ts` and stores ONLY the
 * import (E1) readings — grid-import price/cost/energy → points 2/7/8 — into
 * `point_readings_agg_5m`, via the normal 5m-native path:
 *   buildRecordsMapFromAmber → storeRecordsLocally → insertPointReadingsAgg5m →
 *   publishObservationBatch → QStash → /api/observations/receive (single writer,
 *   idempotent UPSERT on (system_id, point_id, interval_end)).
 * Export (B1), spot and renewables are NOT re-written (no churn).
 *
 * ⚠️ DRY-RUN BY DEFAULT. Pass --apply to publish. Apply WRITES TO PROD.
 * ⚠️ Run with NODE_ENV=production + prod env (prod DB + prod OBSERVATIONS_QSTASH_TOKEN),
 *    else observations route to the DEV pipeline (see lib/qstash.ts). The canary must
 *    confirm rows actually land in PROD point_readings_agg_5m.
 * ⚠️ Requires the derivePointKey fix to be present in this code (it is, on this branch),
 *    otherwise the build step would re-collapse E1/B1.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/amber/backfill-import-insert.ts --in=.context/amber-backfill
 *   NODE_ENV=production npx tsx --env-file=.env.local scripts/amber/backfill-import-insert.ts --in=.context/amber-backfill --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import * as path from "path";
import { uuidv7 } from "uuidv7";
import { parseDateISO } from "../../lib/date-utils";
import {
  groupRecordsByTime,
  buildRecordsMapFromAmber,
  storeRecordsLocally,
} from "../../lib/vendors/amber/client";
import { AmberReadingsBatch } from "../../lib/vendors/amber/amber-readings-batch";
import type { SessionInfo } from "../../lib/point/point-manager";
import type { AmberUsageRecord } from "../../lib/vendors/amber/types";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
const SYSTEM_ID = Number(arg("system") ?? 9);
const IN_DIR = arg("in") ?? ".context/amber-backfill";
const IMPORT_PREFIX = "E1/"; // import (general) channel — E1/perKwh, E1/cost, E1/kwh

interface ChunkFile {
  systemId: number;
  firstDay: string;
  numberOfDays: number;
  fetchedAt: string;
  records: AmberUsageRecord[];
}

async function main() {
  if (!fs.existsSync(IN_DIR))
    throw new Error(
      `Input dir not found: ${IN_DIR} (run backfill-import-fetch.ts first)`,
    );
  const files = fs
    .readdirSync(IN_DIR)
    .filter((f) => f.startsWith("usage-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No usage-*.json files in ${IN_DIR}`);

  const session: SessionInfo = {
    id: uuidv7(),
    started: new Date(),
    label: "amber-import-backfill",
  };

  console.log(
    `${tag} import (E1) readings for system ${SYSTEM_ID} from ${files.length} chunk file(s) in ${IN_DIR}`,
  );
  if (APPLY) {
    const routing = process.env.NODE_ENV === "production" ? "PROD" : "DEV (!)";
    console.log(
      `${tag} NODE_ENV=${process.env.NODE_ENV} → observations route to the ${routing} queue`,
    );
  }

  let totalImport = 0;
  const perPoint: Record<string, number> = {};

  for (const file of files) {
    const chunk = JSON.parse(
      fs.readFileSync(path.join(IN_DIR, file), "utf8"),
    ) as ChunkFile;
    if (chunk.systemId !== SYSTEM_ID) {
      console.warn(
        `  skip ${file}: systemId ${chunk.systemId} != ${SYSTEM_ID}`,
      );
      continue;
    }

    const firstDay = parseDateISO(chunk.firstDay);
    const grouped = groupRecordsByTime(chunk.records);
    const fullBatch = buildRecordsMapFromAmber(
      grouped,
      firstDay,
      chunk.numberOfDays,
    );

    // Filter to import (E1) readings only — never re-write export/spot/renewables.
    const importBatch = new AmberReadingsBatch(firstDay, chunk.numberOfDays);
    let chunkImport = 0;
    for (const pointMap of fullBatch.getRecords().values()) {
      for (const reading of pointMap.values()) {
        if (reading.pointMetadata.physicalPathTail.startsWith(IMPORT_PREFIX)) {
          importBatch.add(reading);
          chunkImport++;
          const key = reading.pointMetadata.physicalPathTail;
          perPoint[key] = (perPoint[key] ?? 0) + 1;
        }
      }
    }

    if (APPLY && chunkImport > 0) {
      await storeRecordsLocally(
        SYSTEM_ID,
        session,
        importBatch,
        "amber-import-backfill",
        undefined, // no collector → publish this chunk immediately
      );
    }

    totalImport += chunkImport;
    console.log(
      `${tag} ${chunk.firstDay} +${chunk.numberOfDays}d → ${chunkImport} import readings ` +
        `${APPLY ? "published" : "(would publish)"}`,
    );
  }

  console.log(
    `${tag} done: ${totalImport} import readings across ${files.length} chunk(s)`,
  );
  for (const [k, v] of Object.entries(perPoint).sort())
    console.log(`  ${k.padEnd(12)} ${v}`);
  if (!APPLY)
    console.log(
      "Dry run — pass --apply (with NODE_ENV=production + prod env) to publish to prod.",
    );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
