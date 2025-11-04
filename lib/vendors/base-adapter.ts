import type {
  VendorAdapter,
  PollingResult,
  TestConnectionResult,
  Capability,
} from "./types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { CommonPollingData } from "@/lib/types/common";
import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import { fromDate } from "@internationalized/date";
import { db } from "@/lib/db";
import { readings } from "@/lib/db/schema";
import { pointInfo } from "@/lib/db/schema-monitoring-points";
import { eq, desc } from "drizzle-orm";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { GENERIC_READINGS_CAPABILITIES } from "@/lib/readings/generic-readings-capabilities";

/**
 * Base adapter class that provides common functionality
 * Vendor-specific adapters can extend this class
 */
/**
 * Result from evaluating the polling schedule
 */
export interface ScheduleEvaluation {
  shouldPoll: boolean;
  reason: string;
  nextPollTime: ZonedDateTime;
}

export abstract class BaseVendorAdapter implements VendorAdapter {
  abstract readonly vendorType: string;
  abstract readonly displayName: string;
  abstract readonly dataSource: "poll" | "push" | "combined";
  readonly dataStore: "readings" | "point_readings" = "readings"; // Default to readings table

  // Polling schedule configuration
  protected pollIntervalMinutes = 1; // Default to 1 minute
  protected toleranceSeconds = 30; // Default to 30 seconds tolerance

  /**
   * Evaluate whether this system should be polled now
   * @param system - The system to evaluate
   * @param lastPollTime - Time of last poll
   * @param now - Current time
   * @returns Evaluation result with shouldPoll flag, reason, and next poll time
   */
  protected evaluateSchedule(
    system: SystemWithPolling,
    lastPollTime: Date | null,
    now: Date,
  ): ScheduleEvaluation {
    const targetIntervalMs = this.pollIntervalMinutes * 60 * 1000;
    const toleranceMs = this.toleranceSeconds * 1000;

    // If never polled, poll now
    if (!lastPollTime) {
      // Next poll will be one interval from now, aligned to minute boundary
      const nextPollTime = getNextMinuteBoundary(
        this.pollIntervalMinutes,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: "Never polled",
        nextPollTime,
      };
    }

    const msSinceLastPoll = now.getTime() - lastPollTime.getTime();

    // Check if we've reached the interval (with tolerance for delays)
    if (msSinceLastPoll >= targetIntervalMs - toleranceMs) {
      // Next poll will be one interval from now, aligned to minute boundary
      const nextPollTime = getNextMinuteBoundary(
        this.pollIntervalMinutes,
        system.timezoneOffsetMin,
      );
      return {
        shouldPoll: true,
        reason: `Interval reached (${this.pollIntervalMinutes} min)`,
        nextPollTime,
      };
    }

    // Not time yet - calculate when next poll should be, aligned to minute boundary
    const nextPollTime = getNextMinuteBoundary(
      this.pollIntervalMinutes,
      system.timezoneOffsetMin,
    );

    return {
      shouldPoll: false,
      reason: `Not due yet (polls every ${this.pollIntervalMinutes} min)`,
      nextPollTime,
    };
  }

  /**
   * Get the last poll time for this system
   * Uses the polling status that's already loaded with the system
   * @param system - The system to check
   * @returns Time of last poll, or null if never polled
   */
  protected async getLastPollTime(
    system: SystemWithPolling,
  ): Promise<Date | null> {
    // The polling status is already loaded with the system from SystemsManager
    return system.pollingStatus?.lastPollTime || null;
  }

  /**
   * Poll for new data. Only applicable for poll-based systems.
   * Push-only systems should not override this method.
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param force - If true, bypass rate limiting and poll immediately
   * @param now - Current time from cron job
   */
  async poll(
    system: SystemWithPolling,
    credentials: any,
    force: boolean,
    now: Date,
    sessionId: number,
  ): Promise<PollingResult> {
    if (this.dataSource === "push") {
      console.error(
        `[${this.vendorType}] poll() called on push-only system ${system.id}. This should never happen.`,
      );
      return this.error(
        `${this.vendorType} is a push-only system and should not be polled`,
      );
    }

    // Check schedule unless forced
    if (!force) {
      const lastPollTime = await this.getLastPollTime(system);
      const evaluation = this.evaluateSchedule(system, lastPollTime, now);

      if (!evaluation.shouldPoll) {
        // nextPollTime is already a ZonedDateTime
        return this.skipped(evaluation.reason, evaluation.nextPollTime);
      }
    }

    // Delegate to the actual polling implementation
    return this.doPoll(system, credentials, now, sessionId);
  }

  /**
   * Method that polling subclasses must implement for actual polling
   * Push-only systems will never call this
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param now - Current time from cron job
   * @param sessionId - The session ID to associate with this polling operation
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    now: Date,
    sessionId: number,
  ): Promise<PollingResult> {
    // Default implementation for push-only systems (should never be called)
    return this.error("This vendor does not support polling");
  }

  /**
   * Get the latest reading for this system.
   * Default implementation reads from the readings table.
   * Adapters can override for custom behavior (e.g., CraigHack combines systems).
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    const [latestReading] = await db
      .select()
      .from(readings)
      .where(eq(readings.systemId, systemId))
      .orderBy(desc(readings.inverterTime))
      .limit(1);

    if (!latestReading) {
      return null;
    }

    return {
      timestamp: latestReading.inverterTime,
      receivedTime: latestReading.createdAt,

      solar: {
        powerW: latestReading.solarW,
        localW: latestReading.solarLocalW,
        remoteW: latestReading.solarRemoteW,
      },

      battery: {
        powerW: latestReading.batteryW,
        soc: latestReading.batterySOC,
      },

      load: {
        powerW: latestReading.loadW,
      },

      grid: {
        powerW: latestReading.gridW,
        generatorStatus: latestReading.generatorStatus,
      },

      connection: {
        faultCode:
          latestReading.faultCode != null
            ? String(latestReading.faultCode)
            : null,
        faultTimestamp: latestReading.faultTimestamp,
      },
    };
  }

  /**
   * Test connection with vendor. Push-only systems return an error by default.
   */
  async testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult> {
    if (this.dataSource === "push") {
      return {
        success: false,
        error: `${this.displayName} systems are push-only and cannot test outgoing connections`,
      };
    }
    // Polling adapters must override this method
    throw new Error(`testConnection() not implemented for ${this.vendorType}`);
  }

  /**
   * Get all possible capabilities for this system (what it could support).
   * Default implementation returns capabilities based on data store type.
   * Returns array of capability strings in format: type.subtype.extension (subtype and extension optional)
   */
  async getPossibleCapabilities(systemId: number): Promise<string[]> {
    if (this.dataStore === "readings") {
      // Return standard capabilities for generic readings table
      return GENERIC_READINGS_CAPABILITIES;
    } else {
      // Query point_info table for point_readings systems
      const points = await db
        .select()
        .from(pointInfo)
        .where(eq(pointInfo.systemId, systemId));

      // Extract unique capabilities as strings
      const capabilitySet = new Set<string>();

      for (const point of points) {
        if (point.type) {
          // Build capability string: type.subtype.extension (omitting nulls)
          const parts = [point.type];
          if (point.subtype) parts.push(point.subtype);
          if (point.extension) parts.push(point.extension);
          capabilitySet.add(parts.join("."));
        }
      }

      return Array.from(capabilitySet).sort();
    }
  }

  /**
   * Get enabled capabilities for this system (what is currently enabled).
   * Note: This method is deprecated. Capabilities are now managed at the point level via point_info.active.
   * For backwards compatibility, this now always returns all possible capabilities.
   * Returns array of capability strings in format: type.subtype.extension (subtype and extension optional)
   */
  async getEnabledCapabilities(systemId: number): Promise<string[]> {
    // Always return all possible capabilities (filtering is now done at point level)
    return this.getPossibleCapabilities(systemId);
  }

  /**
   * Helper to create a SKIPPED result
   */
  protected skipped(reason: string, nextPoll?: ZonedDateTime): PollingResult {
    return {
      action: "SKIPPED",
      reason,
      nextPoll,
    };
  }

  /**
   * Helper to create an ERROR result
   */
  protected error(error: string | Error): PollingResult {
    return {
      action: "ERROR",
      error: error instanceof Error ? error.message : error,
    };
  }

  /**
   * Helper to create a POLLED result
   */
  protected polled(
    data: CommonPollingData | CommonPollingData[],
    recordsProcessed: number,
    nextPoll?: ZonedDateTime,
    rawResponse?: any,
  ): PollingResult {
    return {
      action: "POLLED",
      data,
      rawResponse,
      recordsProcessed,
      nextPoll,
    };
  }
}
