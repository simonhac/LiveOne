import { BaseVendorAdapter } from "../base-adapter";
import type {
  TestConnectionResult,
  CredentialField,
  FetchContext,
  FetchResult,
} from "../types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { CommonPollingData } from "@/lib/types/common";
import {
  SelectronicFetchClient,
  type SelectronicData,
} from "./selectronic-client";
import { SELECTRONIC_POINTS } from "./point-metadata";

/**
 * Vendor adapter for Selectronic/Select.Live devices
 */
export class SelectronicAdapter extends BaseVendorAdapter {
  readonly vendorType = "selectronic";
  readonly displayName = "Selectronic";
  readonly dataSource = "poll" as const;
  readonly supportsAddDevice = true;

  // Selectronic polls every minute
  protected pollIntervalMinutes = 1;

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
   * Fetch data from Selectronic API
   * Base adapter handles session creation, data insertion, and session completion
   */
  protected async fetchData(
    device: DeviceConfigView,
    credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    try {
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: device.vendorSiteId,
      });

      // Try to use cached auth if available
      const cacheKey = `${credentials.email}:${device.vendorSiteId}`;
      const cached = SelectronicAdapter.authCache.get(cacheKey);

      // If no valid cache, authenticate
      if (!cached || cached.expires < Date.now() + 300000) {
        console.log(
          `[Selectronic] Authenticating for system ${device.vendorSiteId}...`,
        );
        const authResult = await client.authenticate();

        if (!authResult) {
          return { success: false, error: "Authentication failed" };
        }

        // Cache for 25 minutes (auth lasts 30 minutes)
        SelectronicAdapter.authCache.set(cacheKey, {
          cookie: "authenticated",
          expires: Date.now() + 25 * 60 * 1000,
        });
      }

      const response = await client.fetchData();
      if (!response.success || !response.data) {
        return {
          success: false,
          error: response.error || "Failed to fetch data",
        };
      }

      const vendorData = response.data;
      const transformed = this.transformData(vendorData);
      const measurementTime = vendorData.timestamp.getTime();

      // Build readings array from all configured points
      const readings = [];
      for (const pointConfig of SELECTRONIC_POINTS) {
        let rawValue = vendorData[pointConfig.field];

        // Skip null/undefined values
        if (rawValue == null) {
          continue;
        }

        // Replace 0 with null for fault_code and fault_ts (no fault = null)
        if (
          (pointConfig.metadata.physicalPathTail.endsWith("/fault_code") ||
            pointConfig.metadata.physicalPathTail.endsWith("/fault_ts")) &&
          rawValue === 0
        ) {
          continue;
        }

        // Convert energy totals from kWh to Wh (multiply by 1000)
        if (pointConfig.metadata.metricType === "energy") {
          rawValue = Math.round(Number(rawValue) * 1000);
        }

        readings.push({
          pointMetadata: pointConfig.metadata,
          rawValue,
          measurementTime,
          dataQuality: "good" as const,
          error: null,
        });
      }

      console.log(
        `[Selectronic] Fetch successful -`,
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
        `- ${readings.length} points`,
      );

      return {
        success: true,
        readings,
        recordsProcessed: readings.length,
        rawResponse: response.rawResponse,
      };
    } catch (error) {
      console.error(
        `[Selectronic] Error fetching data for system ${device.id}:`,
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  async testConnection(
    device: DeviceConfigView,
    credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      // If no vendorSiteId provided, we need to discover available devices
      if (!device.vendorSiteId) {
        const discoveryClient = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: "", // Empty to discover devices
        });

        // Authenticate first
        const authSuccess = await discoveryClient.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: "Failed to authenticate with Select.Live",
          };
        }

        // Get available devices
        const availableDevices = await discoveryClient.getDevicesList();

        if (!availableDevices || availableDevices.length === 0) {
          return {
            success: false,
            error: "No systems found for this Select.Live account",
          };
        }

        // Use the first device (in future we could let user choose)
        const firstDevice = availableDevices[0];
        const vendorSiteId =
          firstDevice.serialNumber || firstDevice.systemNumber;

        // Now test with the discovered device
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

        const deviceInfo = await client.fetchDeviceInfo();
        const latestData = this.transformData(result.data);

        return {
          success: true,
          deviceInfo: {
            vendorSiteId,
            displayName: firstDevice.name || `Selectronic ${vendorSiteId}`,
            model: deviceInfo?.model || firstDevice.model || "SP PRO",
            serial: deviceInfo?.serial || firstDevice.serialNumber,
            solarSize: deviceInfo?.solarSize,
            batterySize: deviceInfo?.batterySize,
            ratings: deviceInfo?.ratings,
          },
          latestData,
          vendorResponse: { devices: availableDevices, data: result.data.raw },
        };
      }

      // Normal flow when vendorSiteId is provided
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: device.vendorSiteId,
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

      // Also fetch device info
      const deviceInfo = await client.fetchDeviceInfo();
      console.log(
        "[Selectronic] System info received:",
        JSON.stringify(deviceInfo, null, 2),
      );

      const latestData = this.transformData(result.data);

      return {
        success: true,
        deviceInfo: deviceInfo || undefined,
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
