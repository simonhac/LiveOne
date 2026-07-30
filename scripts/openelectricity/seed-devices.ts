#!/usr/bin/env tsx
/**
 * Seed OpenElectricity region devices — one liveone `device` per NEM region.
 *
 * Idempotent: a region that already has an `openelectricity` device is skipped.
 * Point rows are NOT created here; they auto-create on the first poll via PointManager.
 *
 * Usage:
 *   npx tsx scripts/openelectricity/seed-devices.ts                  # all 5 NEM regions (default)
 *   npx tsx scripts/openelectricity/seed-devices.ts --regions=NSW1,VIC1
 *
 * Targets whatever DB .env.local points at (dev branch by default). To seed prod,
 * point PLANETSCALE_DATABASE_URL at the sydney branch and set ALLOW_PROD_DB_IN_DEV=true.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";

const REGION_NAMES: Record<string, string> = {
  NSW1: "New South Wales",
  QLD1: "Queensland",
  VIC1: "Victoria",
  SA1: "South Australia",
  TAS1: "Tasmania",
};

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { devices } = await import("@/lib/db/planetscale/schema");
  const { DeviceWriter } = await import("@/lib/registry/device-writer");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres is not configured (no PLANETSCALE_DATABASE_URL / DB_* in .env.local).",
    );
    process.exit(1);
  }

  const regionsArg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--regions="));
  const regions = (
    regionsArg ? regionsArg.split("=")[1] : "NSW1,QLD1,VIC1,SA1,TAS1"
  )
    .split(",")
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);

  for (const region of regions) {
    const name = REGION_NAMES[region] ?? region;

    const existing = await planetscaleDb
      .select({ id: devices.rid })
      .from(devices)
      .where(
        and(
          eq(devices.vendor, "openelectricity"),
          eq(devices.vendorSiteId, region),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(
        `• ${region}: already exists (system ${existing[0].id}) — skipped`,
      );
      continue;
    }

    // Slice 1a: routed through `DeviceWriter.createDevice` instead of a hand-written `insert(devices)`
    // plus a mirror call. This was the LAST `devices` writer outside `DeviceWriter` — a raw INSERT that
    // `tsc` could see but no reviewer would think to look for, and the reason `devices.rid`'s `nextval`
    // DEFAULT could not be trusted (two independent counters were live). Going through the writer also
    // gets the load-bearing four-step insert order for free rather than re-deriving it here.
    const row = await DeviceWriter.createDevice({
      ownerClerkUserId: null,
      vendorType: "openelectricity",
      vendorSiteId: region,
      status: "active",
      displayName: `OpenElectricity NEM — ${name}`,
      timezoneOffsetMin: 600, // AEST (UTC+10), no DST
      displayTimezone: "Australia/Brisbane",
      metadata: { network: "NEM" },
    });

    console.log(`✓ ${region}: created system ${row.id}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
