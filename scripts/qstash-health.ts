#!/usr/bin/env tsx
/**
 * READ-ONLY live snapshot of the observations mirror pipeline: QStash queue lag + DLQ depth +
 * paused state, plus PG response-presence / raw-landing (mirrors app/api/cron/monitor-observations).
 * Run: TZ=UTC NODE_ENV=production ALLOW_PROD_DB_IN_DEV=true npx tsx scripts/qstash-health.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
process.env.TZ = "UTC";
import { Pool } from "pg";

async function main() {
  const { qstash, OBSERVATIONS_QUEUE_NAME } = await import("@/lib/qstash");
  const line = "─".repeat(70);

  console.log(line);
  console.log(`QStash queue "${OBSERVATIONS_QUEUE_NAME}" + DLQ:`);
  if (!qstash) {
    console.log("  (qstash not configured — OBSERVATIONS_QSTASH_TOKEN unset)");
  } else {
    try {
      const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
      let lag: number | string = "n/a",
        paused: boolean | string = "n/a",
        parallelism: any = "n/a";
      try {
        const info: any = await queue.get();
        lag = info.lag ?? 0;
        paused = info.paused ?? false;
        parallelism = info.parallelism ?? info.maxParallelism ?? "n/a";
      } catch (e: any) {
        if (e?.message?.includes("not found") || e?.status === 404)
          lag = "(queue not found)";
        else throw e;
      }
      const dlq = await qstash.dlq.listMessages({ count: 100 });
      const dlqCount = (dlq.messages ?? []).length;
      console.log(
        `  lag=${lag}  paused=${paused}  parallelism=${parallelism}  dlqCount=${dlqCount}${dlqCount >= 100 ? "+ (capped at 100)" : ""}`,
      );
      if (dlqCount > 0) {
        for (const m of (dlq.messages ?? []).slice(0, 5))
          console.log(
            `    DLQ: ${(m as any).messageId ?? "?"}  url=${(m as any).url ?? "?"}  created=${(m as any).createdAt ?? "?"}`,
          );
      }
    } catch (e) {
      console.log("  queue/DLQ query failed:", String(e));
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
  const res = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM sessions WHERE created_at >= now() - interval '1 hour' AND cause='CRON' AND successful=true) AS sessions_1h,
      (SELECT count(*)::int FROM sessions WHERE created_at >= now() - interval '1 hour' AND cause='CRON' AND successful=true AND response IS NOT NULL) AS with_response_1h,
      (SELECT count(*)::int FROM point_readings WHERE created_at >= now() - interval '1 hour') AS raw_1h,
      (SELECT max(created_at) FROM point_readings) AS last_raw_at
  `);
  const r = res.rows[0];
  const presence =
    r.sessions_1h > 0 ? r.with_response_1h / r.sessions_1h : null;
  const ageMin = r.last_raw_at
    ? Math.round((Date.now() - new Date(r.last_raw_at).getTime()) / 60000)
    : null;
  console.log(line);
  console.log("PG mirror health (last hour):");
  console.log(
    `  CRON sessions=${r.sessions_1h}  with response=${r.with_response_1h}  presence=${presence == null ? "n/a" : (presence * 100).toFixed(0) + "%"} (alert if <80%)`,
  );
  console.log(
    `  raw rows last 1h=${r.raw_1h}  last raw at=${r.last_raw_at ? new Date(r.last_raw_at).toISOString() : "—"}  age=${ageMin == null ? "n/a" : ageMin + " min"} (alert if >15)`,
  );
  console.log(line);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
