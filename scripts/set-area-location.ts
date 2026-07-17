#!/usr/bin/env tsx
/**
 * Set an explicit Area's physical location (`areas.location` jsonb).
 *
 * This never creates an Area. Devices do not own locations; group a device into an explicit Area first,
 * then set the Area's location. The location is used to DERIVE downstream facts (e.g. the NEM grid
 * region via lib/vendors/openelectricity/region.ts) — it never stores a derived value.
 *
 * Usage:
 *   npx tsx scripts/set-area-location.ts --handle=<area-handle> --country=AU --state=NSW
 *   npx tsx scripts/set-area-location.ts --area=<uuid> --country=AU --state=NSW --postcode=2000 --lat=-33.87 --lng=151.21
 *
 * Targets whatever DB .env.local points at (dev branch by default). To target prod,
 * point PLANETSCALE_DATABASE_URL at the sydney branch and set ALLOW_PROD_DB_IN_DEV=true.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";
import { mergeAreaLocation } from "@/lib/areas/location";

function getArg(name: string): string | undefined {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : undefined;
}

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { areas } = await import("@/lib/db/planetscale/schema");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres is not configured (no PLANETSCALE_DATABASE_URL / DB_* in .env.local).",
    );
    process.exit(1);
  }

  if (getArg("system")) {
    console.error(
      "❌ devices do not own locations; pass --area=<uuid> or --handle=<area-handle>.",
    );
    process.exit(1);
  }

  const areaArg = getArg("area");
  const handleArg = getArg("handle");
  const handle = Number(handleArg);
  if (
    (!areaArg && !handleArg) ||
    (areaArg && handleArg) ||
    (handleArg && (!Number.isInteger(handle) || handle <= 0))
  ) {
    console.error(
      "❌ pass exactly one of --area=<uuid> or --handle=<positive integer>.",
    );
    process.exit(1);
  }

  const countryArg = getArg("country");
  const state = getArg("state");
  const postcode = getArg("postcode");
  const latArg = getArg("lat");
  const lngArg = getArg("lng");

  if (!state && !postcode) {
    console.error("❌ at least one of --state or --postcode is required.");
    process.exit(1);
  }

  // Only the fields actually passed are applied (merged over any existing location below), so
  // re-running to tweak one field doesn't silently wipe the others.
  const provided: Partial<AreaLocation> = {};
  if (countryArg) provided.country = countryArg.trim().toUpperCase();
  if (state) provided.state = state.toUpperCase();
  if (postcode) provided.postcode = postcode;
  if (latArg !== undefined) {
    const lat = Number(latArg);
    if (!Number.isFinite(lat)) {
      console.error("❌ --lat must be a number.");
      process.exit(1);
    }
    provided.lat = lat;
  }
  if (lngArg !== undefined) {
    const lng = Number(lngArg);
    if (!Number.isFinite(lng)) {
      console.error("❌ --lng must be a number.");
      process.exit(1);
    }
    provided.lng = lng;
  }

  const [area] = await planetscaleDb
    .select({
      id: areas.id,
      legacySystemId: areas.legacySystemId,
      location: areas.location,
    })
    .from(areas)
    .where(areaArg ? eq(areas.id, areaArg) : eq(areas.legacySystemId, handle))
    .limit(1);
  if (!area) {
    console.error(
      `❌ area ${areaArg ? areaArg : `handle ${handle}`} not found. Create the Area first.`,
    );
    process.exit(1);
  }

  // Merge over the existing location so unspecified fields are preserved across re-runs.
  const existing = (area.location ?? null) as AreaLocation | null;
  const location = mergeAreaLocation(existing, {
    country: provided.country ?? "AU",
    state: provided.state,
    postcode: provided.postcode,
    lat: provided.lat,
    lng: provided.lng,
  });

  await planetscaleDb
    .update(areas)
    .set({ location, updatedAt: new Date() })
    .where(eq(areas.id, area.id));

  console.log(`✓ area ${area.id} handle=${area.legacySystemId ?? "null"}`);
  console.log(`  location: ${JSON.stringify(location)}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
