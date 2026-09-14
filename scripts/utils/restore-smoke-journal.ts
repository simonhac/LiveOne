#!/usr/bin/env tsx
/**
 * Restore a world journal left behind by an interrupted smoke run — DELIBERATELY, by a human.
 *
 * 🛑 This is a separate command on purpose. The smoke scripts REFUSE when they find a journal and
 * print this line; they do not replay it themselves. A journal is a photograph of the whole config,
 * so replaying one is a blind write over every device placement and every binding — and the script
 * has no way to know what has legitimately changed since it was taken (a real re-home, the 2-hourly
 * prod→dev sync, another operator). Automatic revert of unknown edits is not a safety feature, which
 * is why deciding is your job and not the script's.
 *
 * Dry-run by default: it prints what differs from the journal and changes nothing.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/utils/restore-smoke-journal.ts <journal.json>
 *   npx tsx --env-file=.env.local scripts/utils/restore-smoke-journal.ts <journal.json> --apply
 */
import { eq } from "drizzle-orm";
import { planetscaleDb, requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaBindings, devices } from "@/lib/db/planetscale/schema";
import {
  clearJournal,
  readJournal,
  restoreWorld,
} from "@/scripts/utils/smoke-world-snapshot";

async function main() {
  const [path, ...rest] = process.argv.slice(2);
  const apply = rest.includes("--apply");
  if (!path) {
    console.error("usage: restore-smoke-journal.ts <journal.json> [--apply]");
    process.exit(2);
  }
  if (!planetscaleDb) {
    console.error(
      "❌ Postgres is not configured (no PLANETSCALE_DATABASE_URL).",
    );
    process.exit(1);
  }
  const snap = readJournal(path);
  if (!snap) {
    console.error(`❌ no readable journal at ${path}`);
    process.exit(1);
  }
  const db = requirePlanetscaleDb();

  console.log(`journal:  ${path}`);
  console.log(`captured: ${snap.capturedAt}`);
  console.log(`database: ${snap.database}`);
  console.log(
    `contents: ${snap.placements.length} placement(s), ${snap.bindings.length} binding(s)\n`,
  );

  // What is actually different RIGHT NOW — so the operator decides against the diff, not against a
  // row count. A journal whose diff is empty is just litter and should be deleted, not applied.
  const live = new Map(
    (
      await db.select({ id: devices.id, areaId: devices.areaId }).from(devices)
    ).map((d) => [d.id, d.areaId]),
  );
  const movedSince: string[] = [];
  for (const [id, was] of snap.placements)
    if (live.has(id) && live.get(id) !== was)
      movedSince.push(
        `  ${id}: ${live.get(id) ?? "AMBIENT"} → ${was ?? "AMBIENT"}`,
      );

  const liveKeys = new Set(
    (
      await db
        .select({
          areaId: areaBindings.areaId,
          role: areaBindings.role,
          metricType: areaBindings.metricType,
          pointUid: areaBindings.pointUid,
        })
        .from(areaBindings)
    ).map((b) => `${b.areaId}|${b.role}|${b.metricType}|${b.pointUid}`),
  );
  const missing = snap.bindings.filter(
    (b) => !liveKeys.has(`${b.areaId}|${b.role}|${b.metricType}|${b.pointUid}`),
  );

  console.log(
    movedSince.length
      ? `${movedSince.length} device(s) would be MOVED BACK:\n${movedSince.join("\n")}`
      : "no device placements differ from the journal",
  );
  console.log(
    missing.length
      ? `\n${missing.length} binding(s) would be RE-CREATED:\n` +
          missing
            .map((b) => `  ${b.areaId} ${b.role}/${b.metricType}`)
            .join("\n")
      : "\nno bindings are missing relative to the journal",
  );
  // 🛑 Stated, because the restore is ADDITIVE: it puts back what is gone and re-places what moved.
  // It does NOT remove a binding that was ADDED since, which is the right default (removing an edit
  // nobody asked about is the very hazard this command exists to avoid) but has to be said out loud.
  console.log(
    "\nnote: this restore is ADDITIVE — it re-creates missing bindings and re-places moved devices.\n" +
      "      A binding ADDED since the journal was taken is left alone; remove it by hand if it is debris.",
  );

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    process.exit(movedSince.length || missing.length ? 1 : 0);
  }

  const ok = await restoreWorld(snap);
  if (!ok) {
    console.error(
      "\n❌ restore incomplete — the journal is KEPT. Fix the cause and re-run.",
    );
    process.exit(1);
  }
  clearJournal(path);
  console.log("\n✅ restored, and the journal is cleared.");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
