#!/usr/bin/env tsx
/**
 * Print the derived CAPABILITY set + eligible cards for each live install — the P0 parity baseline for
 * the capability model. Read-only. Compares:
 *   - config caps   = capabilitiesForSystem(handle)      (server, from point_info + trackers + grid)
 *   - presence caps = capabilitiesFromLatest(KV latest)  (client, from the KV latest hash)
 *   - eligible cards (area-scoped) and tiles from each.
 *
 * Invariant to eyeball: presence ⊆ config (a reported point is always a configured point), and the
 * capability-derived tiles == today's availableTiles(latest).
 *
 * Usage:
 *   npx tsx --env-file=.env.local --env-file=.env.development.local scripts/capabilities/print-capabilities.ts
 */
import { capabilitiesForSystem } from "@/lib/capabilities/server";
import { capabilitiesFromLatest } from "@/lib/capabilities/derive";
import {
  availableTilesFromCaps,
  availableAreaCards,
} from "@/lib/capabilities/catalog";
import { availableTiles } from "@/lib/dashboard/cards";
import { getLatestValues } from "@/lib/latest-values-store";
import type { LatestPointValues } from "@/lib/types/api";

const INSTALLS: { name: string; handle: number }[] = [
  { name: "Kew (area 13, sigenergy area-of-one)", handle: 13 },
  { name: "Kinkora (area 8, multi-device)", handle: 8 },
  { name: "Daylesford (area 1000002, selectronic+deepsea)", handle: 1000002 },
];

const show = (s: Set<string>) => [...s].sort().join(", ") || "∅";

async function main() {
  for (const { name, handle } of INSTALLS) {
    console.log(`\n══ ${name} — handle ${handle} ══`);

    const config = await capabilitiesForSystem(handle);
    const latest = ((await getLatestValues(handle)) ?? {}) as LatestPointValues;
    const presence = capabilitiesFromLatest(latest);

    console.log("  config caps  :", show(config));
    console.log("  presence caps:", show(presence));

    // Invariant: presence ⊆ config.
    const leak = [...presence].filter((c) => !config.has(c));
    console.log(
      leak.length
        ? `  ⚠️  presence NOT ⊆ config: ${leak.join(", ")}`
        : "  ✅ presence ⊆ config",
    );

    // Capability-derived tiles must equal today's availableTiles(latest).
    const tilesCap = availableTilesFromCaps(presence);
    const tilesLegacy = availableTiles(latest);
    const same = tilesCap.join(",") === tilesLegacy.join(",");
    console.log("  tiles(caps)  :", tilesCap.join(", ") || "∅");
    console.log(
      same
        ? "  ✅ tiles(caps) == availableTiles(latest)"
        : `  ⚠️  MISMATCH vs legacy: ${tilesLegacy.join(", ")}`,
    );

    console.log(
      "  area cards   :",
      availableAreaCards(config).join(", ") || "∅",
    );
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
