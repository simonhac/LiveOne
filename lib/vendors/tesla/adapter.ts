/**
 * Tesla Vendor Adapter
 *
 * Polls Tesla vehicles for charging and location data.
 * - Default: Poll every 15 minutes
 * - When charging: Poll every 2 minutes (default; per-device override wins)
 *
 * When the previous poll reported charging, the getVehicles sleep-state check is skipped —
 * a charging car is online by definition — and vehicle data is read directly. If that
 * assumption turns out to be wrong the read throws and we fall back to the presence-check
 * (wake-or-skip) path rather than recording a failed poll.
 */

import { BaseVendorAdapter, type ScheduleEvaluation } from "../base-adapter";
import type { FetchContext, FetchResult, TestConnectionResult } from "../types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { getTeslaClient } from "./tesla-client";
import { getValidTeslaToken } from "./tesla-auth";
import { TESLA_POINTS } from "./point-metadata";
import { TESLA_POLL_DEFAULTS } from "./poll-config";
import type {
  TeslaCredentials,
  TeslaDeviceMetadata,
  TeslaVehicleData,
} from "./types";

// Resolved per-device Tesla polling config (defaults applied).
interface ResolvedTeslaConfig {
  wakeToPoll: boolean;
  idleInterval: number;
  chargingInterval: number;
}

// Read the per-device overrides from `systems.metadata.tesla`, applying defaults and a
// 1-minute floor on the intervals. Absent/garbage metadata yields the legacy defaults.
export function resolveTeslaConfig(
  device: DeviceConfigView,
): ResolvedTeslaConfig {
  const meta =
    ((device.metadata as { tesla?: TeslaDeviceMetadata } | null) ?? {}).tesla ??
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
    idleInterval: clampInterval(
      meta.idlePollMinutes,
      TESLA_POLL_DEFAULTS.idlePollMinutes,
    ),
    chargingInterval: clampInterval(
      meta.chargingPollMinutes,
      TESLA_POLL_DEFAULTS.chargingPollMinutes,
    ),
  };
}

export class TeslaAdapter extends BaseVendorAdapter {
  readonly vendorType = "tesla";
  readonly displayName = "Tesla";
  readonly dataSource = "poll" as const;
  // Onboarded via an in-dialog Fleet API OAuth redirect (no credential fields).
  readonly supportsAddDevice = true;
  readonly addDeviceFlow = "oauth-redirect" as const;

  protected pollIntervalMinutes = TESLA_POLL_DEFAULTS.idlePollMinutes;
  protected toleranceSeconds = 60;

  // Track last known charging state per device (in-memory cache)
  private chargingStates = new Map<number, boolean>();

  /**
   * Override evaluateSchedule for Tesla-specific logic:
   * - 15 min default
   * - 2 min (default) when charging (from previous poll)
   */
  protected evaluateSchedule(
    device: DeviceConfigView,
    lastPollTime: Date | null,
    now: Date,
  ): ScheduleEvaluation {
    // Determine interval based on last known charging state, honouring per-device overrides
    const cfg = resolveTeslaConfig(device);
    const isCharging = this.chargingStates.get(device.id) || false;
    const interval = isCharging ? cfg.chargingInterval : cfg.idleInterval;

    // If never polled, poll now
    if (!lastPollTime) {
      const nextPollTime = getNextMinuteBoundary(
        interval,
        device.timezoneOffsetMin,
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
        device.timezoneOffsetMin,
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
      device.timezoneOffsetMin,
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
    device: DeviceConfigView,
    _credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    try {
      console.log(
        `[Tesla] Polling system ${device.id} (${device.displayName})`,
      );

      if (!device.ownerClerkUserId) {
        return { success: false, error: "System has no owner" };
      }

      // Get valid access token (refreshes if needed)
      const { accessToken, credentials: teslaCredentials } =
        await getValidTeslaToken(device.ownerClerkUserId, device.id);

      const vehicleId = (teslaCredentials as TeslaCredentials).vehicle_id;
      const client = getTeslaClient(
        (teslaCredentials as TeslaCredentials).fleet_api_base_url,
      );

      // Per-device polling config (wake behaviour + intervals).
      const cfg = resolveTeslaConfig(device);

      // A charging car is online by definition, so when the previous poll reported
      // charging the getVehicles sleep-state check is a wasted $0.002 — read vehicle
      // data directly. If the assumption is wrong (car asleep after all, vehicle gone,
      // transient API error) the read throws and we fall back to the presence-check
      // path below instead of recording a failed poll.
      let vehicleData: TeslaVehicleData | null = null;
      if (this.chargingStates.get(device.id) === true) {
        try {
          vehicleData = await client.getVehicleData(accessToken, vehicleId);
        } catch (e) {
          console.log(
            `[Tesla] Direct read failed for ${vehicleId} (assumed charging); falling back to presence check:`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      if (!vehicleData) {
        // Presence-check path (the pre-skip flow): getVehicles → wake-or-skip → read.
        const vehicles = await client.getVehicles(accessToken);
        const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

        if (!vehicle) {
          // Any charging assumption is certainly wrong now.
          this.chargingStates.set(device.id, false);
          return { success: false, error: `Vehicle ${vehicleId} not found` };
        }

        // Wake up vehicle if asleep
        if (vehicle.state !== "online") {
          // Not online ⇒ not charging. Clear the flag so the next poll goes straight to
          // this path (no doomed direct read) and evaluateSchedule drops back to the
          // idle cadence. If we wake it below and it IS charging, the read at the end
          // of fetchData overwrites this with the truth.
          this.chargingStates.set(device.id, false);

          // When wakeToPoll is disabled, never issue a Wake command: record a skipped poll
          // so the car can sleep (avoids the $0.02 wake charge + phantom drain).
          if (!cfg.wakeToPoll) {
            console.log(
              `[Tesla] Vehicle ${vehicleId} is ${vehicle.state}; wakeToPoll disabled, skipping poll (no wake)`,
            );
            const nextPollTime = getNextMinuteBoundary(
              cfg.idleInterval,
              device.timezoneOffsetMin,
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
              device.timezoneOffsetMin,
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
        vehicleData = await client.getVehicleData(accessToken, vehicleId);
      }

      // Update charging state for next poll interval decision
      const isCharging = vehicleData.charge_state.charging_state === "Charging";
      this.chargingStates.set(device.id, isCharging);

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
        `[Tesla] System ${device.id}: Extracted ${readings.length} readings`,
      );

      // Calculate next poll time based on current charging state
      const nextInterval = isCharging ? cfg.chargingInterval : cfg.idleInterval;
      const nextPollTime = getNextMinuteBoundary(
        nextInterval,
        device.timezoneOffsetMin,
      );

      return {
        success: true,
        readings,
        nextPollTime,
        rawResponse: vehicleData,
      };
    } catch (error) {
      console.error(`[Tesla] Error polling system ${device.id}:`, error);
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
    device: DeviceConfigView,
    _credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      console.log(`[Tesla] Testing connection for system ${device.id}`);

      if (!device.ownerClerkUserId) {
        return {
          success: false,
          error: "System has no owner",
        };
      }

      // Get valid access token
      const { accessToken, credentials: teslaCredentials } =
        await getValidTeslaToken(device.ownerClerkUserId, device.id);

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

      const deviceInfo = {
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
        deviceInfo,
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
