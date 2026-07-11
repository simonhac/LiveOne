#!/usr/bin/env tsx
/**
 * Mint a fresh gusher (gk_) key for an EXISTING Fronius/fusher system and store it as that system's
 * credential, so `/api/gush` accepts the usher's pushes for it.
 *
 * Unlike scripts/deepsea/seed-system.ts, this NEVER creates a system — Kinkora already exists as
 * LiveOne system 5 (vendor_type=fusher, vendor_site_id=kinkora, created 2025-09-22, its 13 point_info
 * rows already match the fusher manifest). This just rotates the key (the legacy FroniusPusher Pi's
 * key is replaced — retire the Pi at cutover) and prints KINKORA_API_KEY to paste into the usher's
 * env / Fly secret.
 *
 * The credential lives in the OWNER's Clerk private metadata (see lib/secure-credentials.ts), so it
 * must be written to the SAME Clerk instance that prod /api/gush reads. Two ways to run:
 *
 *   (a) Clerk-only (no DB) — pass the known system id + owner directly (safest; no prod-DB read):
 *       SYSTEM_ID=5 OWNER_CLERK_USER_ID=user_320RNHYT03KKO3S7XB24AYZqlLc \
 *       CLERK_SECRET_KEY="$PROD_CLERK_SECRET_KEY" \
 *       npx tsx --env-file=.env.local scripts/fronius/mint-gusher-key.ts
 *
 *   (b) Resolve from the DB by (vendorType, vendorSiteId) — needs PLANETSCALE_DATABASE_URL set to the
 *       DB whose system ids you're targeting (prod, since gusher runs on prod):
 *       CLERK_SECRET_KEY="$PROD_CLERK_SECRET_KEY" \
 *       PLANETSCALE_DATABASE_URL="$PROD_URL" \
 *       npx tsx --env-file=.env.local scripts/fronius/mint-gusher-key.ts
 *
 * Env overrides: VENDOR_TYPE (default "fusher"), FUSHER_SITE_ID (default "kinkora").
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";

async function main() {
  const { storeSystemCredentials } = await import("@/lib/secure-credentials");

  const vendorType = (process.env.VENDOR_TYPE ?? "fusher") as
    | "fusher"
    | "fronius";
  const siteId = process.env.FUSHER_SITE_ID ?? "kinkora";

  // Resolve (systemId, owner): prefer the explicit env (Clerk-only path); else look them up in the DB.
  let systemId: number | null = process.env.SYSTEM_ID
    ? Number(process.env.SYSTEM_ID)
    : null;
  let owner: string | null = process.env.OWNER_CLERK_USER_ID ?? null;

  if (systemId == null || !owner) {
    const { planetscaleDb } = await import("@/lib/db/planetscale");
    const { systems } = await import("@/lib/db/planetscale/schema");
    if (!planetscaleDb) {
      console.error(
        "❌ Provide SYSTEM_ID + OWNER_CLERK_USER_ID, or set PLANETSCALE_DATABASE_URL so the system can be resolved.",
      );
      process.exit(1);
    }
    const rows = await planetscaleDb
      .select({
        id: systems.id,
        owner: systems.ownerClerkUserId,
        displayName: systems.displayName,
      })
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, vendorType),
          eq(systems.vendorSiteId, siteId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      console.error(
        `❌ No existing system for (${vendorType}, ${siteId}). This tool refuses to create one — ` +
          `check the vendorType/siteId, or use scripts/deepsea/seed-system.ts to create a fresh system.`,
      );
      process.exit(1);
    }
    systemId = systemId ?? rows[0].id;
    owner = owner ?? rows[0].owner;
    console.log(
      `• resolved system ${systemId} "${rows[0].displayName}" (${vendorType}/${siteId}), owner ${owner}`,
    );
  }

  if (!owner) {
    console.error("❌ Could not resolve the system owner (Clerk user id).");
    process.exit(1);
  }

  // Mint + store the gusher apiKey (replaces any existing credential for this systemId).
  const apiKey = `gk_${randomBytes(24).toString("base64url")}`;
  const res = await storeSystemCredentials(owner, systemId!, vendorType, {
    apiKey,
  });
  if (!res.success) {
    console.error(`❌ Failed to store credentials: ${res.error}`);
    process.exit(1);
  }

  console.log("\n=================== usher config ===================");
  console.log(`  siteId (vendor_site_id) = ${siteId}`);
  console.log(`  KINKORA_API_KEY         = ${apiKey}`);
  console.log(
    `  (system id ${systemId}; credential stored in the owner's Clerk metadata)`,
  );
  console.log("====================================================");
  console.log(
    "\nNext: set this as the KINKORA_API_KEY Fly secret (or the Pi's env), then push to",
  );
  console.log(
    "https://www.liveone.energy/api/gush. Retire the old FroniusPusher Pi.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
