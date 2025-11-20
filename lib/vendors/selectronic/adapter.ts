import { BaseVendorAdapter } from "../base-adapter";
import type {
  PollingResult,
  TestConnectionResult,
  CredentialField,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { CommonPollingData } from "@/lib/types/common";
import {
  SelectronicFetchClient,
  type SelectronicData,
} from "./selectronic-client";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import {
  insertPointReadingsBatch,
  type PointMetadata,
} from "@/lib/monitoring-points-manager";
import { SELECTRONIC_POINTS } from "./point-metadata";

/**
 * Vendor adapter for Selectronic/Select.Live systems
 */
export class SelectronicAdapter extends BaseVendorAdapter {
  readonly vendorType = "selectronic";
  readonly displayName = "Selectronic";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = true;

  // Selectronic polls every minute
  protected pollIntervalMinutes = 1;
  protected toleranceSeconds = 30;

  readonly credentialFields: CredentialField[] = [
    {
      name: "email",
      label: "Email",
      type: "email",
      placeholder: "your@email.com",
      required: true,
      helpText: "Your Select.Live account email",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Enter your password",
      required: true,
      helpText: "Your Select.Live account password",
    },
  ];

  // Cache for auth cookies
  private static authCache = new Map<
    string,
    { cookie: string; expires: number }
  >();

  /**
   * Perform the actual polling
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    now: Date,
    sessionId: number,
    isUserOriginated: boolean,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    try {
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: system.vendorSiteId,
      });

      // Try to use cached auth if available
      const cacheKey = `${credentials.email}:${system.vendorSiteId}`;
      const cached = SelectronicAdapter.authCache.get(cacheKey);

      // If no valid cache, authenticate
      if (!cached || cached.expires < Date.now() + 300000) {
        console.log(
          `[Selectronic] Authenticating for system ${system.vendorSiteId}...`,
        );
        const authResult = await client.authenticate();

        if (!authResult) {
          return this.error("Authentication failed");
        }

        // Cache for 25 minutes (auth lasts 30 minutes)
        SelectronicAdapter.authCache.set(cacheKey, {
          cookie: "authenticated",
          expires: Date.now() + 25 * 60 * 1000,
        });
      }

      const response = await client.fetchData();
      if (!response.success || !response.data) {
        return this.error(response.error || "Failed to fetch data");
      }

      const vendorData = response.data;
      const transformed = this.transformData(vendorData);

      // Insert into point_readings table
      const measurementTime = vendorData.timestamp.getTime();
      const receivedTime = Date.now();
      const readingsToInsert = [];

      // Build readings array from all configured points
      for (const pointConfig of SELECTRONIC_POINTS) {
        let rawValue = vendorData[pointConfig.field];

        // Skip null/undefined values
        if (rawValue == null) {
          continue;
        }

        // Replace 0 with null for fault_code and fault_ts (no fault = null)
        if (
          (pointConfig.metadata.originSubId === "fault_code" ||
            pointConfig.metadata.originSubId === "fault_ts") &&
          rawValue === 0
        ) {
          continue;
        }

        // Convert energy totals from kWh to Wh (multiply by 1000)
        if (pointConfig.metadata.metricType === "energy") {
          rawValue = Math.round(Number(rawValue) * 1000);
        }

        readingsToInsert.push({
          pointMetadata: pointConfig.metadata,
          rawValue,
          measurementTime,
          receivedTime,
          dataQuality: "good" as const,
          sessionId: sessionId,
          error: null,
        });
      }

      // Batch insert all readings - this will automatically ensure point_info entries exist
      await insertPointReadingsBatch(system.id, readingsToInsert);

      console.log(
        `[Selectronic] Poll successful -`,
        "Solar:",
        transformed.solarW,
        "W",
        "Load:",
        transformed.loadW,
        "W",
        "Battery:",
        transformed.batteryW,
        "W",
        "SOC:",
        transformed.batterySOC != null
          ? transformed.batterySOC.toFixed(1) + "%"
          : "N/A",
        `- ${readingsToInsert.length} points inserted`,
      );

      // Calculate next poll time at the beginning of the next minute
      const nextPollTime = getNextMinuteBoundary(1, system.timezoneOffsetMin); // 1-minute interval

      // Still insert into readings table for backward compatibility
      return this.polled(
        transformed,
        1,
        nextPollTime,
        response.rawResponse, // Pass the raw response object
      );
    } catch (error) {
      console.error(`[Selectronic] Error polling system ${system.id}:`, error);
      return this.error(error instanceof Error ? error : "Unknown error");
    }
  }
  async testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      // If no vendorSiteId provided, we need to discover available systems
      if (!system.vendorSiteId) {
        const discoveryClient = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: "", // Empty to discover systems
        });

        // Authenticate first
        const authSuccess = await discoveryClient.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: "Failed to authenticate with Select.Live",
          };
        }

        // Get available systems
        const availableSystems = await discoveryClient.getSystemsList();

        if (!availableSystems || availableSystems.length === 0) {
          return {
            success: false,
            error: "No systems found for this Select.Live account",
          };
        }

        // Use the first system (in future we could let user choose)
        const firstSystem = availableSystems[0];
        const vendorSiteId =
          firstSystem.serialNumber || firstSystem.systemNumber;

        // Now test with the discovered system
        const client = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: vendorSiteId,
        });

        const result = await client.fetchData();
        if (!result.success || !result.data) {
          return {
            success: false,
            error: result.error || "Failed to fetch data from Select.Live",
          };
        }

        const systemInfo = await client.fetchSystemInfo();
        const latestData = this.transformData(result.data);

        return {
          success: true,
          systemInfo: {
            vendorSiteId,
            displayName: firstSystem.name || `Selectronic ${vendorSiteId}`,
            model: systemInfo?.model || firstSystem.model || "SP PRO",
            serial: systemInfo?.serial || firstSystem.serialNumber,
            solarSize: systemInfo?.solarSize,
            batterySize: systemInfo?.batterySize,
            ratings: systemInfo?.ratings,
          },
          latestData,
          vendorResponse: { systems: availableSystems, data: result.data.raw },
        };
      }

      // Normal flow when vendorSiteId is provided
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: system.vendorSiteId,
      });

      // Authenticate
      const authSuccess = await client.authenticate();
      if (!authSuccess) {
        return {
          success: false,
          error: "Failed to authenticate with Select.Live",
        };
      }

      // Fetch current data
      const result = await client.fetchData();
      if (!result.success || !result.data) {
        return {
          success: false,
          error: result.error || "Failed to fetch data from Select.Live",
        };
      }

      // Also fetch system info
      const systemInfo = await client.fetchSystemInfo();
      console.log(
        "[Selectronic] System info received:",
        JSON.stringify(systemInfo, null, 2),
      );

      const latestData = this.transformData(result.data);

      return {
        success: true,
        systemInfo: systemInfo || undefined,
        latestData,
        vendorResponse: result.data.raw, // Include raw vendor response
      };
    } catch (error) {
      console.error("Error testing Selectronic connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Transform Selectronic vendor data to common format
   */
  private transformData(vendorData: SelectronicData): CommonPollingData {
    return {
      timestamp: vendorData.timestamp, // Already a Date object from client
      solarW: vendorData.solarW,
      solarLocalW: vendorData.shuntW, // Map old field name
      solarRemoteW: vendorData.solarInverterW, // Map old field name
      loadW: vendorData.loadW,
      batteryW: vendorData.batteryW,
      gridW: vendorData.gridW,
      batterySOC: vendorData.batterySOC,
      faultCode:
        vendorData.faultCode != null && vendorData.faultCode !== 0
          ? String(vendorData.faultCode)
          : null,
      faultTimestamp:
        vendorData.faultTimestamp != null && vendorData.faultTimestamp !== 0
          ? new Date(vendorData.faultTimestamp * 1000)
          : null, // Convert Unix timestamp to Date, 0 to null
      generatorStatus: vendorData.generatorStatus || null, // Convert 0 to null when no generator
      // Lifetime totals
      solarKwhTotal: vendorData.solarKwhTotal,
      loadKwhTotal: vendorData.loadKwhTotal,
      batteryInKwhTotal: vendorData.batteryInKwhTotal,
      batteryOutKwhTotal: vendorData.batteryOutKwhTotal,
      gridInKwhTotal: vendorData.gridInKwhTotal,
      gridOutKwhTotal: vendorData.gridOutKwhTotal,
    };
  }
}
