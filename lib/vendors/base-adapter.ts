import type {
  VendorAdapter,
  PollingResult,
  TestConnectionResult,
  PollOptions,
  FetchContext,
  FetchResult,
  PollStage,
} from "./types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { evaluateSlot } from "./schedule";
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

  // ── The entire scheduling surface a vendor may touch ─────────────────────────────────────────
  //
  // Timing lives in `lib/vendors/schedule.ts` and NOWHERE else. Adapters used to override
  // `evaluateSchedule` and re-derive the cadence themselves; every one of those overrides turned
  // out to be a gate or an interval selector rather than a different algorithm, and between them
  // they carried three copies of the same drift arithmetic and 17 calls to `getNextMinuteBoundary`
  // purely to build a display string. A vendor now declares at most the handful of facts below —
  // each one a NUMBER the shared rule consumes, never an algorithm of its own.

  /** Slot width. Override the field for a fixed cadence, or `intervalFor` for a dynamic one. */
  protected pollIntervalMinutes = 1;

  /**
   * Cron-loop deadline for one poll of this vendor. 20 s is generous against a measured p90 of
   * ~5 s across every vendor; raise it only where the vendor has a legitimate long path (Tesla's
   * wake loop), never to accommodate a retry ladder.
   */
  readonly pollDeadlineMs: number = 20_000;

  /**
   * Whole minutes into each slot before this vendor may be polled — its publication lag, measured
   * (`scripts/utils/poll-cadence.ts`), not guessed. 0 for vendors that serve a live snapshot.
   */
  protected pollOffsetMinutes = 0;

  /**
   * WHERE in its slot this vendor is expected to poll. `boundary` — the default, and what the slot
   * rule produces on its own — means slot start + `pollOffsetMinutes`, so how often a poll lands
   * there measures phase drift. `within-slot` means the vendor's `isEligible` gate picks a moment
   * inside the slot that is not a fixed phase (OpenElectricity's learned NEM publish delay), so a
   * boundary hit is neither expected nor possible and measuring one yields a permanent 0%.
   *
   * Nothing in the scheduler reads this — `shouldPoll` is unchanged either way. It exists so a
   * report can tell "drifting" apart from "deliberately not aligned"
   * (`scripts/utils/poll-cadence.ts`). A gate that only decides WHETHER to poll rather than when —
   * Enphase's daylight/repair window — stays `boundary`: inside its window it still polls on the
   * boundary, so the number means something.
   */
  readonly slotAlignment: "boundary" | "within-slot" = "boundary";

  /**
   * How far into a slot this vendor may still be RETRIED after a failure — see
   * `RETRY_WINDOW_MINUTES` in `lib/vendors/schedule.ts` for why the cap is a window rather than a
   * counter, and `SlotSchedule.retryWindowMinutes` for why "but its slot is an hour" is NOT a reason
   * to widen it. Undefined takes the shared default (2 minutes ⇒ at most 2 attempts per slot), and
   * no vendor currently overrides it.
   */
  protected retryWindowMinutes: number | undefined = undefined;

  /**
   * How stale this vendor's last SUCCESSFUL poll may get before the health monitor pages
   * (`/api/cron/monitor-observations`). Nothing in the scheduler reads it — it is a monitoring
   * threshold, declared here because that is where the rest of a vendor's cadence facts live and
   * the monitor already reads them structurally off the adapter.
   *
   * Undefined means the default `pollIntervalMinutes × MONITOR_DEVICE_STALE_SLOTS`. Override only
   * where the vendor has a KNOWN, measured window of unavailability that the generic multiple
   * cannot express — otherwise raise `MONITOR_DEVICE_STALE_SLOTS`, or fix the vendor.
   */
  readonly staleBudgetMinutes: number | undefined = undefined;

  /** Slot width for one device. Override when the cadence depends on device state (see Tesla). */
  protected intervalFor(_device: DeviceConfigView): number {
    return this.pollIntervalMinutes;
  }

  /**
   * Vendor-specific veto, evaluated before the slot rule — "there is no point polling right now",
   * as distinct from "it isn't time yet". Enphase uses it for its daylight window, OpenElectricity
   * for its learned publish-arrival window. Returning a reason keeps the skip legible in the poll
   * result exactly as a schedule skip is.
   */
  protected async isEligible(
    _device: DeviceConfigView,
    _now: Date,
  ): Promise<true | { eligible: false; reason: string }> {
    return true;
  }

  /**
   * When this device could next be polled — the start of its next slot, plus the offset. Display
   * only; nothing sleeps on it. Computed here so no adapter has to.
   */
  private nextPollFor(device: DeviceConfigView, nowMs: number): ZonedDateTime {
    const next = getNextMinuteBoundary(
      this.intervalFor(device),
      device.timezoneOffsetMin,
      new Date(nowMs),
    );
    return this.pollOffsetMinutes
      ? next.add({ minutes: this.pollOffsetMinutes })
      : next;
  }

  /**
   * Should this device be polled now? FINAL — the one implementation of "is it time", for every
   * vendor. Vendors influence it through `intervalFor` / `pollOffsetMinutes` / `retryWindowMinutes`
   * / `isEligible` only.
   *
   * Keyed on `lastSuccessTime` (a failed poll must not consume its slot) which, since this change,
   * stamps when the poll STARTED — see `lib/vendors/schedule.ts` for why both matter. That retry is
   * bounded by an in-slot budget plus a consecutive-failure breaker, both fed from the
   * `device_state` row this method already has in hand.
   */
  async shouldPoll(
    device: DeviceConfigView,
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

    const intervalMinutes = this.intervalFor(device);
    const nextPoll = this.nextPollFor(device, now.getTime());

    const eligible = await this.isEligible(device, now);
    if (eligible !== true) {
      return { shouldPoll: false, reason: eligible.reason, nextPoll };
    }

    const decision = evaluateSlot(
      now.getTime(),
      device.pollingStatus?.lastSuccessTime?.getTime() ?? null,
      {
        intervalMinutes,
        offsetMinutes: this.pollOffsetMinutes,
        retryWindowMinutes: this.retryWindowMinutes,
      },
      { consecutiveErrors: device.pollingStatus?.consecutiveErrors ?? 0 },
    );

    return {
      shouldPoll: decision.due,
      reason: `${decision.reason} (${intervalMinutes} min)`,
      nextPoll,
    };
  }

  /**
   * Poll for new data using template method pattern.
   * Handles full lifecycle: check schedule → create session → fetch data → process → complete session
   *
   * @param device - The device to poll
   * @param credentials - Vendor credentials
   * @param options - Poll options including sessionLabel, cause, dryRun, and onProgress callback
   */
  async poll(
    device: DeviceConfigView,
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
    const check = await this.shouldPoll(device, forcePollAll, startedAt);
    if (!check.shouldPoll) {
      return this.skipped(check.reason, check.nextPoll);
    }

    // 2. Create session
    const session = await sessionManager.createSession({
      sessionLabel,
      systemId: device.id,
      cause: sessionCause,
      started: startedAt,
    });

    // Buffer this poll's observations so we can emit ONE combined QStash message
    // (session + all readings) at session close, on both success and failure.
    const collector = createPollCollector();

    // 3. Notify caller that session has started (for SSE updates)
    if (onSessionStart) {
      onSessionStart({
        systemId: device.id,
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
        this.fetchData(device, credentials, {
          startedAt,
          dryRun,
          session,
          collector,
        }),
      );

      if (!result.success) {
        await this.completeSessionError(
          device.id,
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
          device.id,
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
        device.id,
        session,
        startedAt,
        recordsProcessed,
        result.rawResponse,
        collector,
      );

      return this.polled(
        recordsProcessed,
        this.nextPollFor(device, startedAt.getTime()),
        result.rawResponse,
        stages,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.completeSessionError(
        device.id,
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
   * Push-only devices should not override this method.
   *
   * @param device - The device to poll
   * @param credentials - Vendor credentials
   * @param context - Context including startedAt timestamp and dryRun flag
   * @returns FetchResult with readings data or error
   */
  protected async fetchData(
    device: DeviceConfigView,
    credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    // Default implementation for push-only devices (should never be called)
    return {
      success: false,
      error: "This vendor does not support polling",
    };
  }

  /**
   * @deprecated Use fetchData() instead. This method will be removed after migration.
   */
  protected async doPoll(
    device: DeviceConfigView,
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
    // `startedAt`, NOT "now": the slot rule asks which slot this poll belongs to, and a poll that
    // began at 10:04:58 and finished at 10:05:02 belongs to 10:00. Stamping the completion time
    // recorded it into the 10:05 slot and suppressed that slot's poll.
    await updatePollingStatusSuccess(systemId, rawResponse, startedAt);
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
      startedAt,
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
   * Test connection with vendor. Only poll-based devices can test connections.
   */
  async testConnection(
    device: DeviceConfigView,
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
