#!/usr/bin/env tsx
/**
 * P1 — Areas & Dashboards DATA HYGIENE (capability-cleanup initiative).
 *
 * Idempotent + reversible. Snapshots every affected row to scripts/cleanup/backups/ BEFORE mutating,
 * then applies all changes in ONE transaction (all-or-nothing). Re-running is a no-op.
 *
 *   1a  Un-break the empty Daylesford area (handle 1000002): add area_devices members
 *       {selectronic 1 ord 0, deepsea 14 ord 1} + set location {AU, VIC}. Membership alone makes the
 *       whole-area tiles/chart/sankey resolve (system 1 carries all site stems natively).
 *   1b  Dedup dashboards: delete 8 "Kuti Kew" (byte-identical to 7 "Kew", same area 13) and 9
 *       "kuti house" (→ empty area 1000001). Guarded: 8's descriptor must equal 7's; 9 must point at
 *       area 1000001. Areas are NOT deleted (1000001 has flow_1d rows — a do-not-touch invariant).
 *   1c  Migrate the 2 legacy v2 descriptors → v3: dashboard 1 (Daylesford Selectronic, system 1) and
 *       dashboard 3 (Amber Kinkora, system 9). Scope is preserved (allowedSystemIds falls back to the
 *       row's systemId, and the new section areaId maps back to the same handle).
 *   +   Add a sankey card to the three AREA dashboards (5 Kinkora, 6 Daylesford, 7 Kew). 5 & 6 already
 *       have one → only 7 gains it. Idempotent.
 *   1d  Delete test/duplicate systems 99990 (sungrow), 99991/99992 (composite), 99993 (empty deepsea
 *       dup of 14), FK-safe (children first). Guarded to those exact vendor types.
 *
 * Usage (dev — liveone-dev is selected by PLANETSCALE_DATABASE_URL in .env.development.local):
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p1-data-hygiene.ts            # dry-run
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/cleanup/p1-data-hygiene.ts --apply    # apply
 *
 * The prod guard (assertDbEnvironmentMatches) is built into requirePlanetscaleDb — in dev it refuses a
 * prod-token connection. To later run against prod, point PLANETSCALE_DATABASE_URL at sydney deliberately.
 */
import fs from "fs";
import path from "path";
import { eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  dashboards,
  areas,
  areaDevices,
  systems,
  pointInfo,
  pollingStatus,
  userSystems,
  sessions,
  pointReadings,
  pointReadingsAgg5m,
  pointReadingsAgg1d,
} from "@/lib/db/planetscale/schema";
import { ensureSankeyCardIds, isDashboardV3 } from "@/lib/dashboard/v3";
import type { DashboardV3 } from "@/lib/dashboard/v3";

// ---- Fixed targets (area UUIDs verified read-only against liveone-dev) --------------------------
const AREA_UUID = {
  a1: "019ec06c-f635-7f43-8e0d-6a05f41033a7", // handle 1  — Daylesford Selectronic
  a9: "019ec06c-f6d2-7241-85a9-60f1685f96a0", // handle 9  — Amber Kinkora
  a13: "019f3917-e789-72aa-98dd-c388f2a0b4f6", // handle 13 — Kutis (Kew)
  a1000001: "019f393a-bb55-789c-8fa5-9204b96ed68c", // Kuti House (empty)
  a1000002: "019f513a-0d43-7c4b-b133-38f6e399fdd6", // Daylesford (site, empty)
} as const;
const TEST_SYSTEM_IDS = [99990, 99991, 99992, 99993];
const DELETE_DASHBOARDS = [8, 9];
const SANKEY_DASHBOARDS = [5, 6, 7]; // Kinkora, Daylesford, Kew

// v2→v3 target descriptors (built explicitly from the known v2 content; grid→house-to-grid).
const DASH1_V3: DashboardV3 = {
  version: 3,
  sections: [
    {
      areaId: AREA_UUID.a1,
      cards: [
        {
          type: "tiles",
          tiles: [
            { view: "solar" },
            { view: "load" },
            { view: "house-to-grid" },
            { view: "battery" },
            { view: "amber", hidden: true },
            { view: "ev", hidden: true },
          ],
        },
        { type: "chart", id: "chart:lines", chart: { variant: "lines" } },
        { type: "generator-runs" },
      ],
    },
  ],
};
const DASH3_V3: DashboardV3 = {
  version: 3,
  sections: [
    {
      areaId: AREA_UUID.a9,
      cards: [{ type: "amber-now" }, { type: "amber-timeline" }],
    },
  ],
};

const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log(...a);

function sectionHasSankey(d: DashboardV3): boolean {
  return d.sections.some((s) => s.cards.some((c) => c.type === "sankey"));
}

async function main() {
  const db = requirePlanetscaleDb();

  // ---- Snapshot every affected row FIRST (this file is the inverse) -----------------------------
  const affectedDashIds = [
    ...new Set([1, 3, ...SANKEY_DASHBOARDS, ...DELETE_DASHBOARDS]),
  ];
  const snapshot = {
    takenAt: new Date().toISOString(),
    dashboards: await db
      .select()
      .from(dashboards)
      .where(inArray(dashboards.id, affectedDashIds)),
    area1000002: await db
      .select()
      .from(areas)
      .where(eq(areas.legacySystemId, 1000002)),
    area1000002Devices: await db
      .select()
      .from(areaDevices)
      .where(eq(areaDevices.areaId, AREA_UUID.a1000002)),
    testSystems: await db
      .select()
      .from(systems)
      .where(inArray(systems.id, TEST_SYSTEM_IDS)),
    testPointInfo: await db
      .select()
      .from(pointInfo)
      .where(inArray(pointInfo.systemId, TEST_SYSTEM_IDS)),
  };
  const backupDir = path.join(process.cwd(), "scripts", "cleanup", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(
    backupDir,
    `p1-${snapshot.takenAt.replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2));
  log(`📦 backup written: ${backupFile}`);

  // ---- Pre-flight guards (abort the whole run if reality doesn't match expectations) ------------
  const byId = new Map(snapshot.dashboards.map((d) => [d.id, d]));
  const d7 = byId.get(7);
  const d8 = byId.get(8);
  const d9 = byId.get(9);
  const guards: string[] = [];
  if (
    !d7 ||
    !d8 ||
    JSON.stringify(d7.descriptor) !== JSON.stringify(d8.descriptor)
  )
    guards.push(
      "dashboard 8 is NOT byte-identical to 7 — refusing to delete 8",
    );
  if (
    !d9 ||
    !isDashboardV3(d9.descriptor) ||
    (d9.descriptor as DashboardV3).sections[0]?.areaId !== AREA_UUID.a1000001
  )
    guards.push(
      "dashboard 9 does not point at area 1000001 — refusing to delete 9",
    );
  const badTest = snapshot.testSystems.filter(
    (s) =>
      !(
        ["sungrow", "composite"].includes(s.vendorType) ||
        (s.vendorType === "deepsea" && s.id === 99993)
      ),
  );
  if (badTest.length)
    guards.push(
      `unexpected test system(s): ${badTest.map((s) => `${s.id}:${s.vendorType}`).join(", ")}`,
    );
  if (guards.length) {
    log("❌ pre-flight guard(s) failed:");
    for (const g of guards) log("   - " + g);
    process.exit(1);
  }
  log("✅ pre-flight guards passed");

  // ---- Plan / apply -----------------------------------------------------------------------------
  const plan: string[] = [];
  plan.push(
    `1a  area 1000002: +area_devices {1 ord0, 14 ord1}; set location {AU,VIC} if null`,
  );
  plan.push(
    `1b  delete dashboards ${DELETE_DASHBOARDS.join(", ")} (8≡7, 9→empty 1000001)`,
  );
  plan.push(`1c  dashboards 1,3: v2→v3 (if still v2)`);
  plan.push(
    `+   sankey → dashboards ${SANKEY_DASHBOARDS.join(", ")} (append only where missing)`,
  );
  plan.push(
    `1d  delete test systems ${TEST_SYSTEM_IDS.join(", ")} (children first)`,
  );
  log("\nPLAN:\n" + plan.map((p) => "  " + p).join("\n"));

  if (!APPLY) {
    log("\n(dry-run — pass --apply to execute)");
    return;
  }

  await db.transaction(async (tx) => {
    // 1a — Daylesford membership + location
    await tx
      .insert(areaDevices)
      .values([
        { areaId: AREA_UUID.a1000002, systemId: 1, ordinal: 0 },
        { areaId: AREA_UUID.a1000002, systemId: 14, ordinal: 1 },
      ])
      .onConflictDoNothing();
    const a1000002 = snapshot.area1000002[0];
    if (a1000002 && a1000002.location == null) {
      await tx
        .update(areas)
        .set({
          location: { country: "AU", state: "VIC" },
          updatedAt: new Date(),
        })
        .where(eq(areas.legacySystemId, 1000002));
    }

    // 1b — dedup dashboards (cascades tokens/grants; none exist)
    await tx
      .delete(dashboards)
      .where(inArray(dashboards.id, DELETE_DASHBOARDS));

    // 1c — v2→v3 for dashboards 1 and 3
    for (const [id, v3] of [
      [1, DASH1_V3],
      [3, DASH3_V3],
    ] as const) {
      const row = byId.get(id);
      const cur = row?.descriptor as { version?: number } | undefined;
      if (cur && cur.version === 2) {
        await tx
          .update(dashboards)
          .set({ descriptor: ensureSankeyCardIds(v3), updatedAt: new Date() })
          .where(eq(dashboards.id, id));
      }
    }

    // + — sankey on the three area dashboards (append only if missing), then normalise sankey ids
    for (const id of SANKEY_DASHBOARDS) {
      const row = byId.get(id);
      if (!row || !isDashboardV3(row.descriptor)) continue;
      const d = structuredClone(row.descriptor) as DashboardV3;
      if (!sectionHasSankey(d) && d.sections[0]) {
        d.sections[0].cards.push({ type: "sankey" });
      }
      await tx
        .update(dashboards)
        .set({ descriptor: ensureSankeyCardIds(d), updatedAt: new Date() })
        .where(eq(dashboards.id, id));
    }

    // 1d — delete test systems, children first (all bounded; most are already empty)
    await tx
      .delete(pointReadingsAgg1d)
      .where(inArray(pointReadingsAgg1d.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(pointReadingsAgg5m)
      .where(inArray(pointReadingsAgg5m.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(pointReadings)
      .where(inArray(pointReadings.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(sessions)
      .where(inArray(sessions.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(pointInfo)
      .where(inArray(pointInfo.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(pollingStatus)
      .where(inArray(pollingStatus.systemId, TEST_SYSTEM_IDS));
    await tx
      .delete(userSystems)
      .where(inArray(userSystems.systemId, TEST_SYSTEM_IDS));
    await tx.delete(systems).where(inArray(systems.id, TEST_SYSTEM_IDS));
  });

  log("\n✅ applied. Rebuild dev KV next: npm run db:rebuild-dev-kv");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
