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
import { getEnvironment } from "@/lib/env";
import { ReadingsDao } from "@/lib/readings";
import { RegistryCache } from "@/lib/registry";
import {
  buildSubscriptionRegistry,
  updateLatestPointValue,
} from "@/lib/kv-cache-manager";
import {
  updateSystemSummary,
  updateSubscriberSummaries,
} from "@/lib/system-summary-store";

// Bounded-concurrency runner. The KV writes below are independent per point, but Upstash is a
// REST/HTTP store so each is a round trip — sequential awaits made the whole leg ~77s. Rejects (fails
// hard) as soon as any task rejects; in-flight tasks settle but the process exits non-zero via
// main().catch, so a partial rebuild is never reported as success.
const KV_CONCURRENCY = 16;
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

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

  // Belt-and-braces, with NO escape hatch (unlike the DB layer's ALLOW_PROD_DB_IN_DEV): dev and prod
  // share ONE KV store separated only by the env key prefix, so refuse outright if the DB URL carries
  // the prod branch id. A prod URL here would pump prod data into dev: — never what we want.
  const prodToken = process.env.PLANETSCALE_PROD_BRANCH_ID?.toLowerCase();
  const dbUrl = (process.env.PLANETSCALE_DATABASE_URL ?? "").toLowerCase();
  if (prodToken && dbUrl.includes(prodToken)) {
    console.error(
      `✗ Refusing to run: PLANETSCALE_DATABASE_URL carries the production identifier (${prodToken}).`,
    );
    process.exit(1);
  }

  // 1) Subscription registry first, so updateLatestPointValue can propagate each source
  //    point to the composite systems that subscribe to it (same as live ingest).
  console.log("Building subscription registry from area_bindings…");
  await buildSubscriptionRegistry();

  // 2) Pull the latest reading per active point and rebuild the latest-value hashes.
  console.log("Reading latest values from liveone-dev…");
  const rows = await ReadingsDao.latestForActivePoints();
  const addresses = await RegistryCache.addrsForPoints(
    rows.map((row) => row.point),
  );

  // Group by system so we can write each system's summary once after its points.
  const bySystem = new Map<number, typeof rows>();
  for (const row of rows) {
    const address = addresses.get(row.point)!;
    const list = bySystem.get(address.systemId) ?? [];
    list.push(row);
    bySystem.set(address.systemId, list);
  }

  // Build the write tasks up front (pure JS, no awaits) so we can run them with bounded concurrency
  // instead of one-at-a-time. Per-system summary inputs are collected the same way, to run AFTER all
  // point values land (updateSubscriberSummaries reads them back from KV).
  const pointTasks: Array<() => Promise<void>> = [];
  const systemSummaries: Array<{
    systemId: number;
    values: Array<{ logicalPath: string; value: number }>;
    maxMeasurementTimeMs: number;
  }> = [];

  for (const [systemId, systemRows] of bySystem) {
    const summaryValues: Array<{ logicalPath: string; value: number }> = [];
    let maxMeasurementTimeMs = 0;

    for (const row of systemRows) {
      const address = addresses.get(row.point)!;
      const logicalPath = `${row.logicalPathStem}/${row.metricType}`;
      const cacheValue: number | string | null =
        row.value ?? row.valueStr ?? null;
      if (cacheValue === null) continue;

      const measurementTimeMs = row.measurementTimeMs;
      const receivedTimeMs = row.receivedTimeMs;

      pointTasks.push(() =>
        updateLatestPointValue(
          systemId,
          address.index,
          logicalPath,
          cacheValue,
          measurementTimeMs,
          receivedTimeMs,
          row.metricUnit,
          row.displayName,
          undefined, // sourceSystemName (deprecated / unused)
          row.sessionId ?? undefined,
          row.sessionLabel ?? undefined,
        ),
      );

      if (typeof cacheValue === "number") {
        summaryValues.push({ logicalPath, value: cacheValue });
        if (measurementTimeMs > maxMeasurementTimeMs) {
          maxMeasurementTimeMs = measurementTimeMs;
        }
      }
    }

    if (summaryValues.length > 0) {
      systemSummaries.push({
        systemId,
        values: summaryValues,
        maxMeasurementTimeMs,
      });
    }
  }

  // Phase 1: write every point's latest value (bounded concurrency). Fail hard on any rejection.
  await runPool(pointTasks, KV_CONCURRENCY, (task) => task());

  // Phase 2: source summary + composite propagation, AFTER all points are in KV (mirrors
  // point-manager.ts: updateSubscriberSummaries reads the just-written subscriber latest values).
  await runPool(systemSummaries, KV_CONCURRENCY, async (s) => {
    await updateSystemSummary(s.systemId, s.values, s.maxMeasurementTimeMs);
    await updateSubscriberSummaries(s.systemId);
  });

  console.log(
    `✓ Rebuilt dev: KV from DB — ${pointTasks.length} point value(s) across ${bySystem.size} source system(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ rebuild-dev-kv-from-db failed:", err);
  process.exit(1);
});
