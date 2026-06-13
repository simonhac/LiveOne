#!/usr/bin/env tsx
/**
 * Register the derived hot-water temperature point (`load.hws/temperature`) for a system.
 *
 * This is the entire "config" for HWS modelling: once the point exists, the minutely cron's
 * reconcile + the daily heal start producing modelled temperature into its generic agg_5m rows
 * (lib/hws/recompute.ts). No new table — it's a normal point_info row in the existing system.
 *
 * SAFETY: defaults to a DRY RUN. Pass --apply to write. The DB target is whatever .env.local
 * points at. ⚠️ tsx scripts need `--env-file=.env.local` (the planetscaleDb singleton is an IIFE
 * evaluated at import, before the script's own dotenv.config runs).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts                # list candidate systems
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts --system=6     # dry run for system 6
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts --system=6 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "../lib/db/planetscale";
import { pointInfo } from "../lib/db/planetscale/schema";
import { ensureHwsTemperaturePoint } from "../lib/hws/register";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const systemArg = process.argv.find((a) => a.startsWith("--system="));
const systemId = systemArg ? parseInt(systemArg.split("=")[1], 10) : null;

async function main() {
  const db = requirePlanetscaleDb();

  if (systemId === null) {
    const candidates = await db
      .select({ systemId: pointInfo.systemId })
      .from(pointInfo)
      .where(
        and(
          eq(pointInfo.logicalPathStem, "load.hws"),
          eq(pointInfo.metricType, "power"),
        ),
      );
    const ids = [...new Set(candidates.map((c) => c.systemId))].sort(
      (a, b) => a - b,
    );
    console.log(
      `${tag} systems with a 'load.hws' power point: ${ids.join(", ") || "(none)"}`,
    );
    console.log(
      "Re-run with --system=<id> [--apply] to register its temperature point.",
    );
    return;
  }

  const res = await ensureHwsTemperaturePoint(systemId, APPLY);
  if (res.status === "no-power-point") {
    console.error(
      `${tag} system ${systemId} has no 'load.hws' power point — cannot register a temperature point.`,
    );
    process.exitCode = 1;
    return;
  }
  if (res.status === "exists") {
    console.log(
      `${tag} system ${systemId}: temperature point already exists (point ${res.tempPointId}, power ${res.powerPointId}).`,
    );
    return;
  }
  // created
  if (APPLY) {
    console.log(
      `${tag} system ${systemId}: registered load.hws/temperature (point ${res.tempPointId}, power ${res.powerPointId}).`,
    );
  } else {
    console.log(
      `${tag} system ${systemId}: would register load.hws/temperature (power ${res.powerPointId}). Pass --apply to write.`,
    );
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
