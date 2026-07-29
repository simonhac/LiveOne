/**
 * Slice-K1 backfill: populate `devices.config.spec` (the structured `DeviceSpec`) from the three
 * free-text `systems` columns `ratings` / `solar_size` / `battery_size`, and drop the older
 * `config.legacyRatings` / `legacySolarSize` / `legacyBatterySize` string stash.
 *
 * **Dry-run by default. Writes only with `--commit`.** Idempotent: it re-runs `ensureDeviceRow` per
 * device, which is the SOLE implementation of the parse (`DEVICE_CONFIG_WITH_SPEC_SQL`,
 * lib/registry/v4-mirror.ts) and an `ON CONFLICT (id) DO UPDATE` mirror. Re-running is a no-op once
 * every row already matches — which is also why this script deliberately does NOT reimplement the parse
 * in TypeScript: a second copy would drift from the mirror the moment either changed.
 *
 * Prints a per-device before/after table so the dry run is reviewable without reading any SQL.
 *
 *   npx tsx --env-file=.env.local scripts/config-v4/backfill-device-spec.ts
 *   npx tsx --env-file=.env.local scripts/config-v4/backfill-device-spec.ts --commit
 */
import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  DEVICE_CONFIG_WITH_SPEC_SQL,
  ensureDeviceRow,
} from "@/lib/registry/v4-mirror";
import type { DeviceSpec } from "@/lib/capabilities/config";

const db = planetscaleDb!;
const commit = process.argv.includes("--commit");

type Row = {
  id: number;
  display_name: string;
  ratings: string | null;
  solar_size: string | null;
  battery_size: string | null;
  /** What `devices.config.spec` holds RIGHT NOW (null when the device row or the key is absent). */
  current: DeviceSpec | null;
  /** What the mirror's parse WOULD write. Computed by the same SQL the mirror runs. */
  next: DeviceSpec | null;
  /** Legacy string keys still present on `devices.config` — these are what the backfill removes. */
  legacy_keys: string[];
};

const fmt = (s: DeviceSpec | null) =>
  s && Object.keys(s).length > 0 ? JSON.stringify(s) : "—";

/**
 * Second leg, `--repair-placement` (opt-in, and only with `--commit`): copy `systems.location` down to
 * the area-of-one **where the area's is NULL**.
 *
 * Why this lives here. `ensureAreaOfOne` copies `location`/tz up from `systems` at MINT and never again
 * (`SystemsManager.updateSystem` re-mirrors `devices` but not the area) — the eighth instance of the
 * plan's "every v4 column was wired at MINT and not at EDIT" trap. `DeviceRecord` serves `location` from
 * the AREA, so any area whose location is NULL while its device's is set would start serving null the
 * moment K2 lands. That is a loss, and `location` is what derives the NEM region.
 *
 * ONE-DIRECTIONAL and NULL-only, deliberately. The reverse direction exists in the live data — Kutis has
 * an area location and a NULL `systems.location`, because the area builder writes the AREA — and the area
 * is the designated sole home for placement, so a blanket `systems → area` copy would DESTROY the newer
 * value. `WHERE a.location IS NULL` is what makes this safe to run twice.
 *
 * tz is not repaired: measured 0 drift on both `timezone_offset_min` and `display_timezone`.
 */
async function repairPlacement() {
  if (!process.argv.includes("--repair-placement")) {
    console.log(
      "\n(placement repair skipped — pass --repair-placement to also fill NULL area-of-one locations)",
    );
    return;
  }
  const { rows } = (await db.execute(sql`
    UPDATE areas a
       SET location = s.location, updated_at = now()
      FROM devices d JOIN systems s ON s.id = d.rid
     WHERE a.id = d.primary_area_id
       AND a.location IS NULL
       AND s.location IS NOT NULL
    RETURNING a.id, a.name, a.location`)) as unknown as {
    rows: Record<string, unknown>[];
  };
  console.log(
    `\nPlacement repair — filled ${rows.length} NULL area location(s):`,
  );
  for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
}

async function main() {
  // One query, joined on the verbatim-rid invariant `devices.rid == systems.id`. LEFT JOIN so a system
  // with no mirrored device row is REPORTED rather than silently skipped — that would be a live C7
  // breach and the operator needs to see it, not have it filtered away.
  const { rows } = (await db.execute(sql`
    SELECT s.id, s.display_name, s.ratings, s.solar_size, s.battery_size,
           d.config -> 'spec' AS current,
           ${sql.raw(DEVICE_CONFIG_WITH_SPEC_SQL)} -> 'spec' AS next,
           coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(coalesce(d.config, '{}'::jsonb)) k
                      WHERE k IN ('legacyRatings','legacySolarSize','legacyBatterySize')), '{}') AS legacy_keys,
           (d.id IS NULL) AS missing_device
      FROM systems s LEFT JOIN devices d ON d.rid = s.id
     ORDER BY s.id`)) as unknown as {
    rows: (Row & { missing_device: boolean })[];
  };

  const missing = rows.filter((r) => r.missing_device);
  if (missing.length > 0) {
    console.error(
      `\n⚠️  ${missing.length} systems have NO devices row (C7 breach): ${missing.map((r) => r.id).join(", ")}`,
    );
  }

  const changing = rows.filter(
    (r) =>
      JSON.stringify(r.current ?? null) !== JSON.stringify(r.next ?? null) ||
      r.legacy_keys.length > 0,
  );

  console.log(
    `\n${commit ? "COMMIT" : "DRY RUN"} — ${rows.length} systems, ${changing.length} would change\n`,
  );
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(
    [
      pad("id", 6),
      pad("name", 24),
      pad("ratings", 12),
      pad("solar", 10),
      pad("battery", 10),
      pad("drops", 50),
      "spec BEFORE -> AFTER",
    ].join(" "),
  );
  for (const r of rows) {
    const changed = changing.includes(r);
    console.log(
      [
        pad(String(r.id), 6),
        pad(r.display_name, 24),
        pad(r.ratings ?? "", 12),
        pad(r.solar_size ?? "", 10),
        pad(r.battery_size ?? "", 10),
        pad(r.legacy_keys.join(",") || "—", 50),
        `${fmt(r.current)} -> ${fmt(r.next)}`,
      ].join(" ") + (changed ? "   <-- CHANGE" : ""),
    );
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    return;
  }

  await repairPlacement();

  let written = 0;
  for (const r of rows) {
    if (r.missing_device) {
      // ensureDeviceRow would MINT the device (and an area-of-one). That is a legitimate heal, but it
      // is not what a spec backfill is for, and minting identity should never be a side effect of a
      // config touch-up. Report and skip; `registry-sync` is the tool for this.
      console.error(`  skip ${r.id}: no devices row — run registry-sync first`);
      continue;
    }
    await ensureDeviceRow(r.id);
    written++;
  }
  console.log(`\nRe-mirrored ${written} devices.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
