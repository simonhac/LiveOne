#!/usr/bin/env tsx
/**
 * OpenElectricity BULK INGESTOR — offline, direct-to-DB historical loader.
 *
 * DELIBERATELY SEPARATE from the live adapter and the online backfill route. Use this to
 * seed a new region's multi-month/year history or repair a large gap, where queue throughput
 * and serverless limits make the online path impractical. It connects straight to Postgres
 * (`planetscaleDb`), batches large `INSERT … ON CONFLICT` into `point_readings_agg_5m`
 * (the same SQL the receiver uses), and BYPASSES QStash entirely.
 *
 * It writes DATA only — never schema. The region's system + its 4 points must already exist
 * (seed the system, then run one live poll / backfill so ensurePointInfo creates the points).
 *
 *   npx tsx scripts/openelectricity/bulk-ingest.ts \
 *     --system=42 --region=NSW1 --date-start=2023-01-01 --date-end=2024-01-01 \
 *     --interval=5m --window=7d --batch-size=2000 --overwrite=false \
 *     --resume=auto --dry-run=false --aggregate-1d=true --verify=true
 *
 * SAFETY: dry-run defaults TRUE. Targets whatever .env.local points at (dev branch). For a
 * real prod load, point PLANETSCALE_DATABASE_URL at the sydney branch, set
 * ALLOW_PROD_DB_IN_DEV=true, AND pass --i-understand-this-is-prod (two-key action).
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, sql } from "drizzle-orm";
import {
  OpenElectricityApiError,
  fetchMarketData,
  fetchMe,
  fetchNetworkData,
  getApiKey,
  getBasisMetric,
} from "@/lib/vendors/openelectricity/client";
import {
  OPENELECTRICITY_POINTS,
  buildReadingsFromResponses,
} from "@/lib/vendors/openelectricity/point-metadata";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";
import type {
  NemRegion,
  OeInterval,
} from "@/lib/vendors/openelectricity/types";
import { parseDateISO, calendarDateToUnixRange } from "@/lib/date-utils";

const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AEST_OFFSET_MIN = 600;
const MAX_FETCH_ATTEMPTS = 5;

interface Agg5mRow {
  systemId: number;
  pointId: number;
  intervalEnd: Date;
  sessionId: string | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  delta: number | null;
  valueStr: string | null;
  sampleCount: number;
  errorCount: number;
  dataQuality: string | null;
}

interface Options {
  systemId: number;
  region: NemRegion;
  network: string;
  dateStart: Date;
  dateEnd: Date;
  interval: OeInterval;
  windowMs: number;
  batchSize: number;
  concurrency: number;
  overwrite: boolean;
  resume: "auto" | "off";
  dryRun: boolean;
  aggregate1d: boolean;
  verify: boolean;
  paceMs: number;
  iUnderstandProd: boolean;
  ensurePoints: boolean;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function boolArg(name: string, dflt: boolean): boolean {
  const v = arg(name);
  if (v == null) return dflt;
  return v.toLowerCase() !== "false" && v !== "0";
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
function parseWindow(s: string | undefined, dflt: number): number {
  if (!s) return dflt;
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return dflt;
  const n = Number(m[1]);
  return m[2] === "d" ? n * DAY_MS : m[2] === "h" ? n * 3600_000 : n * 60_000;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function floor5(ms: number): number {
  return Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}
/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseOptions(): Options {
  const systemId = Number(arg("system"));
  const region = (arg("region") ?? "").toUpperCase();
  const interval = (arg("interval") ?? "5m") as OeInterval;
  const start = arg("date-start");
  const end = arg("date-end");

  if (!Number.isInteger(systemId) || systemId <= 0) {
    throw new Error("--system=<id> is required");
  }
  if (!isNemRegion(region)) {
    throw new Error(`--region must be a NEM region; got "${region}"`);
  }
  if (interval !== "5m" && interval !== "1d") {
    throw new Error('--interval must be "5m" or "1d"');
  }
  if (!start || !end) {
    throw new Error("--date-start and --date-end (YYYY-MM-DD) are required");
  }

  const [startSec] = calendarDateToUnixRange(
    parseDateISO(start),
    AEST_OFFSET_MIN,
  );
  const [, endSec] = calendarDateToUnixRange(
    parseDateISO(end),
    AEST_OFFSET_MIN,
  );
  const dateStart = new Date(startSec * 1000);
  const dateEnd = new Date(endSec * 1000);
  if (dateEnd <= dateStart)
    throw new Error("--date-end must be after --date-start");

  return {
    systemId,
    region,
    network: arg("network") ?? "NEM",
    dateStart,
    dateEnd,
    interval,
    windowMs: parseWindow(
      arg("window"),
      interval === "5m" ? 7 * DAY_MS : 90 * DAY_MS,
    ),
    batchSize: Number(arg("batch-size") ?? 2000),
    concurrency: Math.max(1, Number(arg("concurrency") ?? 4)),
    overwrite: boolArg("overwrite", false),
    resume: (arg("resume") ?? "auto") === "off" ? "off" : "auto",
    dryRun: boolArg("dry-run", true),
    aggregate1d: boolArg("aggregate-1d", true),
    verify: boolArg("verify", true),
    paceMs: Number(arg("pace-ms") ?? 200),
    iUnderstandProd: flag("i-understand-this-is-prod"),
    ensurePoints: flag("ensure-points"),
  };
}

function resolveHost(): string {
  if (process.env.DB_HOST) return process.env.DB_HOST;
  const url = process.env.PLANETSCALE_DATABASE_URL;
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      /* ignore */
    }
  }
  return "(unknown)";
}

async function main() {
  const opts = parseOptions();

  const { planetscaleDb } = await import("@/lib/db/planetscale");
  if (!planetscaleDb) {
    console.error(
      "❌ Postgres not configured (.env.local PLANETSCALE_DATABASE_URL / DB_*).",
    );
    process.exit(1);
  }
  const db = planetscaleDb;
  const { pointReadingsAgg5m } = await import("@/lib/db/planetscale/schema");
  const { PointManager } = await import("@/lib/point/point-manager");
  const { aggregateRange } = await import("@/lib/aggregation/daily-points");

  // --- Prod write guardrail (two-key) ---
  const host = resolveHost();
  const prodAllowed = process.env.ALLOW_PROD_DB_IN_DEV === "true";
  console.log(`Target Postgres host: ${host}`);
  console.log(
    `Mode: ${opts.dryRun ? "DRY RUN (no writes)" : "LIVE WRITES"}  |  interval=${opts.interval}  |  overwrite=${opts.overwrite}`,
  );
  if (prodAllowed && !opts.dryRun && !opts.iUnderstandProd) {
    console.error(
      "❌ ALLOW_PROD_DB_IN_DEV=true with --dry-run=false targets PRODUCTION. " +
        "Re-run with --i-understand-this-is-prod to proceed.",
    );
    process.exit(1);
  }

  // Validate API key early.
  getApiKey();
  try {
    const me = await fetchMe();
    if (me.rate_limit) {
      console.log(
        `Rate limit: ${me.rate_limit.remaining}/${me.rate_limit.limit} remaining`,
      );
    }
  } catch (err) {
    console.warn(`/me check failed (continuing): ${(err as Error).message}`);
  }

  // --- Resolve the 3 points (must already exist) ---
  const pm = PointManager.getInstance();
  const pointMap = await pm.loadPointInfoMap(opts.systemId);
  const pointByTail = new Map(
    Object.values(pointMap).map((p) => [p.physicalPathTail, p] as const),
  );
  const indexByTail = new Map<
    string,
    { index: number; metricType: string; transform: string | null }
  >();
  for (const meta of OPENELECTRICITY_POINTS) {
    let p = pointByTail.get(meta.physicalPathTail);
    if (!p && opts.ensurePoints) {
      // point_info is runtime DATA (not schema); ensurePointInfo is idempotent. Used to
      // bootstrap a fresh/preview DB that has never been polled.
      p = await pm.ensurePointInfo(opts.systemId, pointMap, meta);
      console.log(
        `  ensured point ${meta.physicalPathTail} → index ${p.index}`,
      );
    }
    if (!p) {
      console.error(
        `❌ Point "${meta.physicalPathTail}" not found for system ${opts.systemId}. ` +
          "Run one live poll/backfill first (points auto-create), or pass --ensure-points to create them.",
      );
      process.exit(1);
    }
    indexByTail.set(meta.physicalPathTail, {
      index: p.index,
      metricType: p.metricType,
      transform: p.transform,
    });
  }
  const pointIndices = [...indexByTail.values()].map((p) => p.index);

  // --- Resume: start from the min(max(interval_end)) across the 3 points ---
  let effectiveStartMs = floor5(opts.dateStart.getTime());
  if (opts.resume === "auto") {
    let resumeFloor: number | null = null;
    for (const idx of pointIndices) {
      const rows = await db
        .select({ m: sql<Date | null>`max(${pointReadingsAgg5m.intervalEnd})` })
        .from(pointReadingsAgg5m)
        .where(
          and(
            eq(pointReadingsAgg5m.systemId, opts.systemId),
            eq(pointReadingsAgg5m.pointId, idx),
          ),
        );
      const maxMs = rows[0]?.m ? new Date(rows[0].m).getTime() : null;
      resumeFloor =
        maxMs == null
          ? resumeFloor
          : resumeFloor == null
            ? maxMs
            : Math.min(resumeFloor, maxMs);
    }
    if (resumeFloor != null && resumeFloor > effectiveStartMs) {
      console.log(
        `Resuming from ${new Date(resumeFloor).toISOString()} (already-stored max).`,
      );
      effectiveStartMs = resumeFloor;
    }
  }
  const endMs = opts.dateEnd.getTime();

  // --- Value→column routing (mirrors PointManager.insertPointReadingsAgg5m) ---
  function rowFor(reading: {
    pointMetadata: { physicalPathTail: string };
    rawValue: unknown;
    intervalEndMs: number;
  }): Agg5mRow | null {
    const point = indexByTail.get(reading.pointMetadata.physicalPathTail);
    if (!point) return null;
    const num = reading.rawValue == null ? null : Number(reading.rawValue);
    const isError = num == null || Number.isNaN(num);
    const value = isError ? null : (num as number);
    const isEnergyCounter =
      point.metricType === "energy" && point.transform === "d";
    const isEnergyDelta =
      point.metricType === "energy" && point.transform !== "d";
    const scalar =
      !isError && !isEnergyCounter && !isEnergyDelta ? value : null;
    return {
      systemId: opts.systemId,
      pointId: point.index,
      intervalEnd: new Date(reading.intervalEndMs),
      sessionId: null,
      avg: scalar,
      min: scalar,
      max: scalar,
      last: isEnergyCounter ? value : isEnergyDelta ? null : scalar,
      delta: isEnergyDelta ? value : null,
      valueStr: null,
      sampleCount: isError ? 0 : 1,
      errorCount: isError ? 1 : 0,
      dataQuality: "actual",
    };
  }

  async function flush(rows: Agg5mRow[]): Promise<number> {
    if (rows.length === 0 || opts.dryRun) return rows.length;
    const ins = db.insert(pointReadingsAgg5m).values(rows);
    const res = await (
      opts.overwrite
        ? ins.onConflictDoUpdate({
            target: [
              pointReadingsAgg5m.systemId,
              pointReadingsAgg5m.pointId,
              pointReadingsAgg5m.intervalEnd,
            ],
            set: {
              avg: sql`excluded.avg`,
              min: sql`excluded.min`,
              max: sql`excluded.max`,
              last: sql`excluded.last`,
              delta: sql`excluded.delta`,
              valueStr: sql`excluded.value_str`,
              sampleCount: sql`excluded.sample_count`,
              errorCount: sql`excluded.error_count`,
              dataQuality: sql`excluded.data_quality`,
              updatedAt: sql`now()`,
            },
          })
        : ins.onConflictDoNothing()
    ).returning({ systemId: pointReadingsAgg5m.systemId });
    return res.length;
  }

  // --- Walk windows, fetch both endpoints, map, batch-upsert ---
  const basis = getBasisMetric(opts.interval);
  const stepMs = opts.interval === "5m" ? FIVE_MIN_MS : DAY_MS;
  let buffer: Agg5mRow[] = [];
  let totalMapped = 0;
  let totalWritten = 0;
  let windows = 0;
  let rateLimited = 0;

  async function fetchWindow(winStart: Date, winEnd: Date) {
    for (let attempt = 1; ; attempt++) {
      try {
        const [dataRes, marketRes] = await Promise.all([
          fetchNetworkData({
            region: opts.region,
            networkCode: opts.network,
            metrics: [basis, "emissions"],
            interval: opts.interval,
            dateStart: winStart,
            dateEnd: winEnd,
          }),
          fetchMarketData({
            region: opts.region,
            networkCode: opts.network,
            metrics: ["price", "renewable_proportion", "demand"],
            interval: opts.interval,
            dateStart: winStart,
            dateEnd: winEnd,
          }),
        ]);
        return buildReadingsFromResponses(
          dataRes.response,
          marketRes.response,
          opts.interval,
          "actual",
        );
      } catch (err) {
        const retryable =
          err instanceof OpenElectricityApiError && err.retryable;
        if (retryable && attempt < MAX_FETCH_ATTEMPTS) {
          rateLimited++;
          const apiErr = err as OpenElectricityApiError;
          const waitMs = apiErr.resetEpochSec
            ? Math.max(0, apiErr.resetEpochSec * 1000 - Date.now())
            : 1000 * 2 ** (attempt - 1);
          console.warn(
            `  ⚠️  ${apiErr.status}; retry ${attempt}/${MAX_FETCH_ATTEMPTS} after ${Math.round(
              Math.min(waitMs, 60_000) / 1000,
            )}s`,
          );
          await sleep(Math.min(waitMs, 60_000));
          continue;
        }
        throw err;
      }
    }
  }

  // Build the window list and fetch them CONCURRENTLY (downloads run in parallel up to
  // --concurrency). Order doesn't matter: each row has a unique PK (systemId, pointId,
  // intervalEnd) and these scalar metrics have no transform='d' successor dependency.
  const windowList: Array<{ start: Date; end: Date }> = [];
  for (let cursor = effectiveStartMs; cursor < endMs; cursor += opts.windowMs) {
    windowList.push({
      start: new Date(cursor),
      end: new Date(Math.min(cursor + opts.windowMs, endMs)),
    });
  }
  windows = windowList.length;
  console.log(
    `Fetching ${windows} window(s) with concurrency ${opts.concurrency}…`,
  );

  const perWindow = await mapPool(
    windowList,
    opts.concurrency,
    async (w, i) => {
      const readings = await fetchWindow(w.start, w.end);
      console.log(
        `  [${i + 1}/${windows}] ${w.start.toISOString().slice(0, 16)} → ${w.end
          .toISOString()
          .slice(0, 16)}  mapped=${readings.length}`,
      );
      return readings;
    },
  );

  // Collect all rows, then batch-upsert.
  for (const readings of perWindow) {
    totalMapped += readings.length;
    for (const r of readings) {
      const row = rowFor(r);
      if (row) buffer.push(row);
    }
  }
  for (let i = 0; i < buffer.length; i += opts.batchSize) {
    totalWritten += await flush(buffer.slice(i, i + opts.batchSize));
  }
  buffer = [];

  console.log(
    `\n${opts.dryRun ? "[dry-run] " : ""}windows=${windows}  mapped=${totalMapped}  written=${totalWritten}  rateLimited=${rateLimited}  (step=${stepMs / 60000}m)`,
  );

  // --- 1d rebuild ---
  if (opts.aggregate1d && !opts.dryRun) {
    console.log("Rebuilding 1d aggregates for the loaded range…");
    await aggregateRange(
      parseDateISO(arg("date-start")!),
      parseDateISO(arg("date-end")!),
    );
    console.log("1d aggregation done.");
  }

  // --- Verify (indexed MIN/MAX, never COUNT(*)) ---
  if (opts.verify) {
    console.log("\nCoverage (point_readings_agg_5m):");
    for (const [tail, point] of indexByTail) {
      const rows = await db
        .select({
          mn: sql<Date | null>`min(${pointReadingsAgg5m.intervalEnd})`,
          mx: sql<Date | null>`max(${pointReadingsAgg5m.intervalEnd})`,
        })
        .from(pointReadingsAgg5m)
        .where(
          and(
            eq(pointReadingsAgg5m.systemId, opts.systemId),
            eq(pointReadingsAgg5m.pointId, point.index),
          ),
        );
      const mn = rows[0]?.mn ? new Date(rows[0].mn).toISOString() : "—";
      const mx = rows[0]?.mx ? new Date(rows[0].mx).toISOString() : "—";
      console.log(`  ${tail.padEnd(26)} idx=${point.index}  ${mn} … ${mx}`);
    }
    const est: any = await db.execute(
      sql.raw(
        "SELECT n_live_tup FROM pg_stat_user_tables WHERE relname='point_readings_agg_5m'",
      ),
    );
    const n = (est.rows ?? est)[0]?.n_live_tup;
    if (n != null)
      console.log(`  ~rows in point_readings_agg_5m (planner est): ${n}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
