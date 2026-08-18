import { BaseVendorAdapter } from "../base-adapter";
import type { TestConnectionResult, FetchContext, FetchResult } from "../types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { LatestReadingData } from "@/lib/types/readings";
import { PointManager } from "@/lib/point/point-manager";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import {
  checkAndFetchYesterdayIfNeeded,
  fetchEnphaseDay,
} from "@/lib/vendors/enphase/enphase-history";
import { sessionManager } from "@/lib/session-manager";
import * as SunCalc from "suncalc";

/** Fallback location for the sun times when a device has none recorded (Melbourne). */
const DEFAULT_LAT = -37.8136;
const DEFAULT_LON = 144.9631;
/** Local hours during which we re-pull yesterday, once Enphase has settled it. */
const REPAIR_START_HOUR = 1;
const REPAIR_END_HOUR = 5;

/**
 * The daylight / overnight-repair windows, in device-local minutes-since-midnight.
 *
 * Shared by the schedule gate and `fetchData` — they used to compute the same clock twice, from
 * different expressions, so "am I allowed to poll" and "what do I fetch" could in principle
 * disagree about which window it was.
 */
function enphaseWindow(device: DeviceConfigView, now: Date) {
  let lat = DEFAULT_LAT;
  let lon = DEFAULT_LON;
  if (device.location) {
    try {
      const loc =
        typeof device.location === "string"
          ? JSON.parse(device.location)
          : device.location;
      if (loc.lat && loc.lon) {
        lat = loc.lat;
        lon = loc.lon;
      }
    } catch {
      // Malformed location — the Melbourne default still yields a sane window.
    }
  }

  const offsetMs = device.timezoneOffsetMin * 60 * 1000;
  const localMinutesOf = (d: Date) => {
    const local = new Date(d.getTime() + offsetMs);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  };

  const localMinutes = localMinutesOf(now);
  const sun = SunCalc.getTimes(now, lat, lon);
  const dawnMinutes = localMinutesOf(sun.dawn);
  let duskMinutes = localMinutesOf(sun.dusk);
  if (duskMinutes < dawnMinutes) duskMinutes += 24 * 60;

  // First 30-min boundary at/after dawn, through 30 min past dusk.
  const activeStart = Math.ceil(dawnMinutes / 30) * 30;
  const activeEnd = duskMinutes + 30;
  const localHour = Math.floor(localMinutes / 60);

  return {
    localMinutes,
    activeStart,
    activeEnd,
    inDaylight: localMinutes >= activeStart && localMinutes <= activeEnd,
    inRepairWindow:
      localHour >= REPAIR_START_HOUR && localHour <= REPAIR_END_HOUR,
  };
}

export class EnphaseAdapter extends BaseVendorAdapter {
  readonly vendorType = "enphase";
  readonly displayName = "Enphase";
  readonly dataSource = "poll" as const;
  readonly supportsAddDevice = false; // Enphase uses OAuth flow, not supported in Add Device dialog yet

  protected pollIntervalMinutes = 60;

  /**
   * Override getLastReading to read from point_readings_agg_5m table
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    // Find the Enphase solar power point for this device
    const solarPoint =
      await PointManager.getInstance().getPointByPhysicalPathTail(
        systemId,
        "solar_w",
      );

    if (!solarPoint) {
      return null;
    }

    // Get the latest 5-minute aggregate for this point, via the readings seam. `getPointByPhysicalPathTail`
    // returned the row, so its `point_uid` (NOT NULL) IS the identity — no registry round trip, and
    // no not-in-registry branch to take (config-v4 Phase 12 slice D).
    const id: PointId = Point.encode(solarPoint.pointUid);
    const latestAgg = (await ReadingsDao.latest5mForPoints([id])).get(id);

    if (!latestAgg) {
      return null;
    }

    // Convert epoch-ms to Date
    const timestamp = new Date(latestAgg.intervalEndMs);

    return {
      timestamp: timestamp,
      receivedTime: latestAgg.createdAtMs
        ? new Date(latestAgg.createdAtMs)
        : timestamp, // Fall back to timestamp if createdAt is null (dead: created_at is NOT NULL)

      solar: {
        powerW: latestAgg.avg,
        localW: latestAgg.avg, // Enphase measures at the panels
        remoteW: null, // Enphase doesn't have remote solar
      },

      battery: {
        powerW: null, // Enphase production endpoint doesn't provide battery data
        soc: null,
      },

      load: {
        powerW: null, // Enphase production endpoint doesn't provide load data
      },

      grid: {
        powerW: null, // Enphase production endpoint doesn't provide grid data
        generatorStatus: null,
      },

      connection: {
        faultCode: null, // Enphase doesn't provide fault codes
        faultTimestamp: null,
      },
    };
  }

  /**
   * Enphase's only scheduling input: WHEN there is any point calling the API. The cadence itself is
   * the ordinary 60-minute slot rule.
   *
   * Enphase is 5-minute-native but heavily rate limited — 288 calls/day is impossible — so each
   * call pulls a whole day at once and we only make that call when it can return something new:
   * during daylight, plus an overnight window to repair yesterday once it has settled.
   */
  protected async isEligible(
    device: DeviceConfigView,
    now: Date,
  ): Promise<true | { eligible: false; reason: string }> {
    const w = enphaseWindow(device, now);
    if (w.inDaylight || w.inRepairWindow) return true;

    const until = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    return w.localMinutes < w.activeStart
      ? {
          eligible: false,
          reason: `before dawn (daylight in ${until(w.activeStart - w.localMinutes)})`,
        }
      : {
          eligible: false,
          // After dusk the next useful call is the overnight repair pass, or tomorrow's dawn.
          reason: `after dusk (next window in ${until(Math.min(REPAIR_START_HOUR * 60 + 24 * 60, w.activeStart + 24 * 60) - w.localMinutes)})`,
        };
  }

  /**
   * Fetch data from Enphase API
   * Uses fetchEnphaseDay which handles data insertion internally
   */
  protected async fetchData(
    device: DeviceConfigView,
    credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    const { dryRun, session, collector } = context;

    try {
      console.log(
        `[Enphase] Polling system ${device.id} (${device.displayName})`,
      );

      // Same window computation the schedule gate used to decide we could run at all.
      let result;
      if (enphaseWindow(device, new Date()).inRepairWindow) {
        // Overnight: re-pull yesterday if it is still incomplete.
        console.log(
          `[Enphase] Checking yesterday's data completeness for system ${device.id}`,
        );
        result = await checkAndFetchYesterdayIfNeeded(
          device.id,
          session,
          dryRun,
          collector,
        );
      } else {
        // Otherwise fetch current day's data
        result = await fetchEnphaseDay(
          device.id,
          null,
          device.timezoneOffsetMin,
          session,
          dryRun,
          collector,
        );
      }

      // Determine records upserted
      let recordsProcessed = 0;
      if ("upsertedCount" in result) {
        recordsProcessed = result.upsertedCount;
      } else if ("fetched" in result && !result.fetched) {
        // Yesterday's data was already complete
        recordsProcessed = 0;
      }

      console.log(
        `[Enphase] System ${device.id}: Upserted ${recordsProcessed} records`,
      );

      // Get raw response if available
      const rawResponse =
        "rawResponse" in result ? result.rawResponse : undefined;

      // Note: Enphase uses its own functions that handle insertion internally
      // Return empty readings array but set recordsProcessed for count tracking
      return {
        success: true,
        readings: [], // Data already stored by fetchEnphaseDay
        recordsProcessed,
        rawResponse,
      };
    } catch (error) {
      console.error(`[Enphase] Error polling system ${device.id}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // getMostRecentReadings removed - not used externally

  async testConnection(
    device: DeviceConfigView,
    credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      console.log(`[Enphase] Testing connection for system ${device.id}`);

      // Create a session for this test connection
      const session = await sessionManager.createSession({
        systemId: device.id,
        cause: "USER-TEST",
        started: new Date(),
      });

      // Fetch today's data to verify connection works
      const result = await fetchEnphaseDay(
        device.id,
        null, // null means fetch today
        device.timezoneOffsetMin,
        session,
        true, // dryRun - don't actually save to database during test
      );

      // Get the most recent reading from the database to show current status
      const latestReading = await this.getLastReading(device.id);

      // Convert to test connection format
      const latestData = latestReading
        ? {
            timestamp: latestReading.timestamp,
            solarW: latestReading.solar?.powerW || null,
            solarLocalW: latestReading.solar?.localW || null,
            loadW: latestReading.load?.powerW || null,
            batteryW: latestReading.battery?.powerW || null,
            gridW: latestReading.grid?.powerW || null,
            batterySOC: latestReading.battery?.soc || null,
            faultCode: latestReading.connection?.faultCode || null,
            faultTimestamp: latestReading.connection?.faultTimestamp
              ? new Date(latestReading.connection.faultTimestamp * 1000) // Convert Unix seconds to Date
              : null,
            generatorStatus: latestReading.grid?.generatorStatus || null,
            solarKwhTotal: null,
            loadKwhTotal: null,
            batteryInKwhTotal: null,
            batteryOutKwhTotal: null,
            gridInKwhTotal: null,
            gridOutKwhTotal: null,
          }
        : null;

      // Device info
      const deviceInfo = {
        model: "Enphase System",
        serial: device.vendorSiteId,
        ratings: null,
        solarSize: null,
        batterySize: null,
      };

      console.log(
        `[Enphase] Test connection successful for system ${device.vendorSiteId}`,
      );
      console.log(
        `[Enphase] Would have fetched ${result.intervalCount} intervals`,
      );

      return {
        success: true,
        deviceInfo,
        latestData: latestData || undefined,
        vendorResponse: result.rawResponse, // Return the raw Enphase production data
      };
    } catch (error) {
      console.error("Error testing Enphase connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
