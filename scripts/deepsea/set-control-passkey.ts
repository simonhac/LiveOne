#!/usr/bin/env tsx
/**
 * Store (or rotate) the generator CONTROL PASSKEY for a DeepSea device.
 *
 * The passkey is a per-device secret — the same class as a Selectronic password or a Tesla refresh
 * token — so it lives in the device owner's Clerk private metadata, in the SAME credential record
 * that already holds the device's `gk_` gusher apiKey (see ./seed-device.ts). Deliberately NOT an
 * env var (that would make it a property of the deployment, so any device on it could command the
 * generator) and NOT `devices.config` (that is the non-secret knobs surface, and config tables are
 * refreshed into liveone-dev by the 2-hourly prod→dev sync).
 *
 * The value must MATCH the hub's `SHEEPHOUSE_CONTROL_KEY` Fly secret — the hub compares against
 * its own copy. Rotating means setting both: this script, then `fly secrets set`.
 *
 * Merges into the existing credential record, so the gusher apiKey is preserved.
 *
 *   DEEPSEA_CONTROL_PASSKEY='…' npx tsx --env-file=.env.local scripts/deepsea/set-control-passkey.ts
 *   MUSHER_SITE_ID=sheephouse DEEPSEA_CONTROL_PASSKEY='…' npx tsx --env-file=.env.local scripts/deepsea/set-control-passkey.ts
 *
 * 🛑 Targets whatever DB + Clerk instance `.env.local` points at. Prod credentials live in the
 * PROD Clerk instance, so run this with prod env to affect prod — the dev Clerk instance is a
 * different user store entirely.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq } from "drizzle-orm";

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { devices } = await import("@/lib/db/planetscale/schema");
  const { getDeviceCredentials, storeDeviceCredentials } = await import(
    "@/lib/secure-credentials"
  );

  if (!planetscaleDb) {
    console.error("❌ Postgres not configured (no PLANETSCALE_DATABASE_URL).");
    process.exit(1);
  }

  const siteId = process.env.MUSHER_SITE_ID ?? "sheephouse";
  const passkey = process.env.DEEPSEA_CONTROL_PASSKEY;
  if (!passkey) {
    console.error(
      "❌ Set DEEPSEA_CONTROL_PASSKEY to the value of the hub's SHEEPHOUSE_CONTROL_KEY Fly secret.",
    );
    process.exit(1);
  }

  const [device] = await planetscaleDb
    .select({
      id: devices.rid,
      name: devices.name,
      owner: devices.ownerUserId,
    })
    .from(devices)
    .where(and(eq(devices.vendor, "deepsea"), eq(devices.vendorSiteId, siteId)))
    .limit(1);

  if (!device) {
    console.error(`❌ No deepsea device with vendorSiteId '${siteId}'.`);
    process.exit(1);
  }
  if (!device.owner) {
    // Consistent with the control plane: ownerless hardware is commandable by nobody, so there is
    // nowhere to put an owner-scoped credential.
    console.error(
      `❌ Device ${device.id} ("${device.name}") has no owner — an ownerless device cannot be commanded.`,
    );
    process.exit(1);
  }

  console.log(`• device ${device.id} "${device.name}" (deepsea/${siteId})`);
  console.log(`• owner  ${device.owner}`);

  // Merge, never replace: the gusher apiKey lives in this same record and losing it would stop
  // ingestion dead.
  const existing = await getDeviceCredentials(device.owner, device.id);
  const hadApiKey = typeof existing?.apiKey === "string";
  const rotating = typeof existing?.controlPasskey === "string";
  console.log(
    `• existing credential: ${existing ? `found (apiKey ${hadApiKey ? "present" : "MISSING"}, controlPasskey ${rotating ? "present → rotating" : "absent → adding"})` : "none"}`,
  );

  const res = await storeDeviceCredentials(device.owner, device.id, "deepsea", {
    ...(existing ?? {}),
    controlPasskey: passkey,
  });
  if (!res.success) {
    console.error(`❌ Failed to store credentials: ${res.error}`);
    process.exit(1);
  }

  const after = await getDeviceCredentials(device.owner, device.id);
  const ok =
    after?.controlPasskey === passkey &&
    (!hadApiKey || after?.apiKey === existing?.apiKey);
  console.log(
    ok
      ? "✓ controlPasskey stored; gusher apiKey preserved"
      : "⚠️ stored, but read-back did not match — check the credential record",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
