#!/usr/bin/env tsx
/**
 * Seed run-tracking for the generator (run-tracking feature).
 *
 *   1. roles            — upsert the `generator` row from lib/roles/registry.ts (FK target for
 *                         device_trackers.role / device_run_periods.role).
 *   2. device_trackers   — upsert one generator tracker for a system: signal = its grid power
 *                          point (display_name 'Grid'), lowerW=-50 (on when importing > 50W),
 *                          energy = its 'Import' energy point, delay_off=120s. Reproduces the
 *                          legacy generator-events definition, now config-driven + persisted.
 *
 * Idempotent (role upserted on conflict; tracker upserted on (system_id, role)).
 *
 * SAFETY: defaults to a DRY RUN (prints what it found / would write). Pass --apply to write.
 * The DB target is whatever .env.local points at.
 *
 * Usage:
 *   npx tsx scripts/seed-generator-tracker.ts                 # list candidate systems (dry run)
 *   npx tsx scripts/seed-generator-tracker.ts --system=1      # dry run for system 1
 *   npx tsx scripts/seed-generator-tracker.ts --system=1 --apply
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "../lib/db/planetscale";
import {
  deviceTrackers,
  roles as rolesTable,
  pointInfo,
} from "../lib/db/planetscale/schema";
import { ROLES } from "../lib/roles/registry";

const APPLY = process.argv.includes("--apply");
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const systemArg = process.argv.find((a) => a.startsWith("--system="));
const systemId = systemArg ? parseInt(systemArg.split("=")[1], 10) : null;

async function findPoint(
  db: ReturnType<typeof requirePlanetscaleDb>,
  sysId: number,
  metricType: string,
  displayName: string,
): Promise<number | null> {
  const [row] = await db
    .select({ index: pointInfo.index })
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, sysId),
        eq(pointInfo.metricType, metricType),
        eq(pointInfo.displayName, displayName),
      ),
    )
    .limit(1);
  return row ? row.index : null;
}

async function main() {
  const db = requirePlanetscaleDb();

  // 1. Seed the generator role row (FK target). ha.* describes the numeric signal (power/W).
  const r = ROLES.generator;
  const roleRow = {
    role: r.id,
    category: r.category,
    stem: r.stem,
    label: r.label,
    haDeviceClass: r.ha.deviceClass,
    haStateClass: r.ha.stateClass,
    haUnit: r.ha.unit,
    summaryMetric: r.summary?.metric ?? null,
    summaryAggregable: r.summary ? r.summary.aggregable : null,
  };
  console.log(`${tag} roles: upsert 'generator'`);
  if (APPLY) {
    await db
      .insert(rolesTable)
      .values(roleRow)
      .onConflictDoUpdate({ target: rolesTable.role, set: roleRow });
  }

  // If no --system, list candidate systems (those with a 'Grid' power point).
  if (systemId === null) {
    const candidates = await db
      .select({ systemId: pointInfo.systemId })
      .from(pointInfo)
      .where(
        and(
          eq(pointInfo.metricType, "power"),
          eq(pointInfo.displayName, "Grid"),
        ),
      );
    const ids = [...new Set(candidates.map((c) => c.systemId))].sort(
      (a, b) => a - b,
    );
    console.log(
      `${tag} no --system given. Systems with a 'Grid' power point: ${ids.join(", ") || "(none)"}`,
    );
    console.log("Re-run with --system=<id> [--apply] to seed a tracker.");
    return;
  }

  // 2. Resolve the signal (Grid power) and energy (Import) points for the system.
  const gridPointId = await findPoint(db, systemId, "power", "Grid");
  const importPointId = await findPoint(db, systemId, "energy", "Import");

  if (gridPointId === null) {
    console.error(
      `${tag} system ${systemId} has no 'Grid' power point — cannot seed a generator tracker.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${tag} system ${systemId}: grid power point=${gridPointId}, import energy point=${importPointId ?? "(none — energy will be null)"}`,
  );

  const trackerRow = {
    systemId,
    role: "generator",
    displayName: "Generator",
    enabled: true,
    signalKind: "power-threshold",
    signalSystemId: systemId,
    signalPointId: gridPointId,
    lowerW: -50,
    upperW: null,
    hysteresisW: null,
    energySystemId: importPointId !== null ? systemId : null,
    energyPointId: importPointId,
    delayOnSeconds: null, // inherit default (0)
    delayOffSeconds: 120,
    detectorVersion: 1,
  };

  console.log(`${tag} device_trackers: upsert`, trackerRow);
  if (APPLY) {
    await db
      .insert(deviceTrackers)
      .values(trackerRow)
      .onConflictDoUpdate({
        target: [deviceTrackers.systemId, deviceTrackers.role],
        set: {
          displayName: trackerRow.displayName,
          enabled: trackerRow.enabled,
          signalKind: trackerRow.signalKind,
          signalSystemId: trackerRow.signalSystemId,
          signalPointId: trackerRow.signalPointId,
          lowerW: trackerRow.lowerW,
          upperW: trackerRow.upperW,
          hysteresisW: trackerRow.hysteresisW,
          energySystemId: trackerRow.energySystemId,
          energyPointId: trackerRow.energyPointId,
          delayOnSeconds: trackerRow.delayOnSeconds,
          delayOffSeconds: trackerRow.delayOffSeconds,
          detectorVersion: trackerRow.detectorVersion,
        },
      });
    console.log(`${tag} done.`);
  } else {
    console.log("Dry run — pass --apply to write.");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
