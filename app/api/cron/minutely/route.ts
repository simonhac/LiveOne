import { NextRequest, NextResponse } from "next/server";
import { formatSystemId } from "@/lib/device-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { vendorUsesAppCredentials } from "@/lib/vendors/ownership";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import type { PollingResult, PollStage } from "@/lib/vendors/types";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { fromDate } from "@internationalized/date";
import { formatTimeAEST } from "@/lib/date-utils";
import { getNextSessionId, formatSessionId } from "@/lib/session-id";
import { jsonResponse, transformForStorage } from "@/lib/json";
import { reconcileTrailingWindow as reconcileBatteryProvenance } from "@/lib/battery-provenance/recompute";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import {
  POLL_CONCURRENCY,
  mapWithConcurrency,
  withDeadline,
} from "@/lib/cron/concurrency";
import { acquireCronLease } from "@/lib/cron/run-lock";

/**
 * The device's slot width, used only to order dispatch. Read off the adapter rather than plumbed
 * through the device row, so it can't drift from the schedule the adapter actually applies.
 */
function pollSlotMinutes(device: { vendorType: string }): number | null {
  const adapter = VendorRegistry.getAdapter(device.vendorType) as unknown as {
    pollIntervalMinutes?: number;
  } | null;
  return adapter?.pollIntervalMinutes ?? null;
}

/**
 * Helper function to poll all devices with optional progress callbacks.
 * This function handles the login stage (credential fetch) and delegates
 * the rest (session creation, fetch, insert, session update) to the adapter.
 *
 * @param onSessionStart - Callback called when a device's session is assigned (before polling starts)
 * @param onProgress - Callback called after each stage completes (login, fetch, process)
 */
async function pollAllDevices(params: {
  activeDevices: any[];
  sessionLabelPrefix: string;
  forcePollAll: boolean;
  pollReason: string;
  includeRaw: boolean;
  dryRun: boolean;
  sessionCause: "CRON" | "ADMIN" | "ADMIN-DRYRUN";
  onSessionStart?: (data: {
    systemId: number;
    sessionId: string;
    sessionLabel: string;
  }) => void;
  onProgress?: (result: PollingResult) => void;
}): Promise<PollingResult[]> {
  const {
    activeDevices,
    sessionLabelPrefix,
    forcePollAll,
    pollReason,
    includeRaw,
    dryRun,
    sessionCause,
    onSessionStart,
    onProgress,
  } = params;

  // Dispatch tightest-slot-first. Truncation is not uniformly harmless: a 5-minute vendor that
  // misses a tick just retries on the next one, but Selectronic is on a 1-minute slot with no
  // re-fetch path, so a dropped tick loses that minute permanently. Nine such truncations were
  // measured in 24 h, all because the sequential loop reached it last (device order was Postgres
  // heap order — unowned, and free to change under a VACUUM).
  const ordered = [...activeDevices].sort(
    (a, b) =>
      (pollSlotMinutes(a) ?? 99) - (pollSlotMinutes(b) ?? 99) || a.id - b.id,
  );

  const settled = await mapWithConcurrency(
    ordered,
    POLL_CONCURRENCY,
    (device, index) =>
      // `pollOneDevice` already turns its own failures into ERROR results; this catch is the
      // backstop that preserves what the old sequential loop guaranteed — one device can never
      // abort the tick for the others.
      pollOneDevice(
        device,
        formatSessionId(sessionLabelPrefix, index + 1),
      ).catch((error): PollingResult => {
        console.error(`[Cron] Unhandled error polling ${device.id}:`, error);
        return {
          action: "ERROR",
          systemId: device.id,
          displayName: device.displayName || undefined,
          vendorType: device.vendorType,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }),
  );
  return settled.filter((r): r is PollingResult => r !== null);

  /** Poll one device. Returns `null` for push-only devices, which are not part of the loop. */
  async function pollOneDevice(
    device: any,
    sessionLabel: string,
  ): Promise<PollingResult | null> {
    const pollStartTime = Date.now();
    const loginStages: PollStage[] = [];
    let capturedSessionId: string | undefined;

    // Get the vendor adapter first to check if it supports polling
    const adapter = VendorRegistry.getAdapter(device.vendorType);

    if (!adapter) {
      console.error(`[Cron] Unknown vendor type: ${device.vendorType}`);
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: device.id,
        displayName: device.displayName || undefined,
        vendorType: device.vendorType,
        error: `Unknown vendor type: ${device.vendorType}`,
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        lastPoll: device.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(device.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      return errorResult;
    }

    // Skip push-only devices (they don't need polling)
    if (adapter.dataSource === "push") {
      return null;
    }

    console.log(
      `[Cron] Processing systemId=${device.id} (${device.vendorType}/${device.vendorSiteId} '${device.displayName}') with session ${sessionLabel}`,
    );

    // Public/ownerless devices are allowed when the vendor authenticates with an app-wide
    // credential (e.g. openelectricity reads an env key). Per-user vendors still need an owner.
    if (
      !device.ownerClerkUserId &&
      !vendorUsesAppCredentials(device.vendorType)
    ) {
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: device.id,
        displayName: device.displayName || undefined,
        vendorType: device.vendorType,
        error: "No owner configured",
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        lastPoll: device.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(device.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      return errorResult;
    }

    try {
      // Stage 1: Login (credentials fetch) - timed in cron route
      const loginStart = Date.now();
      loginStages.push({
        name: "login",
        startMs: loginStart,
        endMs: loginStart,
      });

      // Start periodic progress updates for login stage
      let loginInterval: NodeJS.Timeout | null = null;
      if (onProgress) {
        loginInterval = setInterval(() => {
          loginStages[0].endMs = Date.now();
          onProgress({
            action: "POLLED",
            systemId: device.id,
            displayName: device.displayName || undefined,
            vendorType: device.vendorType,
            sessionLabel,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages: [...loginStages],
            inProgress: true,
          });
        }, 200);
      }

      const credentials = await getDeviceCredentials(
        device.ownerClerkUserId,
        device.id,
      );

      // Finalize login stage
      if (loginInterval) clearInterval(loginInterval);
      loginStages[0].endMs = Date.now();

      // Send progress after login stage completes
      if (onProgress) {
        onProgress({
          action: "POLLED",
          systemId: device.id,
          displayName: device.displayName || undefined,
          vendorType: device.vendorType,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: [...loginStages],
          inProgress: true,
        });
      }

      // Some vendors don't need per-user credentials: fusher/fronius push data, and
      // openelectricity uses a single app-wide env key (OPEN_ELECTRICITY_API_KEY).
      if (
        !credentials &&
        adapter.vendorType !== "fusher" &&
        adapter.vendorType !== "fronius" &&
        adapter.vendorType !== "openelectricity"
      ) {
        console.error(
          `[Cron] No credentials found for ${device.vendorType} system ${device.id}`,
        );
        const errorResult: PollingResult = {
          action: "ERROR",
          systemId: device.id,
          displayName: device.displayName || undefined,
          vendorType: device.vendorType,
          error: "No credentials found",
          durationMs: Date.now() - pollStartTime,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: loginStages,
          lastPoll: device.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  device.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        };
        return errorResult;
      }

      // Call adapter.poll() with new PollOptions - adapter handles session, fetch, insert.
      // Bounded: a vendor that hangs must not spend the other devices' share of the 60 s budget.
      const result = await withDeadline(
        adapter.poll(device, credentials, {
          forcePollAll,
          pollReason,
          sessionLabel,
          sessionCause,
          dryRun,
          onSessionStart: (data) => {
            // Capture sessionId for final result
            capturedSessionId = data.sessionId;
            // Forward session-start with device metadata if callback provided
            if (onSessionStart) {
              onSessionStart({
                systemId: data.systemId,
                sessionLabel: data.sessionLabel,
                sessionId: data.sessionId,
              });
            }
          },
          onProgress: onProgress
            ? (partial) => {
                // Merge login stage with adapter's stages for progress updates
                onProgress({
                  ...partial,
                  systemId: device.id,
                  displayName: device.displayName || undefined,
                  vendorType: device.vendorType,
                  durationMs: Date.now() - pollStartTime,
                  startMs: pollStartTime,
                  endMs: Date.now(),
                  stages: [...loginStages, ...(partial.stages || [])],
                });
              }
            : undefined,
        }),
        adapter.pollDeadlineMs,
      );

      // Merge login stage with adapter's fetch + process stages
      const allStages = [...loginStages, ...(result.stages || [])];

      // Build final result
      const now = new Date();
      const finalResult: PollingResult = {
        ...result,
        systemId: device.id,
        displayName: device.displayName || undefined,
        vendorType: device.vendorType,
        sessionLabel,
        sessionId: capturedSessionId,
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        stages: allStages,
        ...(includeRaw && result.rawResponse
          ? { rawResponse: result.rawResponse }
          : {}),
        lastPoll:
          result.action === "POLLED"
            ? formatTimeAEST(fromDate(now, "Australia/Brisbane"))
            : device.pollingStatus?.lastPollTime
              ? formatTimeAEST(
                  fromDate(
                    device.pollingStatus.lastPollTime,
                    "Australia/Brisbane",
                  ),
                )
              : null,
      };

      // Send final progress
      if (onProgress) {
        onProgress(finalResult);
      }

      // Log result
      switch (result.action) {
        case "POLLED":
          console.log(
            `[Cron] ${formatSystemId(device)} - Success (${result.recordsProcessed} records)`,
          );
          break;
        case "SKIPPED":
          console.log(
            `[Cron] ${formatSystemId(device)} - Skipped: ${result.reason}`,
          );
          break;
        case "ERROR":
          console.error(
            `[Cron] ${formatSystemId(device)} - Error: ${result.error}`,
          );
          break;
      }

      return finalResult;
    } catch (error) {
      // Includes DeadlineExceededError. Note the abandoned poll keeps running to completion in the
      // background and may still record its session and `device_state` — so the data is not
      // necessarily lost, but this tick stops waiting for it and reports the timeout honestly.
      console.error(`[Cron] Error polling ${device.id}:`, error);
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: device.id,
        displayName: device.displayName || undefined,
        vendorType: device.vendorType,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        stages: loginStages,
        lastPoll: device.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(device.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      return errorResult;
    }
  }
}

export async function GET(request: NextRequest) {
  const apiStartTime = Date.now();
  const sessionId = getNextSessionId();
  let releaseLease: (() => Promise<void>) | null = null;

  try {
    const authResult = await requireCronOrAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const skip = cronSkipReason(request, authResult);
    if (skip) return NextResponse.json(skip);

    // Only the SCHEDULED run takes the lease. An operator hitting this route deliberately (admin /
    // ?force=true / the SSE view) is allowed to overlap a cron tick — the lease exists to stop the
    // platform double-firing, not to lock a human out of their own fleet.
    if (authResult.isCron) {
      const lease = await acquireCronLease("minutely", sessionId);
      if (!lease) {
        // 200, not 429: `cronSkipReason` already established that a skip is a normal outcome here,
        // and a non-2xx would make Vercel retry into exactly the overlap being prevented.
        console.warn(
          "[Cron] previous run still in flight — skipping this tick",
        );
        return NextResponse.json({
          skipped: true,
          reason: "previous minutely run still in flight",
        });
      }
      releaseLease = lease.release;
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const testSystemId = searchParams.get("systemId");
    const forcePollAll = searchParams.get("force") === "true";
    const includeRaw = searchParams.get("includeRaw") === "true";
    const dryRun = searchParams.get("dryRun") === "true";

    const sessionCause = authResult.isCron
      ? "CRON"
      : dryRun
        ? "ADMIN-DRYRUN"
        : "ADMIN";

    const pollReason = authResult.isCron
      ? "CRON"
      : forcePollAll
        ? "ADMIN-FORCE"
        : "ADMIN";

    if (testSystemId && forcePollAll) {
      console.log(
        `[Cron] Testing system ${testSystemId} with forcePollAll=true`,
      );
    }

    console.log("[Cron] Starting system polling...");

    // Config (incl. polling status) is loaded fresh per request, so no cache to clear.

    // Get devices to poll
    let activeDevices;
    if (testSystemId) {
      const device = await DeviceConfigRegistry.deviceByHandle(
        parseInt(testSystemId),
      );
      activeDevices = device ? [device] : [];
      console.log(`[Cron] Testing single system: ${testSystemId}`);
    } else {
      activeDevices = await DeviceConfigRegistry.activeDevices();
    }

    if (activeDevices.length === 0) {
      console.log("[Cron] No active systems to poll");
      return NextResponse.json({
        success: true,
        message: "No systems to poll",
        count: 0,
      });
    }

    console.log(
      `[Cron] Starting polling session ${sessionId} with ${activeDevices.length} systems`,
    );

    // Check if real-time SSE streaming is requested
    const realTime = searchParams.get("realTime") === "true";

    if (realTime) {
      // SSE Streaming Mode
      console.log("[Cron] Real-time SSE streaming enabled");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Send initial metadata with list of devices to be polled
            const devicesList = activeDevices
              .filter((sys) => {
                const adapter = VendorRegistry.getAdapter(sys.vendorType);
                return adapter && adapter.dataSource !== "push";
              })
              .map((sys) => ({
                systemId: sys.id,
                displayName: sys.displayName || undefined,
                vendorType: sys.vendorType,
              }));

            const metadata = {
              sessionId,
              sessionStartTimeMs: apiStartTime,
              totalDevices: activeDevices.length,
              devices: devicesList,
            };
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(transformForStorage({ type: "start", data: metadata }))}\n\n`,
              ),
            );

            // Poll all devices with progress callbacks
            // Note: session-start is merged into progress events (first progress includes sessionLabel/sessionId)
            const results = await pollAllDevices({
              activeDevices,
              sessionLabelPrefix: sessionId,
              forcePollAll,
              pollReason,
              includeRaw,
              dryRun,
              sessionCause,
              onProgress: (result: PollingResult) => {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify(transformForStorage({ type: "progress", data: result }))}\n\n`,
                  ),
                );
              },
            });

            // Send final summary
            const successCount = results.filter(
              (r) => r.action === "POLLED",
            ).length;
            const skippedCount = results.filter(
              (r) => r.action === "SKIPPED",
            ).length;
            const failureCount = results.filter(
              (r) => r.action === "ERROR",
            ).length;
            const durationMs = Date.now() - apiStartTime;

            // Slim complete event - client already has all results from progress events
            const summary = {
              sessionId,
              durationMs,
              sessionStartTimeMs: apiStartTime,
              sessionEndTimeMs: Date.now(),
              summary: {
                total: results.length,
                successful: successCount,
                failed: failureCount,
                skipped: skippedCount,
              },
            };

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(transformForStorage({ type: "complete", data: summary }))}\n\n`,
              ),
            );

            console.log(
              `[Cron] SSE polling complete in ${durationMs} ms. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`,
            );
          } catch (error) {
            console.error("[Cron] Error in SSE stream:", error);
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(transformForStorage({ type: "error", error: errorMsg }))}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });

      return new NextResponse(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    // Normal JSON Response Mode
    const results = await pollAllDevices({
      activeDevices,
      sessionLabelPrefix: sessionId,
      forcePollAll,
      pollReason,
      includeRaw,
      dryRun,
      sessionCause,
    });

    // The derived hot-water temperature used to be reconciled here. Since config-v4 Phase 11 it is
    // an `hws-model` row in `derivations`, dispatched by /api/cron/derivations alongside the run
    // detectors — one mechanism for every derived signal. It may now trail materialization by up
    // to one minutely tick, which the next pass heals.

    // Derived battery-provenance blend: reconcile the trailing window so the battery's blended
    // emissions/renewable/price stay fresh (KV latest for the live card). Best-effort; a no-op for
    // Areas without a bound battery.
    //
    // Cadence gate: the blend inputs are 5-min-native (agg_5m), so a minutely recompute yields an
    // identical value 4 ticks in 5 — a ~5× waste dominated by re-reading a ~7.5-day window each tick.
    // Run at most once per 5-min bucket (2 min past the boundary, so the just-closed interval has
    // materialised). The recompute's own 12h trailing window self-heals any tick Vercel skips and the
    // daily heal guarantees correctness regardless, so the gate's only cost is up to ~5 min of
    // KV-latest staleness on the live card. Manual/admin runs bypass the gate for testing.
    const batProvNowMs = Date.now();
    const batProvDue =
      !authResult.isCron || new Date(batProvNowMs).getUTCMinutes() % 5 === 2;
    if (batProvDue) {
      try {
        await reconcileBatteryProvenance(batProvNowMs);
      } catch (error) {
        console.error("[Cron] battery-provenance reconcile failed:", error);
      }
    }

    const successCount = results.filter((r) => r.action === "POLLED").length;
    const skippedCount = results.filter((r) => r.action === "SKIPPED").length;
    const failureCount = results.filter((r) => r.action === "ERROR").length;

    // Create sanitized results for logging
    const resultsForLogging = results.map((r) => {
      const log: any = { ...r };
      if ("rawResponse" in r && r.rawResponse) {
        log.rawResponse =
          JSON.stringify(r.rawResponse).substring(0, 60) + "...";
      } else if ("rawResponse" in r) {
        delete log.rawResponse;
      }
      return log;
    });

    const durationMs = Date.now() - apiStartTime;

    // Wall time is the leading indicator for truncation — the tick that dropped devices measured
    // 72.9 s against a 60 s budget, and nothing recorded it at the time.
    const budgetWarn =
      durationMs > 30_000 ? " ⚠ SLOW (>30s of a 60s budget)" : "";
    console.log(
      `[Cron] Polling complete in ${durationMs} ms${budgetWarn}. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`,
      resultsForLogging,
    );

    const nowZoned = fromDate(new Date(), "Australia/Brisbane");
    const timestamp = formatTimeAEST(nowZoned);

    return jsonResponse(
      {
        success: true,
        sessionId,
        timestamp,
        durationMs,
        sessionStartMs: apiStartTime,
        sessionEndMs: Date.now(),
        summary: {
          total: results.length,
          successful: successCount,
          failed: failureCount,
          skipped: skippedCount,
        },
        results,
      },
      600,
    );
  } catch (error) {
    console.error("[Cron] Fatal error:", error);
    const durationMs = Date.now() - apiStartTime;

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs,
      },
      { status: 500 },
    );
  } finally {
    // Always, including the fatal path — a lease held past a crash would silently skip every
    // subsequent tick until its TTL expired.
    if (releaseLease) await releaseLease();
  }
}
