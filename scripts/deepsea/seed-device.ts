#!/usr/bin/env tsx
/**
 * Onboard the DeepSea generator as a push (gusher) system.
 *
 * Idempotent: reuses an existing `(deepsea, <siteId>)` device, else creates one. Mints a `gk_` apiKey
 * and stores it as the device's credential (so gusher accepts pushes for it). Points auto-create on
 * the first push via PointManager.ensurePointInfo.
 *
 * Targets whatever DB `.env.local` points at (liveone-dev by default). Writes to the DB + the owner's
 * Clerk private metadata. Owner defaults to the Daylesford device's owner (device 1), or DEEPSEA_OWNER.
 *
 *   npx tsx --env-file=.env.local scripts/deepsea/seed-device.ts
 *   MUSHER_SITE_ID=sheephouse npx tsx --env-file=.env.local scripts/deepsea/seed-device.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomBytes } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { devices } = await import("@/lib/db/planetscale/schema");
  const { storeDeviceCredentials } = await import("@/lib/secure-credentials");
  const { DeviceWriter } = await import("@/lib/registry/device-writer");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (no PLANETSCALE_DATABASE_URL in .env.local).",
    );
    process.exit(1);
  }

  const siteId = process.env.MUSHER_SITE_ID ?? "sheephouse";
  const vendorType = "deepsea";
  const displayName =
    process.env.DEEPSEA_DISPLAY_NAME ?? "Daylesford Generator";

  // Resolve the owner: DEEPSEA_OWNER, else the Daylesford device (id 1), else any owned system.
  let owner = process.env.DEEPSEA_OWNER ?? null;
  if (!owner) {
    const owned = await planetscaleDb
      .select({
        id: devices.rid,
        displayName: devices.name,
        owner: devices.ownerUserId,
      })
      .from(devices)
      .where(isNotNull(devices.ownerUserId))
      .limit(100);
    const pick =
      owned.find((s) => s.id === 1) ??
      owned.find((s) => /daylesford/i.test(s.displayName)) ??
      owned[0];
    if (!pick?.owner) {
      console.error(
        "❌ Could not find an owner. Set DEEPSEA_OWNER=<clerk user id>.",
      );
      process.exit(1);
    }
    owner = pick.owner;
    console.log(
      `• owner = ${owner} (from system ${pick.id} "${pick.displayName}")`,
    );
  }

  // Idempotent: reuse an existing deepsea/<siteId> system.
  const existing = await planetscaleDb
    .select({ id: devices.rid })
    .from(devices)
    .where(
      and(eq(devices.vendor, vendorType), eq(devices.vendorSiteId, siteId)),
    )
    .limit(1);

  let systemId: number;
  if (existing.length > 0) {
    systemId = existing[0].id;
    console.log(
      `• system already exists: id ${systemId} (deepsea/${siteId}) — reusing`,
    );
  } else {
    // Use the `systems` writer so dev-id allocation (ids ≥ 10000) avoids colliding with restored prod ids.
    const device = await DeviceWriter.createDevice({
      ownerClerkUserId: owner,
      vendorType,
      vendorSiteId: siteId,
      status: "active",
      displayName,
      timezoneOffsetMin: 600, // AEST
      displayTimezone: "Australia/Melbourne",
      metadata: { source: "musher", device: "DeepSea DSE7410 MkII" },
    });
    systemId = device.id;
    console.log(`✓ created system id ${systemId} (deepsea/${siteId})`);
  }

  // Mint + store the gusher apiKey (regenerate each run so we always print a valid one).
  const apiKey = `gk_${randomBytes(24).toString("base64url")}`;
  const res = await storeDeviceCredentials(owner, systemId, vendorType as any, {
    apiKey,
  });
  if (!res.success) {
    console.error(`❌ Failed to store credentials: ${res.error}`);
    process.exit(1);
  }

  console.log("\n=================== musher config ===================");
  console.log(`  MUSHER_SITE_ID = ${siteId}`);
  console.log(`  MUSHER_API_KEY = ${apiKey}`);
  console.log(`  (system id ${systemId} in the DB .env.local points at)`);
  console.log("=====================================================");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
