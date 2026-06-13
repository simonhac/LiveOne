/**
 * Tesla Vendor Adapter
 *
 * Polls Tesla vehicles for charging and location data.
 * - Default: Poll every 15 minutes
 * - When charging: Poll every 5 minutes
 */

import { BaseVendorAdapter, type ScheduleEvaluation } from "../base-adapter";
import type { FetchContext, FetchResult, TestConnectionResult } from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { getTeslaClient } from "./tesla-client";
import { getValidTeslaToken } from "./tesla-auth";
import { TESLA_POINTS } from "./point-metadata";
import type {
  TeslaCredentials,
  TeslaSystemMetadata,
  TeslaVehicleData,
} from "./types";

// Polling intervals in minutes
const DEFAULT_POLL_INTERVAL = 15;
const CHARGING_POLL_INTERVAL = 5;

// Resolved per-system Tesla polling config (defaults applied).
interface ResolvedTeslaConfig {
  wakeToPoll: boolean;
  idleInterval: number;
  chargingInterval: number;
}

// Read the per-system overrides from `systems.metadata.tesla`, applying defaults and a
// 1-minute floor on the intervals. Absent/garbage metadata yields the legacy defaults.
function resolveTeslaConfig(system: SystemWithPolling): ResolvedTeslaConfig {
  const meta =
    ((system.metadata as { tesla?: TeslaSystemMetadata } | null) ?? {}).tesla ??
    {};
  const clampInterval = (
    value: number | undefined,
    fallback: number,
  ): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1
      ? Math.floor(value)
      : fallback;
  return {
    wakeToPoll: meta.wakeToPoll !== false, // default true (legacy behaviour)
    idleInterval: clampInterval(meta.idlePollMinutes, DEFAULT_POLL_INTERVAL),
    chargingInterval: clampInterval(
      meta.chargingPollMinutes,
      CHARGING_POLL_INTERVAL,
    ),
  };
}

export class TeslaAdapter extends BaseVendorAdapter {
  readonly vendorType = "tesla";
  readonly displayName = "Tesla";
  readonly dataSource = "poll" as const;
  // Onboarded via an in-dialog Fleet API OAuth redirect (no credential fields).
  readonly supportsAddSystem = true;
  readonly addSystemFlow = "oauth-redirect" as const;

  protected pollIntervalMinutes = DEFAULT_POLL_INTERVAL;
  protected toleranceSeconds = 60;

  // Track last known charging state per system (in-memory cache)
  private chargingStates = new Map<number, boolean>();

  /**
   * Override evaluateSchedule for Tesla-specific logic:
   * - 15 min default
   * - 5 min when charging (from previous poll)
   */
  protected evaluateSchedule(
    system: SystemWithPolling,
    lastPollTime: Date | null,
    now: Date,
  ): ScheduleEvaluation {
    // Determine interval based on last known charging state, honouring per-system overrides
    const cfg = resolveTeslaConfig(system);
    const isCharging = this.chargingStates.get(system.id) || false;
    const interval = isCharging ? cfg.chargingInterval : cfg.idleInterval;

    // If never polled, poll now
    if (!lastPollTime) {
      const nextPollTime = getNextMinuteBoundary(
        interval,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: "Never polled",
        nextPollTime,
      };
    }

    const msSinceLastPoll = now.getTime() - lastPollTime.getTime();
    const targetIntervalMs = interval * 60 * 1000;
    const toleranceMs = this.toleranceSeconds * 1000;

    if (msSinceLastPoll >= targetIntervalMs - toleranceMs) {
      const nextPollTime = getNextMinuteBoundary(
        interval,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: isCharging
          ? `Charging interval (${interval} min)`
          : `Default interval (${interval} min)`,
        nextPollTime,
      };
    }

    const nextPollTime = getNextMinuteBoundary(
      interval,
      system.timezoneOffsetMin,
    );
    return {
      shouldPoll: false,
      reason: `Not due yet (polls every ${interval} min${isCharging ? ", charging" : ""})`,
      nextPollTime,
    };
  }

  /**
   * Fetch data from Tesla API
   * Base adapter handles session creation, data insertion, and session completion
   */
  protected async fetchData(
    system: SystemWithPolling,
    _credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    try {
      console.log(
        `[Tesla] Polling system ${system.id} (${system.displayName})`,
      );

      if (!system.ownerClerkUserId) {
        return { success: false, error: "System has no owner" };
      }

      // Get valid access token (refreshes if needed)
      const { accessToken, credentials: teslaCredentials } =
        await getValidTeslaToken(system.ownerClerkUserId, system.id);

      const vehicleId = (teslaCredentials as TeslaCredentials).vehicle_id;
      const client = getTeslaClient(
        (teslaCredentials as TeslaCredentials).fleet_api_base_url,
      );

      // Check vehicle state and wake if needed
      const vehicles = await client.getVehicles(accessToken);
      const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

      if (!vehicle) {
        return { success: false, error: `Vehicle ${vehicleId} not found` };
      }

      // Per-system polling config (wake behaviour + intervals).
      const cfg = resolveTeslaConfig(system);

      // Wake up vehicle if asleep
      if (vehicle.state !== "online") {
        // When wakeToPoll is disabled, never issue a Wake command: record a skipped poll
        // so the car can sleep (avoids the $0.02 wake charge + phantom drain).
        if (!cfg.wakeToPoll) {
          console.log(
            `[Tesla] Vehicle ${vehicleId} is ${vehicle.state}; wakeToPoll disabled, skipping poll (no wake)`,
          );
          const nextPollTime = getNextMinuteBoundary(
            cfg.idleInterval,
            system.timezoneOffsetMin,
          );
          return {
            success: true,
            readings: [],
            nextPollTime,
            rawResponse: {
              skipped: true,
              reason: `Vehicle ${vehicle.state}, wakeToPoll disabled`,
            },
          };
        }

        console.log(
          `[Tesla] Vehicle ${vehicleId} is ${vehicle.state}, waking up...`,
        );
        const awoke = await client.wakeUp(accessToken, vehicleId);
        if (!awoke) {
          // Vehicle didn't wake - return success with 0 readings
          console.log(
            `[Tesla] Vehicle ${vehicleId} did not wake, skipping poll`,
          );
          const nextPollTime = getNextMinuteBoundary(
            cfg.idleInterval,
            system.timezoneOffsetMin,
          );
          return {
            success: true,
            readings: [],
            nextPollTime,
            rawResponse: { skipped: true, reason: "Vehicle did not wake up" },
          };
        }
      }

      // Fetch vehicle data
      const vehicleData = await client.getVehicleData(accessToken, vehicleId);

      // Update charging state for next poll interval decision
      const isCharging = vehicleData.charge_state.charging_state === "Charging";
      this.chargingStates.set(system.id, isCharging);

      // Transform data to point readings
      const measurementTime = context.startedAt.getTime();
      const readings: FetchResult["readings"] = [];

      for (const pointConfig of TESLA_POINTS) {
        try {
          const rawValue = pointConfig.extract(vehicleData);
          if (rawValue === null || rawValue === undefined) continue;

          readings.push({
            pointMetadata: pointConfig.metadata,
            rawValue,
            measurementTime,
            dataQuality: "good" as const,
            error: null,
          });
        } catch (e) {
          console.warn(
            `[Tesla] Failed to extract ${pointConfig.metadata.physicalPathTail}:`,
            e,
          );
        }
      }

      console.log(
        `[Tesla] System ${system.id}: Extracted ${readings.length} readings`,
      );

      // Calculate next poll time based on current charging state
      const nextInterval = isCharging ? cfg.chargingInterval : cfg.idleInterval;
      const nextPollTime = getNextMinuteBoundary(
        nextInterval,
        system.timezoneOffsetMin,
      );

      return {
        success: true,
        readings,
        nextPollTime,
        rawResponse: vehicleData,
      };
    } catch (error) {
      console.error(`[Tesla] Error polling system ${system.id}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test connection with Tesla
   */
  async testConnection(
    system: SystemWithPolling,
    _credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      console.log(`[Tesla] Testing connection for system ${system.id}`);

      if (!system.ownerClerkUserId) {
        return {
          success: false,
          error: "System has no owner",
        };
      }

      // Get valid access token
      const { accessToken, credentials: teslaCredentials } =
        await getValidTeslaToken(system.ownerClerkUserId, system.id);

      const vehicleId = (teslaCredentials as TeslaCredentials).vehicle_id;
      const client = getTeslaClient(
        (teslaCredentials as TeslaCredentials).fleet_api_base_url,
      );

      // Get vehicles to verify connection
      const vehicles = await client.getVehicles(accessToken);
      const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

      if (!vehicle) {
        return {
          success: false,
          error: `Vehicle ${vehicleId} not found`,
        };
      }

      // Try to get vehicle data if online
      let vehicleData: TeslaVehicleData | null = null;
      if (vehicle.state === "online") {
        try {
          vehicleData = await client.getVehicleData(accessToken, vehicleId);
        } catch (e) {
          // Vehicle might have gone to sleep, that's okay for test
          console.log(
            `[Tesla] Could not get vehicle data (vehicle may be asleep)`,
          );
        }
      }

      const systemInfo = {
        vendorSiteId: vehicleId,
        displayName: vehicle.display_name,
        model: vehicle.vin,
        serial: vehicle.vin,
      };

      // Build latest data if we got vehicle data
      const latestData = vehicleData
        ? {
            timestamp: new Date(),
            batterySOC: vehicleData.charge_state.battery_level,
            solarW: null,
            solarLocalW: null,
            loadW: null,
            batteryW: null,
            gridW: null,
            faultCode: null,
            faultTimestamp: null,
            generatorStatus: null,
            solarKwhTotal: null,
            loadKwhTotal: null,
            batteryInKwhTotal: null,
            batteryOutKwhTotal: null,
            gridInKwhTotal: null,
            gridOutKwhTotal: null,
          }
        : undefined;

      console.log(
        `[Tesla] Test connection successful for vehicle ${vehicle.display_name}`,
      );

      return {
        success: true,
        systemInfo,
        latestData,
        vendorResponse: vehicleData || vehicle,
      };
    } catch (error) {
      console.error("[Tesla] Error testing connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
