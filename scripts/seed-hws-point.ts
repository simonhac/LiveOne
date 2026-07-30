#!/usr/bin/env tsx
/**
 * Register HWS modelling for a device: the derived `load.hws/temperature` point AND the
 * `hws-model` derivation that turns it on.
 *
 * Since config-v4 Phase 11 the point alone is not enough — the derivations cron discovers an
 * enabled `hws-model` row (lib/derivations/resolve.ts) and models into that point's generic agg_5m
 * rows. Both steps are idempotent; no new table, just a point_info row and a derivations row.
 *
 * SAFETY: defaults to a DRY RUN. Pass --apply to write. The DB target is whatever .env.local
 * points at. ⚠️ tsx scripts need `--env-file=.env.local` (the planetscaleDb singleton is an IIFE
 * evaluated at import, before the script's own dotenv.config runs).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts                # list candidate devices
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts --device=6     # dry run for device 6
 *   npx tsx --env-file=.env.local scripts/seed-hws-point.ts --device=6 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "../lib/db/planetscale";
import { devices, points } from "../lib/db/planetscale/schema";
import {
  ensureHwsDerivation,
  ensureHwsTemperaturePoint,
} from "../lib/hws/register";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const deviceArg = process.argv.find((a) => a.startsWith("--system="));
const systemId = deviceArg ? parseInt(deviceArg.split("=")[1], 10) : null;

async function main() {
  const db = requirePlanetscaleDb();

  if (systemId === null) {
    const candidates = await db
      .select({ systemId: devices.rid })
      .from(points)
      .innerJoin(devices, eq(devices.id, points.deviceId))
      .where(
        and(eq(points.logicalPath, "load.hws"), eq(points.metricType, "power")),
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
  } else if (APPLY) {
    console.log(
      `${tag} system ${systemId}: registered load.hws/temperature (point ${res.tempPointId}, power ${res.powerPointId}).`,
    );
  } else {
    console.log(
      `${tag} system ${systemId}: would register load.hws/temperature (power ${res.powerPointId}). Pass --apply to write.`,
    );
  }

  // The derivation is what actually enables modelling. On a dry run the point may not exist yet,
  // so this can legitimately report "no-points" — it resolves once the point is applied.
  const dv = await ensureHwsDerivation(systemId, APPLY);
  switch (dv.status) {
    case "exists":
      console.log(
        `${tag}   hws-model derivation present (${dv.derivationId}).`,
      );
      break;
    case "created":
      console.log(
        `${tag}   ${APPLY ? "created" : "would create"} hws-model derivation ${dv.derivationId}.`,
      );
      break;
    case "no-area":
      console.error(
        `${tag}   ⚠️ system ${systemId} has no resolvable area — the derivation cannot be placed.`,
      );
      process.exitCode = 1;
      break;
    case "no-points":
      console.log(
        `${tag}   (temperature point not written yet — re-run with --apply to create the derivation.)`,
      );
      break;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
