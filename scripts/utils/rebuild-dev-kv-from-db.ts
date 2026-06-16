/**
 * Rebuild the dev KV cache (latest point values + system summaries + subscription registry)
 * purely from the already-synced `liveone-dev` Postgres DB. Companion to sync-prod-to-dev-db.ts.
 *
 * Why this exists: dev/preview run with crons OFF (CRONS_ENABLED unset), so nothing polls into
 * the `dev:` KV namespace — preview dashboards would show empty/stale "live" cards even though the
 * DB is kept fresh by the 2-hourly DB sync. This reconstructs KV from that DB, so KV stays
 * consistent with the data the sync just loaded. It needs NO prod KV access — it derives "latest"
 * from the dev DB the same way live ingest does. Also used to warm a freshly-seeded preview branch
 * (see the bind-preview skill): point PLANETSCALE_DATABASE_URL at the branch and run this.
 *
 * What it writes (all in the `dev:` namespace, see lib/kv.ts kvKey):
 *   - dev:latest:system:{id}      per-point latest values (incl. composite propagation)
 *   - dev:system-summaries        per-system aggregated solar/load/battery/grid rollup
 *   - dev:subscriptions:system:{id}  reverse map source-point → composite subscribers
 *
 * SAFETY
 *   - Refuses to run unless getEnvironment() === "dev" (would otherwise clobber prod's live KV).
 *   - Inherits the app DB-layer prod guard (assertDbEnvironmentMatches): if
 *     PLANETSCALE_PROD_BRANCH_ID is set and the DB URL is prod, the pool throws before any read.
 *   - Read-only against the DB; writes ONLY to KV.
 *
 * Env:
 *   PLANETSCALE_DATABASE_URL    -> liveone-dev (the app DB layer reads this)
 *   KV_REST_API_URL / KV_REST_API_TOKEN  -> the shared KV store
 *   PLANETSCALE_PROD_BRANCH_ID  -> recommended; arms the prod-DB guard
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/utils/rebuild-dev-kv-from-db.ts
 *   # CI: PLANETSCALE_DATABASE_URL=$LIVEONE_DEV_DATABASE_URL npx tsx scripts/utils/rebuild-dev-kv-from-db.ts
 */
import { sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { getEnvironment } from "@/lib/env";
import {
  buildSubscriptionRegistry,
  updateLatestPointValue,
} from "@/lib/kv-cache-manager";
import {
  updateSystemSummary,
  updateSubscriberSummaries,
} from "@/lib/system-summary-store";

interface LatestRow {
  system_id: number;
  point_id: number;
  logical_path_stem: string;
  metric_type: string;
  metric_unit: string;
  display_name: string;
  value: number | null;
  value_str: string | null;
  measurement_time_ms: number | string;
  received_time_ms: number | string;
  session_id: string | null;
  session_label: string | null;
}

/**
 * Latest reading per active, typed point, from BOTH raw point_readings AND the 5-minute
 * aggregate — then prefer raw, falling back to agg. 5m-native sources (OpenElectricity, etc.)
 * never write raw point_readings; their "current" value lives only in point_readings_agg_5m
 * (`last` = the most recent sample in the interval, `interval_end` = its time), so a
 * point_readings-only query silently drops those whole systems. Each side is a LATERAL LIMIT 1
 * over a (system_id, point_id, time) index → one index probe per point per source, no big scans.
 */
const LATEST_SQL = `
  WITH candidates AS (
    -- Raw readings (src_rank 0 → preferred when present)
    SELECT pi.system_id, pi.id AS point_id, pi.logical_path_stem, pi.metric_type,
           pi.metric_unit, pi.display_name,
           r.value, r.value_str, r.measurement_time AS mt, r.received_time AS rt,
           r.session_id, 0 AS src_rank
    FROM point_info pi
    JOIN LATERAL (
      SELECT value, value_str, measurement_time, received_time, session_id
      FROM point_readings pr
      WHERE pr.system_id = pi.system_id AND pr.point_id = pi.id
      ORDER BY measurement_time DESC LIMIT 1
    ) r ON true
    WHERE pi.active = true AND pi.logical_path_stem IS NOT NULL
    UNION ALL
    -- 5-minute aggregate fallback (src_rank 1 → used only when there's no raw reading)
    SELECT pi.system_id, pi.id AS point_id, pi.logical_path_stem, pi.metric_type,
           pi.metric_unit, pi.display_name,
           a.last AS value, a.value_str, a.interval_end AS mt, a.interval_end AS rt,
           a.session_id, 1 AS src_rank
    FROM point_info pi
    JOIN LATERAL (
      SELECT last, value_str, interval_end, session_id
      FROM point_readings_agg_5m ag
      WHERE ag.system_id = pi.system_id AND ag.point_id = pi.id
      ORDER BY interval_end DESC LIMIT 1
    ) a ON true
    WHERE pi.active = true AND pi.logical_path_stem IS NOT NULL
  )
  SELECT DISTINCT ON (c.system_id, c.point_id)
    c.system_id, c.point_id, c.logical_path_stem, c.metric_type, c.metric_unit, c.display_name,
    c.value, c.value_str,
    EXTRACT(EPOCH FROM c.mt AT TIME ZONE 'UTC') * 1000 AS measurement_time_ms,
    EXTRACT(EPOCH FROM c.rt AT TIME ZONE 'UTC') * 1000 AS received_time_ms,
    c.session_id, s.session_label
  FROM candidates c
  LEFT JOIN sessions s ON s.id = c.session_id
  WHERE c.value IS NOT NULL OR c.value_str IS NOT NULL
  ORDER BY c.system_id, c.point_id, c.src_rank, c.mt DESC
`;

async function main(): Promise<void> {
  // Belt-and-braces: getEnvironment() also decides the KV key prefix, so this both
  // documents intent and prevents writing the prod: namespace.
  const env = getEnvironment();
  if (env !== "dev") {
    console.error(
      `✗ Refusing to run in env="${env}" — this writes the dev: KV namespace only. ` +
        `(getEnvironment() must be "dev"; check VERCEL_ENV/NODE_ENV.)`,
    );
    process.exit(1);
  }

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error(
      "✗ KV_REST_API_URL / KV_REST_API_TOKEN not set — nothing would be written. Aborting.",
    );
    process.exit(1);
  }

  const db = requirePlanetscaleDb();

  // 1) Subscription registry first, so updateLatestPointValue can propagate each source
  //    point to the composite systems that subscribe to it (same as live ingest).
  console.log("Building subscription registry from area_bindings…");
  await buildSubscriptionRegistry();

  // 2) Pull the latest reading per active point and rebuild the latest-value hashes.
  console.log("Reading latest values from liveone-dev…");
  const res = await db.execute(sql.raw(LATEST_SQL));
  const rows = ((res as { rows?: LatestRow[] }).rows ?? []) as LatestRow[];

  // Group by system so we can write each system's summary once after its points.
  const bySystem = new Map<number, LatestRow[]>();
  for (const row of rows) {
    const list = bySystem.get(row.system_id) ?? [];
    list.push(row);
    bySystem.set(row.system_id, list);
  }

  let systems = 0;
  let points = 0;
  for (const [systemId, systemRows] of bySystem) {
    const summaryValues: Array<{ logicalPath: string; value: number }> = [];
    let maxMeasurementTimeMs = 0;

    for (const row of systemRows) {
      const logicalPath = `${row.logical_path_stem}/${row.metric_type}`;
      const cacheValue: number | string | null =
        row.value ?? row.value_str ?? null;
      if (cacheValue === null) continue;

      const measurementTimeMs = Number(row.measurement_time_ms);
      const receivedTimeMs = Number(row.received_time_ms);

      await updateLatestPointValue(
        systemId,
        row.point_id,
        logicalPath,
        cacheValue,
        measurementTimeMs,
        receivedTimeMs,
        row.metric_unit,
        row.display_name,
        undefined, // sourceSystemName (deprecated / unused)
        row.session_id ?? undefined,
        row.session_label ?? undefined,
      );
      points++;

      if (typeof cacheValue === "number") {
        summaryValues.push({ logicalPath, value: cacheValue });
        if (measurementTimeMs > maxMeasurementTimeMs) {
          maxMeasurementTimeMs = measurementTimeMs;
        }
      }
    }

    // Source summary, then propagate to composite subscribers (mirrors point-manager.ts).
    if (summaryValues.length > 0) {
      await updateSystemSummary(systemId, summaryValues, maxMeasurementTimeMs);
      await updateSubscriberSummaries(systemId);
    }
    systems++;
  }

  console.log(
    `✓ Rebuilt dev: KV from DB — ${points} point value(s) across ${systems} source system(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ rebuild-dev-kv-from-db failed:", err);
  process.exit(1);
});
