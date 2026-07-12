#!/usr/bin/env tsx
/**
 * Set an area-of-one's physical location (`areas.location` jsonb).
 *
 * Ensures the area-of-one exists for the given system (via ensureAreaOfOne), then writes the
 * `AreaLocation` object. The location is used to DERIVE downstream facts (e.g. the NEM grid region
 * via lib/vendors/openelectricity/region.ts) — it never stores a derived value.
 *
 * Usage:
 *   npx tsx scripts/set-area-location.ts --system=<id> --country=AU --state=NSW
 *   npx tsx scripts/set-area-location.ts --system=1 --country=AU --state=NSW --postcode=2000 --lat=-33.87 --lng=151.21
 *
 * Targets whatever DB .env.local points at (dev branch by default). To target prod,
 * point PLANETSCALE_DATABASE_URL at the sydney branch and set ALLOW_PROD_DB_IN_DEV=true.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import type { AreaLocation } from "@/lib/areas/types";

function getArg(name: string): string | undefined {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : undefined;
}

async function main() {
  const { planetscaleDb } = await import("@/lib/db/planetscale");
  const { systems, areas } = await import("@/lib/db/planetscale/schema");
  const { ensureAreaOfOne } = await import("@/lib/areas/sync");

  if (!planetscaleDb) {
    console.error(
      "❌ Postgres is not configured (no PLANETSCALE_DATABASE_URL / DB_* in .env.local).",
    );
    process.exit(1);
  }

  const systemArg = getArg("system");
  const systemId = Number(systemArg);
  if (!systemArg || !Number.isInteger(systemId) || systemId <= 0) {
    console.error(
      "❌ --system=<id> is required and must be a positive integer.",
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

  const [system] = await planetscaleDb
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
  if (!system) {
    console.error(`❌ system ${systemId} not found.`);
    process.exit(1);
  }
  const areaId = await ensureAreaOfOne(system);

  // Merge over the existing location so unspecified fields are preserved across re-runs.
  const [areaRow] = await planetscaleDb
    .select({ location: areas.location })
    .from(areas)
    .where(eq(areas.id, areaId))
    .limit(1);
  const existing = (areaRow?.location ?? null) as AreaLocation | null;
  const location: AreaLocation = {
    country: "AU",
    ...(existing ?? {}),
    ...provided,
  };

  await planetscaleDb
    .update(areas)
    .set({ location })
    .where(eq(areas.id, areaId));

  console.log(`✓ system ${systemId} → area ${areaId}`);
  console.log(`  location: ${JSON.stringify(location)}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
