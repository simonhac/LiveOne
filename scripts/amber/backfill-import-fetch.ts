#!/usr/bin/env tsx
/**
 * Amber import backfill — PHASE 1 of 2: OBTAIN
 *
 * Fetches Amber `/usage` records for a system over a date range and writes the RAW
 * records to disk (one JSON file per chunk). Reads Amber's API and the system's
 * credentials (Clerk); writes NOTHING to our store. Safe and re-runnable. The saved
 * JSON is the sole input to phase 2 (`backfill-import-insert.ts`).
 *
 * Why: `derivePointKey` collapsed import (E1) and export (B1) onto one key, so the
 * grid-import price/cost/energy channels (system 9, points 2/7/8) went dead
 * 2025-11-26. See docs/incidents/2025-11-26-amber-import-channel-collision.md.
 *
 * ⚠️ Reads PROD credentials (Clerk holds the Amber apiKey). Run with prod env; the
 *    Amber account is the same regardless of NODE_ENV, so this phase is read-only.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/amber/backfill-import-fetch.ts --start=2026-06-01 --end=2026-06-07
 *   npx tsx --env-file=.env.local scripts/amber/backfill-import-fetch.ts   # full window → yesterday
 *   npx tsx --env-file=.env.local scripts/amber/backfill-import-fetch.ts --out=.context/amber-backfill --chunk=7
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import * as path from "path";
import type { CalendarDate } from "@internationalized/date";
import { SystemsManager } from "../../lib/systems-manager";
import { getSystemCredentials } from "../../lib/secure-credentials";
import { fetchAmberUsage } from "../../lib/vendors/amber/client";
import { parseDateISO, getYesterdayInTimezone } from "../../lib/date-utils";
import type { AmberCredentials } from "../../lib/vendors/amber/types";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

const SYSTEM_ID = Number(arg("system") ?? 9);
const CHUNK = Number(arg("chunk") ?? 7);
const OUT_DIR = arg("out") ?? ".context/amber-backfill";
const START = arg("start") ?? "2025-11-26"; // bug onset (import cost/energy died)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const system = await SystemsManager.getInstance().getSystem(SYSTEM_ID);
  if (!system) throw new Error(`System ${SYSTEM_ID} not found`);
  if (system.vendorType !== "amber")
    throw new Error(`System ${SYSTEM_ID} is '${system.vendorType}', not amber`);
  if (!system.ownerClerkUserId)
    throw new Error(`System ${SYSTEM_ID} has no owner (need Clerk creds)`);

  const base = await getSystemCredentials(system.ownerClerkUserId, system.id);
  if (!base?.apiKey) throw new Error(`No Amber apiKey for system ${SYSTEM_ID}`);
  const credentials: AmberCredentials = {
    apiKey: base.apiKey,
    siteId: system.vendorSiteId || undefined,
  };

  const start = parseDateISO(START);
  const endArg = arg("end");
  const end = endArg
    ? parseDateISO(endArg)
    : getYesterdayInTimezone(system.timezoneOffsetMin ?? 600);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `[fetch] system ${SYSTEM_ID} (${system.vendorSiteId}) ${start.toString()} .. ${end.toString()} ` +
      `in ${CHUNK}-day chunks → ${OUT_DIR}`,
  );

  let cursor: CalendarDate = start;
  let totalRecords = 0;
  let chunkCount = 0;
  while (cursor.compare(end) <= 0) {
    // Shrink the final chunk so cursor+(days-1) never overshoots `end`
    // (relies only on compare's sign, not its magnitude).
    let days = CHUNK;
    while (days > 1 && cursor.add({ days: days - 1 }).compare(end) > 0) days--;
    const lastDay = cursor.add({ days: days - 1 });

    let records;
    try {
      records = await fetchAmberUsage(credentials, cursor, days);
    } catch (err) {
      console.error(
        `[fetch] ERROR ${cursor.toString()} +${days}d: ` +
          `${err instanceof Error ? err.message : String(err)} — resume with --start=${cursor.toString()}`,
      );
      throw err;
    }

    const outPath = path.join(
      OUT_DIR,
      `usage-${cursor.toString()}-${days}d.json`,
    );
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          systemId: SYSTEM_ID,
          firstDay: cursor.toString(),
          numberOfDays: days,
          fetchedAt: new Date().toISOString(),
          records,
        },
        null,
        2,
      ),
    );
    totalRecords += records.length;
    chunkCount++;
    console.log(
      `[fetch] ${cursor.toString()}..${lastDay.toString()} → ${records.length} records → ${path.basename(outPath)}`,
    );

    cursor = cursor.add({ days });
    await sleep(300); // polite pacing for Amber /usage
  }

  console.log(
    `[fetch] done: ${chunkCount} chunk file(s), ${totalRecords} records total → ${OUT_DIR}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
