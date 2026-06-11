import type {
  VendorAdapter,
  PollingResult,
  TestConnectionResult,
  PollOptions,
  FetchContext,
  FetchResult,
  PollStage,
} from "./types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import { sessionManager } from "@/lib/session-manager";
import {
  createPollCollector,
  type PollCollector,
} from "@/lib/observations/poll-collector";
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
} from "@/lib/polling-utils";

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
   * @param forcePollAll - If true, always returns { shouldPoll: true }
   * @param now - Current time
   * @returns Object with shouldPoll flag, reason if skipped, and nextPoll time
   */
  async shouldPoll(
    system: SystemWithPolling,
    forcePollAll: boolean,
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

    if (forcePollAll) {
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
   * Poll for new data using template method pattern.
   * Handles full lifecycle: check schedule → create session → fetch data → process → complete session
   *
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param options - Poll options including sessionLabel, cause, dryRun, and onProgress callback
   */
  async poll(
    system: SystemWithPolling,
    credentials: any,
    options: PollOptions,
  ): Promise<PollingResult> {
    const {
      forcePollAll,
      pollReason,
      sessionLabel,
      sessionCause,
      dryRun = false,
      onSessionStart,
      onProgress,
    } = options;
    const startedAt = new Date();
    const stages: PollStage[] = [];

    // 1. Check shouldPoll
    const check = await this.shouldPoll(system, forcePollAll, startedAt);
    if (!check.shouldPoll) {
      return this.skipped(check.reason, check.nextPoll);
    }

    // 2. Create session
    const session = await sessionManager.createSession({
      sessionLabel,
      systemId: system.id,
      cause: sessionCause,
      started: startedAt,
    });

    // Buffer this poll's observations so we can emit ONE combined QStash message
    // (session + all readings) at session close, on both success and failure.
    const collector = createPollCollector();

    // 3. Notify caller that session has started (for SSE updates)
    if (onSessionStart) {
      onSessionStart({
        systemId: system.id,
        sessionId: session.id,
        sessionLabel,
      });
    }

    // Helper to send progress updates every 200ms during a stage
    // Defined after session creation so it can include sessionId/sessionLabel
    const withProgress = async <T>(
      stageName: "fetch" | "process",
      fn: () => Promise<T>,
    ): Promise<T> => {
      const stageStart = Date.now();
      stages.push({ name: stageName, startMs: stageStart, endMs: stageStart });

      let interval: NodeJS.Timeout | null = null;
      if (onProgress) {
        interval = setInterval(() => {
          stages[stages.length - 1].endMs = Date.now();
          onProgress({
            action: "POLLED",
            sessionId: session.id,
            sessionLabel,
            stages: [...stages],
            inProgress: true,
          });
        }, 200);
      }

      try {
        const result = await fn();
        stages[stages.length - 1].endMs = Date.now();
        return result;
      } finally {
        if (interval) clearInterval(interval);
      }
    };

    try {
      // 3. Fetch data (vendor implementation) - track "fetch" stage with live updates
      const result = await withProgress("fetch", () =>
        this.fetchData(system, credentials, {
          startedAt,
          dryRun,
          session,
          collector,
        }),
      );

      if (!result.success) {
        await this.completeSessionError(
          system.id,
          session,
          startedAt,
          result,
          collector,
        );
        return this.error(
          result.error || "Unknown error",
          result.rawResponse,
          stages,
        );
      }

      // 4. Process: Insert readings + publish to queue - track "process" stage with live updates
      const recordsProcessed = await withProgress("process", async () => {
        if (dryRun) return result.recordsProcessed ?? 0;
        const insertedCount = await this.insertAndPublishReadings(
          system.id,
          session,
          result,
          collector,
        );
        // If adapter reported recordsProcessed (handles own insertion), use that
        // Otherwise use the count from insertAndPublishReadings
        return result.recordsProcessed ?? insertedCount;
      });

      // 5. Complete session and update polling status
      await this.completeSessionSuccess(
        system.id,
        session,
        startedAt,
        recordsProcessed,
        result.rawResponse,
        collector,
      );

      return this.polled(
        recordsProcessed,
        result.nextPollTime,
        result.rawResponse,
        stages,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.completeSessionError(
        system.id,
        session,
        startedAt,
        {
          success: false,
          error: errorMessage,
        },
        collector,
      );
      return this.error(errorMessage, undefined, stages);
    }
  }

  /**
   * Fetch data from vendor API - vendors must implement this method.
   * Push-only systems should not override this method.
   *
   * @param system - The system to poll
   * @param credentials - Vendor credentials
   * @param context - Context including startedAt timestamp and dryRun flag
   * @returns FetchResult with readings data or error
   */
  protected async fetchData(
    system: SystemWithPolling,
    credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    // Default implementation for push-only systems (should never be called)
    return {
      success: false,
      error: "This vendor does not support polling",
    };
  }

  /**
   * @deprecated Use fetchData() instead. This method will be removed after migration.
   */
  protected async doPoll(
    system: SystemWithPolling,
    credentials: any,
    session: SessionInfo,
    pollReason: string,
    dryRun: boolean = false,
  ): Promise<PollingResult> {
    console.warn(
      `[${this.vendorType}] doPoll is deprecated, implement fetchData instead`,
    );
    return this.error("This vendor does not support polling");
  }

  /**
   * Insert readings and publish to QStash queue
   * Note: PointManager methods handle QStash publishing internally
   */
  private async insertAndPublishReadings(
    systemId: number,
    session: SessionInfo,
    result: FetchResult,
    collector: PollCollector,
  ): Promise<number> {
    const pm = PointManager.getInstance();
    let count = 0;

    // Insert raw readings (buffered into the collector for co-enqueue at close)
    if (result.readings?.length) {
      await pm.insertPointReadingsRaw(
        systemId,
        session,
        result.readings,
        collector,
      );
      count += result.readings.length;
    }

    // Insert 5m aggregated readings (buffered into the collector for co-enqueue)
    if (result.readingsAgg5m?.length) {
      await pm.insertPointReadingsAgg5m(
        systemId,
        session,
        result.readingsAgg5m,
        collector,
      );
      count += result.readingsAgg5m.length;
    }

    return count;
  }

  /**
   * Complete session with success status and update polling status
   */
  private async completeSessionSuccess(
    systemId: number,
    session: SessionInfo,
    startedAt: Date,
    numRows: number,
    rawResponse: any,
    collector: PollCollector,
  ): Promise<void> {
    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startedAt.getTime(),
        successful: true,
        response: rawResponse,
        numRows,
      },
      collector.observations,
    );
    await updatePollingStatusSuccess(systemId, rawResponse);
  }

  /**
   * Complete session with error status and update polling status
   */
  private async completeSessionError(
    systemId: number,
    session: SessionInfo,
    startedAt: Date,
    result: FetchResult,
    collector: PollCollector,
  ): Promise<void> {
    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startedAt.getTime(),
        successful: false,
        errorCode: result.errorCode || null,
        error: result.error || null,
        response: result.rawResponse,
        numRows: 0,
      },
      collector.observations,
    );
    await updatePollingStatusError(
      systemId,
      result.error || "Unknown error",
      result.rawResponse,
    );
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
  protected skipped(reason?: string, nextPoll?: ZonedDateTime): PollingResult {
    return {
      action: "SKIPPED",
      reason,
      nextPollTimeMs: nextPoll?.toDate().getTime(),
    };
  }

  /**
   * Helper to create an ERROR result
   */
  protected error(
    error: string | Error,
    rawResponse?: any,
    stages?: PollStage[],
  ): PollingResult {
    return {
      action: "ERROR",
      error: error instanceof Error ? error.message : error,
      rawResponse,
      stages,
    };
  }

  /**
   * Helper to create a POLLED result
   */
  protected polled(
    recordsProcessed: number,
    nextPoll?: ZonedDateTime,
    rawResponse?: any,
    stages?: PollStage[],
  ): PollingResult {
    return {
      action: "POLLED",
      recordsProcessed,
      rawResponse,
      nextPollTimeMs: nextPoll?.toDate().getTime(),
      stages,
    };
  }
}
