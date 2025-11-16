import { BaseVendorAdapter } from "../base-adapter";
import type {
  PollingResult,
  TestConnectionResult,
  CredentialField,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { insertPointReadingsDirectTo5m } from "@/lib/monitoring-points-manager";
import {
  createChannelPoints,
  getChannelMetadata,
  createRenewablesPoint,
  createSpotPricePoint,
  createTariffPeriodPoint,
  abbreviateTariffPeriod,
} from "./point-metadata";
import type {
  AmberCredentials,
  AmberSite,
  AmberUsageRecord,
  AmberPriceRecord,
  AmberChannelMetadata,
} from "./types";

export class AmberAdapter extends BaseVendorAdapter {
  readonly vendorType = "amber";
  readonly displayName = "Amber Electric";
  readonly dataSource = "poll" as const;
  readonly dataStore = "point_readings" as const;
  readonly supportsAddSystem = true;

  // Amber usage data: poll every 30 minutes
  protected pollIntervalMinutes = 30;
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
   * Get channel metadata for all channels in a site
   */
  private getChannelMetadataList(site: AmberSite): AmberChannelMetadata[] {
    return site.channels.map((channel) =>
      getChannelMetadata(channel.identifier, channel.type),
    );
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
   * Poll usage data (energy, cost, price actuals)
   * Fetches yesterday + today to catch quality upgrades (estimated → billable)
   */
  private async pollUsageData(
    system: SystemWithPolling,
    credentials: AmberCredentials,
    sessionId: number,
  ): Promise<number> {
    const siteId = system.vendorSiteId || (await this.getSiteId(credentials));
    const site = await this.getSite(credentials);

    // Fetch yesterday + today to catch quality upgrades
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const startDate = yesterday.toISOString().split("T")[0];
    const endDate = today.toISOString().split("T")[0];

    console.log(`[Amber] Fetching usage data from ${startDate} to ${endDate}`);

    // Fetch usage data
    const usageData: AmberUsageRecord[] = await this.fetchWithAuth(
      `${this.baseUrl}/sites/${siteId}/usage?startDate=${startDate}&endDate=${endDate}`,
      credentials.apiKey,
    );

    if (!usageData || usageData.length === 0) {
      console.log("[Amber] No usage data returned");
      return 0;
    }

    // Group by timestamp
    const grouped = this.groupByTimestamp(usageData);

    // Get channel metadata
    const channels = this.getChannelMetadataList(site);

    // Convert to point readings for 5m aggregates
    const readingsToInsert = [];

    for (const [endTime, records] of grouped.entries()) {
      // Parse endTime to milliseconds (endTime is ISO 8601 UTC string)
      const intervalEndMs = new Date(endTime).getTime();

      // Extract grid market data from first record (same across all channels)
      const firstRecord = records[0];
      const quality = firstRecord.quality;

      // Add system-level grid market data points (once per timestamp)
      readingsToInsert.push({
        pointMetadata: createRenewablesPoint(),
        rawValue: firstRecord.renewables, // percentage
        intervalEndMs,
        dataQuality: quality,
      });

      readingsToInsert.push({
        pointMetadata: createSpotPricePoint(),
        rawValue: firstRecord.spotPerKwh, // cents/kWh
        intervalEndMs,
        dataQuality: quality,
      });

      // Add tariff period from general (import) channel
      // Note: tariffInformation only exists on general channel, not feedIn
      const generalRecord = records.find((r) => r.channelType === "general");
      if (generalRecord?.tariffInformation?.period) {
        const abbreviatedPeriod = abbreviateTariffPeriod(
          generalRecord.tariffInformation.period,
        );
        if (abbreviatedPeriod) {
          readingsToInsert.push({
            pointMetadata: createTariffPeriodPoint(),
            rawValue: abbreviatedPeriod, // "pk", "op", "sh", or "ss"
            intervalEndMs,
          });
        }
      }

      // Process each channel's data
      for (const record of records) {
        // Find matching channel metadata
        const channel = channels.find(
          (c) => c.channelId === record.channelIdentifier,
        );

        if (!channel) {
          console.warn(
            `[Amber] Unknown channel: ${record.channelIdentifier} (${record.channelType})`,
          );
          continue;
        }

        // Create all three points for this channel: energy, cost/revenue, price
        const points = createChannelPoints(channel);

        // Each record has its own quality flag - use it for all three points from this record
        const recordQuality = record.quality;

        // Energy point
        readingsToInsert.push({
          pointMetadata: points[0], // energy
          rawValue: record.kwh * 1000, // kWh → Wh
          intervalEndMs,
          dataQuality: recordQuality,
        });

        // Cost/Revenue point
        readingsToInsert.push({
          pointMetadata: points[1], // cost or revenue
          rawValue: Math.abs(record.cost), // cents (negative for export becomes positive revenue)
          intervalEndMs,
          dataQuality: recordQuality,
        });

        // Price point
        readingsToInsert.push({
          pointMetadata: points[2], // price
          rawValue: Math.abs(record.perKwh), // c/kWh (negative for export becomes positive)
          intervalEndMs,
          dataQuality: recordQuality,
        });
      }
    }

    // Insert all readings directly to 5m aggregates
    await insertPointReadingsDirectTo5m(system.id, sessionId, readingsToInsert);

    console.log(
      `[Amber] Inserted ${readingsToInsert.length} usage readings (${grouped.size} timestamps)`,
    );

    return readingsToInsert.length;
  }

  /**
   * Poll price forecast data
   * Stores future prices with quality="forecast"
   */
  private async pollPriceForecast(
    system: SystemWithPolling,
    credentials: AmberCredentials,
    sessionId: number,
  ): Promise<number> {
    const siteId = system.vendorSiteId || (await this.getSiteId(credentials));
    const site = await this.getSite(credentials);

    console.log("[Amber] Fetching price forecasts");

    // Fetch price data (includes historical + current + forecast)
    const priceData: AmberPriceRecord[] = await this.fetchWithAuth(
      `${this.baseUrl}/sites/${siteId}/prices`,
      credentials.apiKey,
    );

    if (!priceData || priceData.length === 0) {
      console.log("[Amber] No price data returned");
      return 0;
    }

    // Filter to only forecast intervals (future data)
    const forecasts = priceData.filter(
      (record) => record.type === "ForecastInterval",
    );

    if (forecasts.length === 0) {
      console.log("[Amber] No forecast intervals in price data");
      return 0;
    }

    // Get channel metadata
    const channels = this.getChannelMetadataList(site);

    // Convert to point readings
    const readingsToInsert = [];

    for (const record of forecasts) {
      // Find matching channel metadata
      const channel = channels.find(
        (c) => c.channelType === record.channelType,
      );

      if (!channel) {
        console.warn(
          `[Amber] Unknown channel type in forecast: ${record.channelType}`,
        );
        continue;
      }

      // Parse endTime to milliseconds (endTime is ISO 8601 UTC string)
      const intervalEndMs = new Date(record.endTime).getTime();

      // Create price point for this forecast
      const points = createChannelPoints(channel);
      const pricePoint = points[2]; // price is the third point

      readingsToInsert.push({
        pointMetadata: pricePoint,
        rawValue: Math.abs(record.perKwh), // c/kWh
        intervalEndMs,
        dataQuality: "forecast",
      });
    }

    // Insert forecast prices directly to 5m aggregates
    await insertPointReadingsDirectTo5m(system.id, sessionId, readingsToInsert);

    console.log(`[Amber] Inserted ${readingsToInsert.length} price forecasts`);

    return readingsToInsert.length;
  }

  /**
   * Perform the actual polling
   * Polls both usage data (every 30 min) and price forecasts (every 5 min)
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: AmberCredentials,
    now: Date,
    sessionId: number,
  ): Promise<PollingResult> {
    try {
      console.log(`[Amber] Starting poll for system ${system.id}`);

      let totalRecords = 0;

      // Always poll price forecasts (every 5 minutes)
      const forecastRecords = await this.pollPriceForecast(
        system,
        credentials,
        sessionId,
      );
      totalRecords += forecastRecords;

      // Poll usage data based on schedule (every 30 minutes)
      // Check if enough time has passed since last usage poll
      // For now, always poll usage - the base class handles scheduling
      const usageRecords = await this.pollUsageData(
        system,
        credentials,
        sessionId,
      );
      totalRecords += usageRecords;

      // Calculate next poll time
      // We poll every 5 minutes for forecasts, but the base class uses pollIntervalMinutes (30)
      // So we'll return 5 minutes for more frequent polling
      const nextPollTime = getNextMinuteBoundary(
        this.priceForecastIntervalMinutes,
        system.timezoneOffsetMin,
      );

      return this.polled(
        null as any, // Amber doesn't use common readings table
        totalRecords,
        nextPollTime,
        { usageRecords, forecastRecords },
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
