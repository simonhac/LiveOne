import { BaseVendorAdapter, ScheduleEvaluation } from "../base-adapter";
import type {
  PollingResult,
  TestConnectionResult,
  CredentialField,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import type { SessionInfo, PointMetadata } from "@/lib/point/point-manager";
import { PointManager } from "@/lib/point/point-manager";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { TeslaClient, TeslaApiError } from "./client";
import type {
  TeslaCredentials,
  TeslaVehicleData,
  TeslaPointKey,
} from "./types";
import { TESLA_POINTS } from "./types";

/**
 * Tesla Vehicle Adapter
 *
 * Polls Tesla vehicles for telemetry data including:
 * - Battery state of charge
 * - Charging status and power
 * - Location (for home detection)
 * - Odometer
 * - Climate and temperature
 *
 * Polling interval is dynamic:
 * - 15 minutes normally
 * - 5 minutes when vehicle is charging
 */
export class TeslaAdapter extends BaseVendorAdapter {
  readonly vendorType = "tesla";
  readonly displayName = "Tesla Vehicle";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = true;

  // Default: poll every 15 minutes
  protected pollIntervalMinutes = 15;
  protected toleranceSeconds = 60;

  // When charging: poll every 5 minutes
  private readonly chargingPollIntervalMinutes = 5;

  // Track charging state per system for dynamic scheduling
  private chargingStateCache = new Map<number, boolean>();

  readonly credentialFields: CredentialField[] = [
    {
      name: "accessToken",
      label: "Access Token",
      type: "password",
      placeholder: "eyJ...",
      required: true,
      helpText:
        "Tesla API access token. Use a tool like TeslaMate or teslapy to obtain tokens.",
    },
    {
      name: "refreshToken",
      label: "Refresh Token",
      type: "password",
      placeholder: "eyJ...",
      required: true,
      helpText: "Tesla API refresh token for automatic token renewal.",
    },
    {
      name: "vehicleId",
      label: "Vehicle ID",
      type: "text",
      placeholder: "Leave empty to use first vehicle",
      required: false,
      helpText: "Optional: Specific vehicle ID if you have multiple Teslas.",
    },
  ];

  /**
   * Override schedule evaluation to use dynamic interval based on charging state
   */
  protected evaluateSchedule(
    system: SystemWithPolling,
    lastPollTime: Date | null,
    now: Date,
  ): ScheduleEvaluation {
    // Check if we know this vehicle is charging
    const isCharging = this.chargingStateCache.get(system.id) ?? false;
    const effectiveInterval = isCharging
      ? this.chargingPollIntervalMinutes
      : this.pollIntervalMinutes;

    const targetIntervalMs = effectiveInterval * 60 * 1000;
    const toleranceMs = this.toleranceSeconds * 1000;

    // If never polled, poll now
    if (!lastPollTime) {
      const nextPollTime = getNextMinuteBoundary(
        effectiveInterval,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: "Never polled",
        nextPollTime,
      };
    }

    const msSinceLastPoll = now.getTime() - lastPollTime.getTime();

    if (msSinceLastPoll >= targetIntervalMs - toleranceMs) {
      const nextPollTime = getNextMinuteBoundary(
        effectiveInterval,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: `Interval reached (${effectiveInterval} min${isCharging ? " - charging" : ""})`,
        nextPollTime,
      };
    }

    const nextPollTime = getNextMinuteBoundary(
      effectiveInterval,
      system.timezoneOffsetMin,
    );

    return {
      shouldPoll: false,
      reason: `Not due yet (polls every ${effectiveInterval} min${isCharging ? " - charging" : ""})`,
      nextPollTime,
    };
  }

  /**
   * Get the last reading for this system
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    // TODO: Implement reading from point_readings_agg_5m
    return null;
  }

  /**
   * Perform the actual polling
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: TeslaCredentials,
    session: SessionInfo,
    pollReason: string,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    try {
      console.log(
        `[Tesla] Starting poll for system ${system.id} (reason=${pollReason})`,
      );

      const client = new TeslaClient(credentials);

      // Fetch vehicle data
      const vehicleId = credentials.vehicleId || undefined;
      const vehicleData = await client.getVehicleData(vehicleId);

      console.log(
        `[Tesla] Got data for ${vehicleData.display_name} (${vehicleData.vin})`,
      );

      // Update charging state cache for dynamic scheduling
      const isCharging = client.isCharging(vehicleData);
      this.chargingStateCache.set(system.id, isCharging);

      // Extract and store readings
      const readings = this.extractReadings(vehicleData, session.started);

      if (!dryRun) {
        const pointManager = PointManager.getInstance();
        await pointManager.insertPointReadingsRaw(system.id, session, readings);
        console.log(`[Tesla] Inserted ${readings.length} point readings`);
      } else {
        console.log(
          `[Tesla] Dry run - would insert ${readings.length} readings`,
        );
      }

      // Calculate next poll time based on current charging state
      const nextInterval = isCharging
        ? this.chargingPollIntervalMinutes
        : this.pollIntervalMinutes;
      const nextPollTime = getNextMinuteBoundary(
        nextInterval,
        system.timezoneOffsetMin,
      );

      return this.polled(
        null as any, // Tesla doesn't use CommonPollingData
        readings.length,
        nextPollTime,
        {
          vehicleName: vehicleData.display_name,
          vin: vehicleData.vin,
          batteryLevel: vehicleData.charge_state.battery_level,
          chargingState: vehicleData.charge_state.charging_state,
          isCharging,
          odometer: vehicleData.vehicle_state.odometer,
          location: {
            lat: vehicleData.drive_state.latitude,
            lon: vehicleData.drive_state.longitude,
          },
        },
      );
    } catch (error) {
      console.error("[Tesla] Poll error:", error);
      return this.error(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Extract point readings from vehicle data
   */
  private extractReadings(
    data: TeslaVehicleData,
    measurementTime: Date,
  ): Array<{
    pointMetadata: PointMetadata;
    rawValue: any;
    measurementTime: number;
    dataQuality?: string;
  }> {
    const measurementTimeMs = measurementTime.getTime();
    const readings: Array<{
      pointMetadata: PointMetadata;
      rawValue: any;
      measurementTime: number;
      dataQuality?: string;
    }> = [];

    const addReading = (key: TeslaPointKey, value: any) => {
      const meta = TESLA_POINTS[key];
      readings.push({
        pointMetadata: {
          ...meta,
          subsystem: null,
          transform: null,
        },
        rawValue: value,
        measurementTime: measurementTimeMs,
        dataQuality: "good",
      });
    };

    // Charge state
    addReading("battery_soc", data.charge_state.battery_level);
    addReading("usable_battery_soc", data.charge_state.usable_battery_level);
    addReading("battery_range", data.charge_state.battery_range);
    addReading("charge_limit", data.charge_state.charge_limit_soc);
    addReading("charging_state", data.charge_state.charging_state);
    addReading("charge_amps", data.charge_state.charge_amps);
    addReading("charger_voltage", data.charge_state.charger_voltage);
    addReading("charger_power", data.charge_state.charger_power);
    addReading("charge_rate", data.charge_state.charge_rate);
    addReading("time_to_full_charge", data.charge_state.time_to_full_charge);
    addReading(
      "plugged_in",
      data.charge_state.charge_port_latch === "Engaged" ||
        data.charge_state.charging_state !== "Disconnected"
        ? 1
        : 0,
    );

    // Drive state / Location
    addReading("latitude", data.drive_state.latitude);
    addReading("longitude", data.drive_state.longitude);
    addReading("heading", data.drive_state.heading);
    addReading("speed", data.drive_state.speed ?? 0);

    // Vehicle state
    addReading("odometer", data.vehicle_state.odometer);
    addReading("locked", data.vehicle_state.locked ? 1 : 0);
    addReading("sentry_mode", data.vehicle_state.sentry_mode ? 1 : 0);
    addReading("car_version", data.vehicle_state.car_version);

    // Climate state
    if (data.climate_state.inside_temp !== null) {
      addReading("inside_temp", data.climate_state.inside_temp);
    }
    if (data.climate_state.outside_temp !== null) {
      addReading("outside_temp", data.climate_state.outside_temp);
    }
    addReading("climate_on", data.climate_state.is_climate_on ? 1 : 0);

    return readings;
  }

  /**
   * Test connection and discover vehicle
   */
  async testConnection(
    system: SystemWithPolling,
    credentials: TeslaCredentials,
  ): Promise<TestConnectionResult> {
    try {
      console.log("[Tesla] Testing connection...");

      const client = new TeslaClient(credentials);

      // Get vehicle list
      const vehicles = await client.getVehicles();

      if (vehicles.length === 0) {
        return {
          success: false,
          error: "No vehicles found on this Tesla account",
        };
      }

      // Use specified vehicle or first one
      const vehicle = credentials.vehicleId
        ? vehicles.find((v) => v.id === credentials.vehicleId)
        : vehicles[0];

      if (!vehicle) {
        return {
          success: false,
          error: `Vehicle ${credentials.vehicleId} not found`,
        };
      }

      console.log(
        `[Tesla] Found vehicle: ${vehicle.display_name} (${vehicle.vin})`,
      );
      console.log(`[Tesla] Vehicle state: ${vehicle.state}`);

      // Try to get vehicle data
      let vehicleData: TeslaVehicleData | null = null;
      try {
        vehicleData = await client.getVehicleData(vehicle.id);
      } catch (error) {
        console.log(
          `[Tesla] Could not get vehicle data (vehicle may be asleep): ${error}`,
        );
      }

      // Get car type from VIN or config
      const carType = vehicleData?.vehicle_config?.car_type ?? "Tesla";

      return {
        success: true,
        systemInfo: {
          vendorSiteId: vehicle.id,
          displayName: `${vehicle.display_name}`,
          model: carType,
          serial: vehicle.vin,
        },
        latestData: vehicleData
          ? {
              timestamp: new Date(),
              batterySOC: vehicleData.charge_state.battery_level,
              gridW: null,
              solarW: null,
              loadW: null,
              batteryW: vehicleData.charge_state.charger_power * 1000, // kW to W
            }
          : undefined,
        vendorResponse: {
          vehicle,
          vehicleData: vehicleData
            ? {
                batteryLevel: vehicleData.charge_state.battery_level,
                chargingState: vehicleData.charge_state.charging_state,
                odometer: vehicleData.vehicle_state.odometer,
                softwareVersion: vehicleData.vehicle_state.car_version,
              }
            : null,
          allVehicles: vehicles.map((v) => ({
            id: v.id,
            name: v.display_name,
            vin: v.vin,
            state: v.state,
          })),
        },
      };
    } catch (error) {
      console.error("[Tesla] Test connection error:", error);
      return {
        success: false,
        error:
          error instanceof TeslaApiError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Connection failed",
      };
    }
  }
}
