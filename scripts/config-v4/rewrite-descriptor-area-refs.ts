#!/usr/bin/env tsx
/**
 * One-off: rewrite every persisted v3 dashboard descriptor's `section.areaId` from a raw uuid to the
 * opaque `ar_` TypeID (config-v4 Phase 9 PR2, areas TypeID id-uniformity).
 *
 * NOT required before the PR2 code deploys — `lib/dashboard/dashboards.ts`'s `rowToDashboard` already
 * read-normalizes every descriptor to `ar_` on the way out, and every route/scope reader accepts
 * either form (`lib/areas/ref.ts` dual-accept). This script is the persisted-data cleanup that lets a
 * later commit drop that dual-accept/read-normalize scaffolding. Data, not schema — NOT a drizzle
 * migration (see CLAUDE.md: never `drizzle-kit push`; this only ever UPDATEs `descriptor`, never DDL).
 *
 * Dry-run is the default. Pass --commit explicitly to write. The operation is idempotent: a
 * section.areaId already `ar_` is left untouched; the only WHERE clause writes reference this file's
 * own before/after diff, computed in TS (importing the SAME `encodeDescriptorAreaRefs` the read-
 * normalize path uses), never a hand-rolled SQL re-implementation of the base32 encode.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { assertRehearsalTarget } from "./guard";
import { isDashboardV3, type DashboardV3 } from "@/lib/dashboard/v3";
import { Area } from "@/lib/ids";
import { encodeDescriptorAreaRefs } from "@/lib/areas/ref";

interface Row {
  id: string;
  descriptor: unknown;
}

interface Plan {
  totalDashboards: number;
  v3Dashboards: number;
  totalSections: number;
  sectionsEncoded: number; // raw uuid -> ar_
  sectionsAlreadyArId: number;
  sectionsUnrecognized: string[]; // "dashboardId:sectionIndex:value" — neither uuid nor ar_ (should never happen)
  toWrite: { id: string; descriptor: DashboardV3 }[];
}

async function inspect(): Promise<{
  db: Awaited<
    ReturnType<typeof import("@/lib/db/planetscale").requirePlanetscaleDb>
  >;
  rows: Row[];
}> {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { dashboards } = await import("@/lib/db/planetscale/schema");
  const db = requirePlanetscaleDb();
  const rows = await db
    .select({ id: dashboards.id, descriptor: dashboards.descriptor })
    .from(dashboards);
  return { db, rows };
}

function buildPlan(rows: Row[]): Plan {
  const plan: Plan = {
    totalDashboards: rows.length,
    v3Dashboards: 0,
    totalSections: 0,
    sectionsEncoded: 0,
    sectionsAlreadyArId: 0,
    sectionsUnrecognized: [],
    toWrite: [],
  };
  for (const row of rows) {
    if (!isDashboardV3(row.descriptor)) continue;
    plan.v3Dashboards++;
    const before = row.descriptor;
    const after = encodeDescriptorAreaRefs(before);
    plan.totalSections += before.sections.length;
    before.sections.forEach((s, i) => {
      const a = after.sections[i];
      if (a.areaId === s.areaId && Area.is(s.areaId))
        plan.sectionsAlreadyArId++;
      else if (a.areaId !== s.areaId) plan.sectionsEncoded++;
      else plan.sectionsUnrecognized.push(`${row.id}:${i}:${s.areaId}`);
    });
    const changed = before.sections.some(
      (s, i) => s.areaId !== after.sections[i].areaId,
    );
    if (changed) plan.toWrite.push({ id: row.id, descriptor: after });
  }
  return plan;
}

async function main() {
  const commit = process.argv.includes("--commit");
  // Same target guard as the rest of the config-v4 suite. See guard.ts's header for the three modes;
  // prod also needs `ALLOW_PROD_DB_IN_DEV=true` + `--i-understand-this-is-prod` per CLAUDE.md.
  assertRehearsalTarget();
  const { db, rows } = await inspect();
  const plan = buildPlan(rows);

  console.log(
    JSON.stringify(
      {
        mode: commit ? "commit" : "dry-run",
        totalDashboards: plan.totalDashboards,
        v3Dashboards: plan.v3Dashboards,
        totalSections: plan.totalSections,
        sectionsAlreadyArId: plan.sectionsAlreadyArId,
        sectionsToEncode: plan.sectionsEncoded,
        sectionsUnrecognized: plan.sectionsUnrecognized,
        dashboardsToWrite: plan.toWrite.length,
      },
      null,
      2,
    ),
  );
  // A section.areaId that's neither a raw uuid nor `ar_` (e.g. a `/device` `device-<n>` sentinel) must
  // never have been persisted — that's a data-integrity bug elsewhere, not something this script should
  // silently paper over. Surface it and stop rather than leaving it unencoded.
  if (plan.sectionsUnrecognized.length > 0)
    throw new Error(
      `Refusing: ${plan.sectionsUnrecognized.length} section(s) have an area ref that is neither a raw uuid nor ar_ — investigate before running this script:\n${plan.sectionsUnrecognized.join("\n")}`,
    );
  if (!commit) {
    console.log("Dry-run only; rerun with --commit to write.");
    return;
  }
  if (plan.toWrite.length === 0) {
    console.log("Nothing to write — every descriptor is already ar_.");
    return;
  }

  const { dashboards } = await import("@/lib/db/planetscale/schema");
  await db.transaction(async (tx) => {
    for (const row of plan.toWrite) {
      await tx
        .update(dashboards)
        .set({ descriptor: row.descriptor })
        .where(eq(dashboards.id, row.id));
    }
  });

  // Verify: same row/section counts, every v3 section.areaId now satisfies Area.is, no residual raw
  // uuid anywhere (migration-0056 lesson — row/count validation belongs IN the migration).
  const after = await inspect();
  const afterPlan = buildPlan(after.rows);
  if (
    afterPlan.totalDashboards !== plan.totalDashboards ||
    afterPlan.v3Dashboards !== plan.v3Dashboards ||
    afterPlan.totalSections !== plan.totalSections ||
    afterPlan.sectionsEncoded !== 0 ||
    afterPlan.sectionsUnrecognized.length !== 0 ||
    afterPlan.sectionsAlreadyArId !== plan.totalSections
  ) {
    throw new Error(
      `Post-write verification failed: ${JSON.stringify(afterPlan, null, 2)}`,
    );
  }
  console.log(
    `Verified: ${afterPlan.totalSections} section(s) across ${afterPlan.v3Dashboards} v3 dashboard(s) are all ar_.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
