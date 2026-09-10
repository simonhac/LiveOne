#!/usr/bin/env tsx
/**
 * READ-ONLY live snapshot of the observations mirror pipeline: per-lane backlog / in-flight /
 * paused + DLQ depth, plus PG response-presence / raw-landing. Shares its ingest read with
 * app/api/cron/monitor-observations via lib/observations/flow-control.
 *
 * This is the snapshot you run when the APP ITSELF is suspect — `liveone queue status` goes
 * through the deployed route, this one talks to QStash directly.
 * Run: TZ=UTC NODE_ENV=production ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/qstash-health.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
process.env.TZ = "UTC";
import { Pool } from "pg";
import { ReadingsDao } from "@/lib/readings";

async function main() {
  const { qstash } = await import("@/lib/qstash");
  const { readLanes, readGlobalParallelism } = await import(
    "@/lib/observations/flow-control"
  );
  const line = "─".repeat(70);

  console.log(line);
  console.log("Observations ingest path (flow control) + DLQ:");
  if (!qstash) {
    console.log("  (qstash not configured — OBSERVATIONS_QSTASH_TOKEN unset)");
  } else {
    try {
      // Lanes are enumerated, never discovered: a key with nothing waiting, nothing in flight and
      // no pin may not exist in QStash at all, so "0 keys" is what a TOTAL STOP looks like too.
      const [lanes, global] = await Promise.all([
        readLanes(),
        readGlobalParallelism().catch(() => null),
      ]);
      for (const l of lanes) {
        console.log(
          `  lane ${l.lane.padEnd(8)} waiting=${l.waiting}  inFlight=${l.inFlight}  ` +
            `parallelism=${l.parallelism}${l.pinned ? " PINNED" : ""}` +
            `${l.paused ? "  PAUSED" : ""}${l.idle ? "  (idle — no flow-control state)" : ""}`,
        );
      }
      console.log(
        `  global   parallelism=${global ? `${global.inFlight}/${global.max}` : "n/a"}`,
      );

      const dlq = await qstash.dlq.listMessages({ count: 100 });
      const dlqCount = (dlq.messages ?? []).length;
      console.log(
        `  dlqCount=${dlqCount}${dlqCount >= 100 ? "+ (capped at 100)" : ""}`,
      );
      if (dlqCount > 0) {
        for (const m of (dlq.messages ?? []).slice(0, 5))
          console.log(
            `    DLQ: ${(m as any).messageId ?? "?"}  url=${(m as any).url ?? "?"}  created=${(m as any).createdAt ?? "?"}`,
          );
      }
    } catch (e) {
      console.log("  ingest/DLQ query failed:", String(e));
    }
  }

  // PG response-presence + raw-landing (last hour), same query shape as the monitor cron.
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  pool.on("error", () => {});
  const [res, raw] = await Promise.all([
    pool.query(`
      SELECT
        count(*)::int AS sessions_1h,
        count(*) FILTER (WHERE response IS NOT NULL)::int AS with_response_1h
      FROM sessions
      WHERE created_at >= now() - interval '1 hour'
        AND cause='CRON' AND successful=true
    `),
    ReadingsDao.rawLandingHealth(60 * 60 * 1000),
  ]);
  const r = res.rows[0];
  const presence =
    r.sessions_1h > 0 ? r.with_response_1h / r.sessions_1h : null;
  const ageMin = raw.latestCreatedAtMs
    ? Math.round((Date.now() - raw.latestCreatedAtMs) / 60000)
    : null;
  console.log(line);
  console.log("PG mirror health (last hour):");
  console.log(
    `  CRON sessions=${r.sessions_1h}  with response=${r.with_response_1h}  presence=${presence == null ? "n/a" : (presence * 100).toFixed(0) + "%"} (alert if <80%)`,
  );
  console.log(
    `  raw rows last 1h=${raw.count}  last raw at=${raw.latestCreatedAtMs ? new Date(raw.latestCreatedAtMs).toISOString() : "—"}  age=${ageMin == null ? "n/a" : ageMin + " min"} (alert if >15)`,
  );

  // Outbox relay backlog/age (Phase 4). Separate query so a not-yet-migrated
  // table doesn't fail the mirror-health snapshot above.
  console.log(line);
  console.log("Outbox relay (Phase 4):");
  try {
    const ob = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM observations_outbox WHERE published_at IS NULL) AS backlog,
        (SELECT min(created_at) FROM observations_outbox WHERE published_at IS NULL) AS oldest_at,
        (SELECT count(*)::int FROM observations_outbox WHERE published_at IS NOT NULL) AS published
    `);
    const o = ob.rows[0];
    const oldestAgeMin = o.oldest_at
      ? Math.round((Date.now() - new Date(o.oldest_at).getTime()) / 60000)
      : null;
    console.log(
      `  unpublished backlog=${o.backlog}  oldest=${o.oldest_at ? new Date(o.oldest_at).toISOString() : "—"}  age=${oldestAgeMin == null ? "n/a" : oldestAgeMin + " min"} (alert if >10)  published(retained)=${o.published}`,
    );
  } catch (e) {
    console.log(`  outbox query failed (table missing?): ${String(e)}`);
  }

  console.log(line);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
