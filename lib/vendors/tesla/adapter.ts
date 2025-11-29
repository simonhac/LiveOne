/**
 * Tesla Vendor Adapter
 *
 * Polls Tesla vehicles for charging and location data.
 * - Default: Poll every 15 minutes
 * - When charging: Poll every 5 minutes
 */

import { BaseVendorAdapter, type ScheduleEvaluation } from "../base-adapter";
import type { PollingResult, TestConnectionResult } from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { getTeslaClient, type ITeslaClient } from "./tesla-client";
import {
  getTeslaOwnerClient,
  type TeslaOwnerClient,
} from "./tesla-owner-client";
import { getValidTeslaToken } from "./tesla-auth";
import { TESLA_POINTS } from "./point-metadata";
import type { TeslaCredentials, TeslaVehicleData } from "./types";

// Check if Fleet API is configured
const hasFleetApiConfig = !!(
  process.env.TESLA_CLIENT_ID &&
  process.env.TESLA_CLIENT_SECRET &&
  process.env.TESLA_REDIRECT_URI
);

/**
 * Get the appropriate Tesla client based on configuration.
 * Uses Fleet API client if credentials are configured, otherwise falls back to Owner API.
 */
function getClient(): ITeslaClient | TeslaOwnerClient {
  if (hasFleetApiConfig) {
    return getTeslaClient();
  }
  console.log("[Tesla] Using Owner API client (Fleet API not configured)");
  return getTeslaOwnerClient();
}

// Polling intervals in minutes
const DEFAULT_POLL_INTERVAL = 15;
const CHARGING_POLL_INTERVAL = 5;

export class TeslaAdapter extends BaseVendorAdapter {
  readonly vendorType = "tesla";
  readonly displayName = "Tesla";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = false; // Uses OAuth flow

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
    // Determine interval based on last known charging state
    const isCharging = this.chargingStates.get(system.id) || false;
    const interval = isCharging
      ? CHARGING_POLL_INTERVAL
      : DEFAULT_POLL_INTERVAL;

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
   * Perform the actual polling
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    session: SessionInfo,
    pollReason: string,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    const startTime = Date.now();

    try {
      console.log(
        `[Tesla] Polling system ${system.id} (${system.displayName})`,
      );

      if (!system.ownerClerkUserId) {
        return this.error("System has no owner");
      }

      // Get valid access token (refreshes if needed)
      const { accessToken, credentials: teslaCredentials } =
        await getValidTeslaToken(system.ownerClerkUserId, system.id);

      const vehicleId = (teslaCredentials as TeslaCredentials).vehicle_id;
      const client = getClient();

      // Check vehicle state and wake if needed
      const vehicles = await client.getVehicles(accessToken);
      const vehicle = vehicles.find((v) => String(v.id) === vehicleId);

      if (!vehicle) {
        return this.error(`Vehicle ${vehicleId} not found`);
      }

      // Wake up vehicle if asleep
      if (vehicle.state !== "online") {
        console.log(
          `[Tesla] Vehicle ${vehicleId} is ${vehicle.state}, waking up...`,
        );
        const awoke = await client.wakeUp(accessToken, vehicleId);
        if (!awoke) {
          // Vehicle didn't wake - skip this poll to save battery
          console.log(
            `[Tesla] Vehicle ${vehicleId} did not wake, skipping poll`,
          );
          const nextPoll = getNextMinuteBoundary(
            DEFAULT_POLL_INTERVAL,
            system.timezoneOffsetMin,
          );
          return this.skipped("Vehicle did not wake up", nextPoll);
        }
      }

      // Fetch vehicle data
      const vehicleData = await client.getVehicleData(accessToken, vehicleId);

      // Update charging state for next poll interval decision
      const isCharging = vehicleData.charge_state.charging_state === "Charging";
      this.chargingStates.set(system.id, isCharging);

      // Transform data to point readings
      const measurementTime = Date.now();
      const readingsToInsert = [];

      for (const pointConfig of TESLA_POINTS) {
        try {
          const rawValue = pointConfig.extract(vehicleData);
          if (rawValue === null || rawValue === undefined) continue;

          readingsToInsert.push({
            pointMetadata: pointConfig.metadata,
            rawValue,
            measurementTime,
            dataQuality: "good",
            error: null,
          });
        } catch (e) {
          console.warn(
            `[Tesla] Failed to extract ${pointConfig.metadata.physicalPathTail}:`,
            e,
          );
        }
      }

      // Insert readings (unless dry run)
      if (!dryRun && readingsToInsert.length > 0) {
        await PointManager.getInstance().insertPointReadingsBatch(
          system.id,
          session,
          readingsToInsert,
        );
      }

      const duration = Date.now() - startTime;
      console.log(
        `[Tesla] System ${system.id}: Inserted ${readingsToInsert.length} readings in ${duration}ms`,
      );

      // Calculate next poll time based on current charging state
      const nextInterval = isCharging
        ? CHARGING_POLL_INTERVAL
        : DEFAULT_POLL_INTERVAL;
      const nextPoll = getNextMinuteBoundary(
        nextInterval,
        system.timezoneOffsetMin,
      );

      return this.polled([], readingsToInsert.length, nextPoll, vehicleData);
    } catch (error) {
      console.error(`[Tesla] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : "Unknown error");
    }
  }

  /**
   * Test connection with Tesla
   */
  async testConnection(
    system: SystemWithPolling,
    credentials: any,
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
      const client = getClient();

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
