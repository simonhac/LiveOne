import { BaseVendorAdapter } from "../base-adapter";
import type {
  PollingResult,
  TestConnectionResult,
  CredentialField,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import type { SessionInfo } from "@/lib/point/point-manager";
import {
  getNextMinuteBoundary,
  getYesterdayInTimezone,
  getTodayInTimezone,
} from "@/lib/date-utils";
import { abbreviateTariffPeriod } from "./point-metadata";
import type {
  AmberCredentials,
  AmberSite,
  AmberUsageRecord,
  AmberPriceRecord,
} from "./types";
import { updateUsage, updateForecasts } from "./client";
import { setLatestValues, type LatestValue } from "@/lib/latest-values-store";

export class AmberAdapter extends BaseVendorAdapter {
  readonly vendorType = "amber";
  readonly displayName = "Amber Electric";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = true;

  // Amber usage data: poll every 5 minutes
  protected pollIntervalMinutes = 5;
  protected toleranceSeconds = 60;

  // Price forecasts: poll every 5 minutes (separate from usage)
  private readonly priceForecastIntervalMinutes = 5;

  readonly credentialFields: CredentialField[] = [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      placeholder: "psk_...",
      required: true,
      helpText: "Your Amber Electric API key",
    },
    {
      name: "siteId",
      label: "Site ID",
      type: "text",
      placeholder: "Leave empty to auto-discover",
      required: false,
      helpText: "Optional: Specific site ID if you have multiple sites",
    },
  ];

  private baseUrl = "https://api.amber.com.au/v1";
  private siteCache = new Map<string, AmberSite>(); // Cache sites per API key

  /**
   * Override getLastReading - not implemented for Amber yet
   * TODO: Read from point_readings_agg_5m table
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    return null;
  }

  /**
   * Fetch data from Amber API with authentication
   */
  private async fetchWithAuth(url: string, apiKey: string): Promise<any> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Amber API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get site ID - either from credentials or auto-discover
   */
  private async getSiteId(credentials: AmberCredentials): Promise<string> {
    // If siteId provided in credentials, use it
    if (credentials.siteId) {
      return credentials.siteId;
    }

    // Check cache
    const cacheKey = credentials.apiKey;
    if (this.siteCache.has(cacheKey)) {
      return this.siteCache.get(cacheKey)!.id;
    }

    // Fetch sites from API
    const sites: AmberSite[] = await this.fetchWithAuth(
      `${this.baseUrl}/sites`,
      credentials.apiKey,
    );

    if (!sites || sites.length === 0) {
      throw new Error("No sites found for this Amber account");
    }

    // Use first site and cache it
    this.siteCache.set(cacheKey, sites[0]);
    return sites[0].id;
  }

  /**
   * Get site details
   */
  private async getSite(credentials: AmberCredentials): Promise<AmberSite> {
    const cacheKey = credentials.apiKey;

    // Check cache
    if (this.siteCache.has(cacheKey)) {
      const cached = this.siteCache.get(cacheKey)!;
      if (!credentials.siteId || cached.id === credentials.siteId) {
        return cached;
      }
    }

    // Fetch sites
    const sites: AmberSite[] = await this.fetchWithAuth(
      `${this.baseUrl}/sites`,
      credentials.apiKey,
    );

    const site = credentials.siteId
      ? sites.find((s) => s.id === credentials.siteId)
      : sites[0];

    if (!site) {
      throw new Error(
        credentials.siteId
          ? `Site ${credentials.siteId} not found`
          : "No sites found",
      );
    }

    // Cache it
    this.siteCache.set(cacheKey, site);
    return site;
  }

  /**
   * Group usage records by timestamp
   */
  private groupByTimestamp(
    records: AmberUsageRecord[],
  ): Map<string, AmberUsageRecord[]> {
    const grouped = new Map<string, AmberUsageRecord[]>();

    for (const record of records) {
      if (!grouped.has(record.endTime)) {
        grouped.set(record.endTime, []);
      }
      grouped.get(record.endTime)!.push(record);
    }

    return grouped;
  }

  /**
   * Store current period data in KV cache for live dashboard display
   */
  private async storeCurrentPeriodInKV(
    systemId: number,
    currentIntervals: AmberPriceRecord[],
    session: SessionInfo,
  ): Promise<void> {
    // Find import (general) and export (feedIn) channels
    const importRecord = currentIntervals.find(
      (r) => r.channelType === "general",
    );
    const exportRecord = currentIntervals.find(
      (r) => r.channelType === "feedIn",
    );

    if (!importRecord) {
      console.warn("[Amber] No import channel in current interval");
      return;
    }

    // Use the import record's interval timing
    const measurementTimeMs = new Date(importRecord.endTime).getTime();
    const receivedTimeMs = session.started.getTime();
    const periodStartMs = new Date(importRecord.startTime).getTime();
    const periodEndMs = measurementTimeMs;

    const values: LatestValue[] = [
      // Import rate
      {
        value: importRecord.perKwh,
        logicalPath: "bidi.grid.import/rate",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "c/kWh",
        displayName: "Import Price",
      },
      // Renewables proportion
      {
        value: importRecord.renewables,
        logicalPath: "bidi.grid.renewables/proportion",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "%",
        displayName: "Renewables",
      },
      // Price descriptor
      {
        value: importRecord.descriptor,
        logicalPath: "bidi.grid.import/descriptor",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "text",
        displayName: "Price Level",
      },
      // Spike status
      {
        value: importRecord.spikeStatus,
        logicalPath: "bidi.grid.import/spikeStatus",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "text",
        displayName: "Spike Status",
      },
      // Tariff period (if available)
      ...(importRecord.tariffInformation?.period
        ? [
            {
              value:
                abbreviateTariffPeriod(importRecord.tariffInformation.period) ||
                importRecord.tariffInformation.period,
              logicalPath: "bidi.grid.tariff/code",
              measurementTimeMs,
              receivedTimeMs,
              metricUnit: "text",
              displayName: "Tariff Period",
            },
          ]
        : []),
      // Interval timing
      {
        value: periodStartMs,
        logicalPath: "bidi.grid.interval/start",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "ms",
        displayName: "Period Start",
      },
      {
        value: periodEndMs,
        logicalPath: "bidi.grid.interval/end",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "ms",
        displayName: "Period End",
      },
    ];

    // Add export rate if available
    if (exportRecord) {
      values.push({
        value: exportRecord.perKwh,
        logicalPath: "bidi.grid.export/rate",
        measurementTimeMs,
        receivedTimeMs,
        metricUnit: "c/kWh",
        displayName: "Feed-in Price",
      });
    }

    await setLatestValues(systemId, values);
    console.log(
      `[Amber] Stored ${values.length} current period values in KV cache`,
    );
  }

  /**
   * Perform the actual polling
   * Uses audit-based syncing with time-based logic:
   * - Usage: hourly at :10 past or when force poll
   * - Forecasts: every 5 minutes (always)
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: AmberCredentials,
    session: SessionInfo,
    pollReason: string,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    try {
      const isForcePoll = pollReason === "ADMIN" || pollReason === "USER";
      console.log(
        `[Amber] Starting poll for system ${system.id} (reason=${pollReason})`,
      );

      const audits = [];
      let totalRecords = 0;
      let hasError = false;
      let errorMessage: string | undefined;

      // Determine if we should run usage update
      const now = new Date();
      const currentMinute = now.getMinutes();
      const shouldRunUsage = isForcePoll || currentMinute === 10;

      if (shouldRunUsage) {
        // Run usage sync for yesterday (billable data becomes available)
        const yesterday = getYesterdayInTimezone(system.timezoneOffsetMin);
        console.log(`[Amber] Running usage sync for ${yesterday.toString()}`);

        // Add siteId from system to credentials
        const credentialsWithSite: AmberCredentials = {
          ...credentials,
          siteId: system.vendorSiteId || undefined,
        };

        const usageAudit = await updateUsage(
          system.id,
          yesterday,
          1,
          credentialsWithSite,
          session,
          dryRun,
        );
        audits.push(usageAudit);
        totalRecords += usageAudit.summary.numRowsInserted;

        // Check if usage sync failed
        if (!usageAudit.success) {
          hasError = true;
          errorMessage = usageAudit.summary.error || "Usage sync failed";
          console.error(`[Amber] Usage sync failed: ${errorMessage}`);
        }
      }

      // Only run forecast sync if usage didn't fail (or if usage wasn't run)
      if (!hasError) {
        // Run forecast sync for today + tomorrow (2 days)
        const today = getTodayInTimezone(system.timezoneOffsetMin);
        console.log(
          `[Amber] Running forecast sync for ${today.toString()} + 1 day`,
        );

        // Add siteId from system to credentials
        const credentialsWithSite: AmberCredentials = {
          ...credentials,
          siteId: system.vendorSiteId || undefined,
        };

        const forecastAudit = await updateForecasts(
          system.id,
          today,
          2,
          credentialsWithSite,
          session,
          dryRun,
        );
        audits.push(forecastAudit);
        totalRecords += forecastAudit.summary.numRowsInserted;

        // Check if forecast sync failed
        if (!forecastAudit.success) {
          hasError = true;
          const forecastError =
            forecastAudit.summary.error || "Forecast sync failed";
          errorMessage = forecastError;
          console.error(
            `[Amber] Forecast sync failed: ${forecastAudit.summary.error}`,
          );
        } else {
          // Forecast sync succeeded - fetch and store current period in KV for live dashboard
          try {
            const siteId =
              system.vendorSiteId || (await this.getSiteId(credentials));
            const priceData: AmberPriceRecord[] = await this.fetchWithAuth(
              `${this.baseUrl}/sites/${siteId}/prices/current`,
              credentials.apiKey,
            );

            // Find CurrentInterval records and store in KV
            const currentIntervals = priceData.filter(
              (record) => record.type === "CurrentInterval",
            );
            if (currentIntervals.length > 0) {
              await this.storeCurrentPeriodInKV(
                system.id,
                currentIntervals,
                session,
              );
            }
          } catch (kvError) {
            // Don't fail the poll if KV update fails - just log it
            console.error(
              "[Amber] Failed to store current period in KV:",
              kvError,
            );
          }
        }
      } else {
        console.log(`[Amber] Skipping forecast sync because usage sync failed`);
      }

      // Calculate next poll time (5 minutes for forecasts)
      const nextPollTime = getNextMinuteBoundary(
        this.priceForecastIntervalMinutes,
        system.timezoneOffsetMin,
      );

      // Return error if any sync failed
      if (hasError) {
        return this.error(errorMessage || "Sync failed", audits); // Include audits in error response
      }

      return this.polled(
        null as any, // Amber doesn't use common readings table
        totalRecords,
        nextPollTime,
        audits, // Return audit objects as rawResponse
      );
    } catch (error) {
      console.error("[Amber] Poll error:", error);
      return this.error(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Test connection and discover system
   */
  async testConnection(
    system: SystemWithPolling,
    credentials: AmberCredentials,
  ): Promise<TestConnectionResult> {
    try {
      console.log("[Amber] Testing connection");

      // Get site details
      const site = await this.getSite(credentials);

      console.log(`[Amber] Connected to site: ${site.nmi} (${site.network})`);
      console.log(
        `[Amber] Channels: ${site.channels.map((c) => `${c.identifier} (${c.type})`).join(", ")}`,
      );

      // Fetch today's usage as a test
      const today = new Date().toISOString().split("T")[0];
      const usageData: AmberUsageRecord[] = await this.fetchWithAuth(
        `${this.baseUrl}/sites/${site.id}/usage?startDate=${today}&endDate=${today}`,
        credentials.apiKey,
      );

      console.log(
        `[Amber] Retrieved ${usageData.length} usage records for today`,
      );

      // Parse latest data for display (even though we don't have power measurements)
      let latestData = undefined;
      if (usageData && usageData.length > 0) {
        // Group by timestamp and get the most recent
        const grouped = this.groupByTimestamp(usageData);
        const timestamps = Array.from(grouped.keys()).sort();
        const latestTimestamp = timestamps[timestamps.length - 1];
        const latestRecords = grouped.get(latestTimestamp) || [];

        // Find import and export from latest interval
        const importRecord = latestRecords.find(
          (r) => r.channelType === "general",
        );
        const exportRecord = latestRecords.find(
          (r) => r.channelType === "feedIn",
        );

        // Amber provides energy per interval, not instantaneous power
        // We can estimate average power: Wh / (duration in hours)
        const durationHours = (importRecord?.duration || 30) / 60; // 30 min = 0.5 hours

        latestData = {
          timestamp: new Date(latestTimestamp),
          gridW: importRecord
            ? Math.round(
                (importRecord.kwh * 1000) / durationHours -
                  (exportRecord ? exportRecord.kwh * 1000 : 0) / durationHours,
              )
            : null,
          solarW: null, // Amber doesn't provide solar data
          loadW: null, // Could calculate if we had all channels
          batteryW: null,
          batterySOC: null,
        };
      }

      return {
        success: true,
        systemInfo: {
          vendorSiteId: site.id,
          displayName: `Amber - ${site.network} (${site.nmi})`,
          model: "Amber Electric",
          serial: site.nmi,
        },
        latestData,
        vendorResponse: {
          site,
          channelCount: site.channels.length,
          todayRecords: usageData.length,
        },
      };
    } catch (error) {
      console.error("[Amber] Test connection error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
}
