import type {
  VendorAdapter,
  PollingResult,
  TestConnectionResult,
} from "./types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { CommonPollingData } from "@/lib/types/common";
import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import { getNextMinuteBoundary } from "@/lib/date-utils";

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
   * Check if system should be polled based on schedule
   * @param system - The system to check
   * @param isUserOriginated - If true, always returns { shouldPoll: true }
   * @param now - Current time
   * @returns Object with shouldPoll flag, reason if skipped, and nextPoll time
   */
  async shouldPoll(
    system: SystemWithPolling,
    isUserOriginated: boolean,
    now: Date,
  ): Promise<{
    shouldPoll: boolean;
    reason?: string;
    nextPoll?: ZonedDateTime;
  }> {
    if (this.dataSource === "push") {
      return {
        shouldPoll: false,
        reason: `${this.vendorType} is a push-only system`,
      };
    }

    if (isUserOriginated) {
      return { shouldPoll: true };
    }

    const lastPollTime = await this.getLastPollTime(system);
    const evaluation = this.evaluateSchedule(system, lastPollTime, now);

    return {
      shouldPoll: evaluation.shouldPoll,
      reason: evaluation.reason,
      nextPoll: evaluation.nextPollTime,
    };
  }

  /**
   * Poll for new data. Only applicable for poll-based systems.
   * Push-only systems should not override this method.
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param isUserOriginated - If true, bypass rate limiting and poll immediately
   * @param now - Current time from cron job
   * @param sessionId - The session ID to associate with this polling operation
   * @param dryRun - If true, skip database writes (for testing/debugging)
   */
  async poll(
    system: SystemWithPolling,
    credentials: any,
    isUserOriginated: boolean,
    now: Date,
    sessionId: number,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    const check = await this.shouldPoll(system, isUserOriginated, now);

    if (!check.shouldPoll) {
      return this.skipped(check.reason || "Skipped", check.nextPoll);
    }

    // Delegate to the actual polling implementation
    return this.doPoll(
      system,
      credentials,
      now,
      sessionId,
      isUserOriginated,
      dryRun,
    );
  }

  /**
   * Method that polling subclasses must implement for actual polling
   * Push-only systems will never call this
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param now - Current time from cron job
   * @param sessionId - The session ID to associate with this polling operation
   * @param isUserOriginated - If true, the poll was triggered manually by a user
   * @param dryRun - If true, skip database writes (for testing/debugging)
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    now: Date,
    sessionId: number,
    isUserOriginated: boolean,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    // Default implementation for push-only systems (should never be called)
    return this.error("This vendor does not support polling");
  }

  /**
   * Get the latest reading for this system.
   * Default implementation returns null - adapters should override this
   * to provide their own implementation using point_readings data.
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    // Default returns null - adapters override with their own implementation
    return null;
  }

  /**
   * Test connection with vendor. Only poll-based systems can test connections.
   */
  async testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult> {
    if (this.dataSource !== "poll") {
      return {
        success: false,
        error: `${this.displayName} systems do not support connection testing`,
      };
    }
    // Polling adapters must override this method
    throw new Error(`testConnection() not implemented for ${this.vendorType}`);
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
  protected error(error: string | Error, rawResponse?: any): PollingResult {
    return {
      action: "ERROR",
      error: error instanceof Error ? error.message : error,
      rawResponse,
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
