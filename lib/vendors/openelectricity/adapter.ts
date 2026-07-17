/**
 * OpenElectricity (NEM) vendor adapter.
 *
 * One system per NEM region (`vendorSiteId` = region code). 5m-native: each poll fetches
 * the latest 5-minute intervals for the region and emits pre-aggregated readings, which the
 * receiver UPSERTs into `point_readings_agg_5m` (so late revisions heal). Three stored points:
 * emissions intensity (computed), spot price, renewable proportion — see ./point-metadata.
 *
 * Polling cadence is driven by ./scheduler (learned arrival window), not the fixed base cadence.
 * The single app-wide API key comes from `OPEN_ELECTRICITY_API_KEY` (no per-user credentials).
 */

import { BaseVendorAdapter } from "../base-adapter";
import type {
  FetchContext,
  FetchResult,
  PointReadingAgg5mInput,
  TestConnectionResult,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import type { SessionInfo } from "@/lib/point/point-manager";
import { PointManager } from "@/lib/point/point-manager";
import { updateLatestPointValue } from "@/lib/kv-cache-manager";
import { fromUnixTimestamp } from "@/lib/date-utils";
import {
  OpenElectricityApiError,
  fetchMarketData,
  fetchMe,
  fetchNetworkData,
  getApiKey,
  getBasisMetric,
} from "./client";
import { buildReadingsFromResponses } from "./point-metadata";
import {
  MAX_AUTOHEAL_MS,
  adaptiveLookbackStartMs,
  decidePoll,
  loadState,
  recordObservation,
  saveState,
} from "./scheduler";
import { isNemRegion } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;

function floor5(ms: number): number {
  return Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}

export class OpenElectricityAdapter extends BaseVendorAdapter {
  readonly vendorType = "openelectricity";
  readonly displayName = "OpenElectricity (NEM)";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = false; // single shared key; region systems are seeded
  // No credentialFields — the key is read from the environment.

  // Floor cadence; shouldPoll() overrides with the dynamic arrival-window scheduler.
  protected pollIntervalMinutes = 5;
  protected toleranceSeconds = 60;

  /**
   * Dynamic schedule: poll only inside each interval's learned arrival window.
   */
  async shouldPoll(
    system: SystemWithPolling,
    forcePollAll: boolean,
    now: Date,
  ): Promise<{
    shouldPoll: boolean;
    reason?: string;
    nextPoll?: import("@internationalized/date").ZonedDateTime;
  }> {
    if (forcePollAll) return { shouldPoll: true };

    const state = await loadState(system.id);
    const decision = decidePoll({ now, state });
    await saveState(system.id, decision.newState);

    return {
      shouldPoll: decision.shouldPoll,
      reason: decision.reason,
      nextPoll: fromUnixTimestamp(
        Math.floor(decision.nextPollMs / 1000),
        system.timezoneOffsetMin,
      ),
    };
  }

  protected async fetchData(
    system: SystemWithPolling,
    _credentials: unknown,
    context: FetchContext,
  ): Promise<FetchResult> {
    const region = system.vendorSiteId;
    if (!region || !isNemRegion(region)) {
      return {
        success: false,
        error: `Unknown NEM region for system ${system.id}: ${region}`,
        errorCode: "BAD_REGION",
      };
    }
    const network =
      (system.metadata as { network?: string } | null)?.network ?? "NEM";

    // Adaptive lookback: normally re-pull the last DEFAULT_LOOKBACK_MS (45 min) so a just-published
    // interval lands — including the `data` leg (power/emissions), which trails `market` — and late
    // revisions heal via the receiver's UPSERT; but if we're behind after an outage, extend the window
    // back to the last interval we have so the gap auto-fills — capped at MAX_AUTOHEAL_MS. Gaps larger
    // than the cap need the backfill route / bulk ingestor.
    const baseMs = floor5(context.startedAt.getTime());
    const sched = await loadState(system.id);
    const dateStartMs = adaptiveLookbackStartMs(
      baseMs,
      sched.lastSeenIntervalEndMs,
    );
    if (
      sched.lastSeenIntervalEndMs > 0 &&
      sched.lastSeenIntervalEndMs < baseMs - MAX_AUTOHEAL_MS
    ) {
      console.warn(
        `[OpenElectricity] system ${system.id} is behind beyond the ${
          MAX_AUTOHEAL_MS / 3_600_000
        }h auto-heal cap; intervals before ${new Date(
          dateStartMs,
        ).toISOString()} need a manual backfill`,
      );
    }
    const dateStart = new Date(dateStartMs);
    const dateEnd = new Date(baseMs + FIVE_MIN_MS);

    let dataResp;
    let marketResp;
    try {
      const [dataRes, marketRes] = await Promise.all([
        fetchNetworkData({
          region,
          networkCode: network,
          metrics: [getBasisMetric("5m"), "emissions"],
          interval: "5m",
          dateStart,
          dateEnd,
        }),
        fetchMarketData({
          region,
          networkCode: network,
          metrics: ["price", "renewable_proportion", "demand"],
          interval: "5m",
          dateStart,
          dateEnd,
        }),
      ]);
      dataResp = dataRes.response;
      marketResp = marketRes.response;
    } catch (err) {
      const errorCode =
        err instanceof OpenElectricityApiError ? String(err.status) : undefined;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode,
      };
    }

    const readings = buildReadingsFromResponses(
      dataResp,
      marketResp,
      "5m",
      "good",
    );

    if (readings.length > 0) {
      const newestIntervalEndMs = Math.max(
        ...readings.map((r) => r.intervalEndMs),
      );
      // Live dashboard cache + composite propagation (best-effort).
      try {
        await this.pushLatestToKv(system.id, readings, context.session);
      } catch (err) {
        console.error("[OpenElectricity] KV latest update failed:", err);
      }
      // Feed the scheduler the observed publish delay (best-effort).
      try {
        await recordObservation({
          systemId: system.id,
          capturedIntervalEndMs: newestIntervalEndMs,
          observedAtMs: Date.now(),
        });
      } catch (err) {
        console.error("[OpenElectricity] scheduler update failed:", err);
      }
    }

    return {
      success: true,
      readingsAgg5m: readings,
      recordsProcessed: readings.length,
      rawResponse: { region, dataResp, marketResp },
    };
  }

  /**
   * Push the newest interval's values to the KV latest-value cache (the 5m ingest path
   * intentionally doesn't). Points that don't yet exist in point_info (first poll) are
   * skipped; they populate once the receiver materialises them.
   */
  private async pushLatestToKv(
    systemId: number,
    readings: PointReadingAgg5mInput[],
    session: SessionInfo,
  ): Promise<void> {
    const pm = PointManager.getInstance();
    const activePoints = await pm.getActivePointsForSystem(systemId);
    const byLogicalPath = new Map(
      activePoints
        .map((p) => [p.getLogicalPath(), p] as const)
        .filter(([lp]) => !!lp),
    );

    // Newest reading per (logicalPathStem/metricType).
    const latestByPath = new Map<string, PointReadingAgg5mInput>();
    for (const r of readings) {
      const path = `${r.pointMetadata.logicalPathStem}/${r.pointMetadata.metricType}`;
      const cur = latestByPath.get(path);
      if (!cur || r.intervalEndMs > cur.intervalEndMs) {
        latestByPath.set(path, r);
      }
    }

    const receivedTimeMs = session.started.getTime();
    for (const [path, r] of latestByPath) {
      const point = byLogicalPath.get(path);
      if (!point) continue;
      await updateLatestPointValue(
        systemId,
        point.index,
        path,
        Number(r.rawValue),
        r.intervalEndMs,
        receivedTimeMs,
        r.pointMetadata.metricUnit,
        point.name,
      );
    }
  }

  /** Validate the API key and (if the region is set) smoke-test a tiny market request. */
  async testConnection(
    system: SystemWithPolling,
    _credentials: unknown,
  ): Promise<TestConnectionResult> {
    try {
      const apiKey = getApiKey();
      const me = await fetchMe(apiKey);

      const region = system.vendorSiteId;
      let sample: unknown;
      if (region && isNemRegion(region)) {
        const now = new Date();
        const { response } = await fetchMarketData({
          region,
          metrics: ["price", "renewable_proportion", "demand"],
          interval: "5m",
          dateStart: new Date(now.getTime() - 15 * 60 * 1000),
          dateEnd: now,
          apiKey,
        });
        sample = response;
      }

      return {
        success: true,
        systemInfo: {
          vendorSiteId: region || undefined,
          displayName: `OpenElectricity (NEM ${region ?? ""})`.trim(),
        },
        vendorResponse: { rateLimit: me.rate_limit, sample },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode:
          err instanceof OpenElectricityApiError
            ? String(err.status)
            : undefined,
      };
    }
  }

  async getLastReading(_systemId: number): Promise<LatestReadingData | null> {
    // Latest values are served from the KV cache (see pushLatestToKv).
    return null;
  }
}
