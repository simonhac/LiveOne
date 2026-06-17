/**
 * OpenElectricity backfill downloader — BOUNDED, online, reuses the live ingest path.
 *
 * Fetches a date range at 5m for one region (the same two endpoint calls the live adapter
 * makes), maps via the shared `buildReadingsFromResponses`, and ingests through
 * PointManager.insertPointReadingsAgg5m (→ queue → receiver UPSERT, idempotent). Optionally
 * rebuilds 1d aggregates for the range afterwards.
 *
 * For large historical loads (months/years) use the offline bulk ingestor instead
 * (scripts/openelectricity/bulk-ingest.ts) — it bypasses the queue for throughput.
 */

import type { CalendarDate } from "@internationalized/date";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";
import { aggregateRange } from "@/lib/aggregation/daily-points";
import {
  OpenElectricityApiError,
  fetchMarketData,
  fetchNetworkData,
  getBasisMetric,
} from "./client";
import { buildReadingsFromResponses } from "./point-metadata";
import type { NemRegion } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;
/** ≈ 3.47 days of 5-minute intervals per request (tune to the API's per-request cap). */
const MAX_INTERVALS_PER_REQUEST = 1000;
const CHUNK_MS = MAX_INTERVALS_PER_REQUEST * FIVE_MIN_MS;
const MAX_CHUNK_ATTEMPTS = 4;

export interface BackfillArgs {
  systemId: number;
  region: NemRegion;
  network?: string;
  dateStart: Date;
  dateEnd: Date;
  session: SessionInfo | null;
  collector?: PollCollector;
  dryRun?: boolean;
  /** If set (and not dryRun), rebuild 1d aggregates for this calendar range after ingest. */
  aggregate?: { start: CalendarDate; end: CalendarDate } | null;
  apiKey?: string;
}

export interface OeBackfillResult {
  region: NemRegion;
  dateStart: string;
  dateEnd: string;
  chunks: number;
  intervalsIngested: number;
  rateLimited: number;
  aggregated1d: boolean;
  errors: string[];
}

function floor5(ms: number): number {
  return Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}
function ceil5(ms: number): number {
  return Math.ceil(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillRange(
  args: BackfillArgs,
): Promise<OeBackfillResult> {
  const network = args.network ?? "NEM";
  const pm = PointManager.getInstance();

  const startMs = floor5(args.dateStart.getTime());
  const endMs = ceil5(args.dateEnd.getTime());

  let chunks = 0;
  let intervalsIngested = 0;
  let rateLimited = 0;
  const errors: string[] = [];

  for (let cursor = startMs; cursor < endMs; cursor += CHUNK_MS) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(Math.min(cursor + CHUNK_MS, endMs));
    chunks++;

    let attempt = 0;
    // Retry retryable errors (429 / 5xx) with backoff; give up after MAX_CHUNK_ATTEMPTS.
    for (;;) {
      attempt++;
      try {
        const [dataRes, marketRes] = await Promise.all([
          fetchNetworkData({
            region: args.region,
            networkCode: network,
            metrics: [getBasisMetric("5m"), "emissions"],
            interval: "5m",
            dateStart: chunkStart,
            dateEnd: chunkEnd,
            apiKey: args.apiKey,
          }),
          fetchMarketData({
            region: args.region,
            networkCode: network,
            metrics: ["price", "renewable_proportion", "demand"],
            interval: "5m",
            dateStart: chunkStart,
            dateEnd: chunkEnd,
            apiKey: args.apiKey,
          }),
        ]);

        const readings = buildReadingsFromResponses(
          dataRes.response,
          marketRes.response,
          "5m",
          "good",
        );
        if (!args.dryRun && readings.length > 0) {
          await pm.insertPointReadingsAgg5m(
            args.systemId,
            args.session,
            readings,
            args.collector,
          );
        }
        intervalsIngested += readings.length;
        break; // chunk done
      } catch (err) {
        const retryable =
          err instanceof OpenElectricityApiError && err.retryable;
        if (retryable && attempt < MAX_CHUNK_ATTEMPTS) {
          rateLimited++;
          const apiErr = err as OpenElectricityApiError;
          const waitMs = apiErr.resetEpochSec
            ? Math.max(0, apiErr.resetEpochSec * 1000 - Date.now())
            : 1000 * 2 ** (attempt - 1);
          await sleep(Math.min(waitMs, 60_000));
          continue;
        }
        errors.push(
          `${chunkStart.toISOString()}..${chunkEnd.toISOString()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        break;
      }
    }

    // Polite inter-chunk pacing.
    if (cursor + CHUNK_MS < endMs) await sleep(200);
  }

  let aggregated1d = false;
  if (!args.dryRun && args.aggregate && errors.length === 0) {
    await aggregateRange(args.aggregate.start, args.aggregate.end);
    aggregated1d = true;
  }

  return {
    region: args.region,
    dateStart: new Date(startMs).toISOString(),
    dateEnd: new Date(endMs).toISOString(),
    chunks,
    intervalsIngested,
    rateLimited,
    aggregated1d,
    errors,
  };
}
