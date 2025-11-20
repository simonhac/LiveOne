import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readings } from "@/lib/db/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { updateAggregatedData } from "@/lib/aggregation-helper";
import { formatSystemId } from "@/lib/system-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getSystemCredentials } from "@/lib/secure-credentials";
import { sessionManager } from "@/lib/session-manager";
import type { CommonPollingData } from "@/lib/types/common";
import type { PollingResult } from "@/lib/vendors/types";
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
} from "@/lib/polling-utils";
import { validateCronRequest } from "@/lib/cron-utils";
import { and } from "drizzle-orm";
import { fromDate } from "@internationalized/date";
import { formatTimeAEST } from "@/lib/date-utils";
import { getNextSessionId, formatSessionId } from "@/lib/session-id";
import { jsonResponse } from "@/lib/json";

/**
 * Helper function to poll all systems with optional progress callbacks.
 * This function is used by both the normal JSON response and SSE streaming modes.
 *
 * @param onProgress - Callback called after each stage completes (login, download, insert)
 */
async function pollAllSystems(params: {
  activeSystems: any[];
  sessionId: string;
  isUserOriginated: boolean;
  includeRaw: boolean;
  dryRun: boolean;
  sessionCause: "CRON" | "ADMIN" | "ADMIN-DRYRUN";
  onProgress?: (result: PollingResult) => void;
}): Promise<PollingResult[]> {
  const {
    activeSystems,
    sessionId,
    isUserOriginated,
    includeRaw,
    dryRun,
    sessionCause,
    onProgress,
  } = params;

  const results: PollingResult[] = [];
  let subSequence = 0;

  // Poll each system using the new vendor adapter architecture
  for (const system of activeSystems) {
    const pollStartTime = Date.now(); // Track start time for this system poll
    const stages: {
      name: "login" | "download" | "insert";
      startMs: number;
      endMs: number;
    }[] = [];
    subSequence++; // Increment for each system
    const sessionLabel = formatSessionId(sessionId, subSequence);
    // Get the vendor adapter first to check if it supports polling
    const adapter = VendorRegistry.getAdapter(system.vendorType);

    if (!adapter) {
      console.error(`[Cron] Unknown vendor type: ${system.vendorType}`);
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        error: `Unknown vendor type: ${system.vendorType}`,
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        lastPoll: system.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(system.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      results.push(errorResult);
      continue;
    }

    // Skip push-only systems (they don't need polling)
    if (adapter.dataSource === "push") {
      continue; // Don't add to results at all, don't log
    }

    console.log(
      `[Cron] Processing systemId=${system.id} (${system.vendorType}/${system.vendorSiteId} '${system.displayName}') with session ${sessionLabel}`,
    );

    // Check if we should poll - if not time yet, skip without creating session
    const now = new Date();
    const shouldPollCheck = await adapter.shouldPoll(
      system,
      isUserOriginated,
      now,
    );

    if (!shouldPollCheck.shouldPoll) {
      const skipResult: PollingResult = {
        action: "SKIPPED",
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        reason: shouldPollCheck.reason,
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        lastPoll: system.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(system.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      results.push(skipResult);
      console.log(
        `[Cron] ${formatSystemId(system)} - Skipped: ${shouldPollCheck.reason}`,
      );
      continue; // Skip to next system
    }

    // We're going to attempt polling - create session now
    const sessionStart = new Date();
    const dbSessionId = await sessionManager.createSession({
      sessionLabel,
      systemId: system.id,
      vendorType: system.vendorType,
      systemName: system.displayName || `System ${system.id}`,
      cause: sessionCause,
      started: sessionStart,
    });

    try {
      // Check if system has an owner
      if (!system.ownerClerkUserId) {
        const duration = Date.now() - sessionStart.getTime();
        await sessionManager.updateSessionResult(dbSessionId, {
          duration,
          successful: false,
          error: "No owner configured",
          numRows: 0,
        });
        const errorResult: PollingResult = {
          action: "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          sessionLabel: sessionLabel || undefined,
          error: "No owner configured",
          durationMs: Date.now() - pollStartTime,
          startMs: pollStartTime,
          endMs: Date.now(),
          lastPoll: system.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  system.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        };
        results.push(errorResult);
        continue;
      }

      // Stage 1: Login (credentials fetch)
      const loginStart = Date.now();
      stages.push({ name: "login", startMs: loginStart, endMs: loginStart });

      // Start periodic progress updates for login stage
      let loginInterval: NodeJS.Timeout | null = null;
      if (onProgress) {
        loginInterval = setInterval(() => {
          stages[stages.length - 1].endMs = Date.now();
          onProgress({
            action: "POLLED",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages: [...stages],
            inProgress: true,
          });
        }, 200);
      }

      const credentials = await getSystemCredentials(
        system.ownerClerkUserId,
        system.id,
      );
      const loginEnd = Date.now();

      // Stop periodic updates
      if (loginInterval) {
        clearInterval(loginInterval);
      }

      // Update stage with actual end time
      stages[stages.length - 1].endMs = loginEnd;

      // Send progress after login stage completes
      if (onProgress) {
        onProgress({
          action: "POLLED",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          sessionLabel: sessionLabel || undefined,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: [...stages],
        });
      }

      if (!credentials && adapter.vendorType !== "fronius") {
        console.error(
          `[Cron] No credentials found for ${system.vendorType} system ${system.id}`,
        );
        const duration = Date.now() - sessionStart.getTime();
        await sessionManager.updateSessionResult(dbSessionId, {
          duration,
          successful: false,
          error: "No credentials found",
          numRows: 0,
        });
        const errorResult: PollingResult = {
          action: "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          sessionLabel: sessionLabel || undefined,
          error: "No credentials found",
          durationMs: Date.now() - pollStartTime,
          startMs: pollStartTime,
          endMs: Date.now(),
          lastPoll: system.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  system.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        };
        results.push(errorResult);
        continue;
      }

      // Stage 2: Download (API call)
      const downloadStart = Date.now();
      stages.push({
        name: "download",
        startMs: downloadStart,
        endMs: downloadStart,
      });

      // Start periodic progress updates for download stage
      let downloadInterval: NodeJS.Timeout | null = null;
      if (onProgress) {
        downloadInterval = setInterval(() => {
          stages[stages.length - 1].endMs = Date.now();
          onProgress({
            action: "POLLED",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages: [...stages],
            inProgress: true,
          });
        }, 200);
      }

      const result = await adapter.poll(
        system,
        credentials,
        isUserOriginated,
        now,
        dbSessionId,
        dryRun,
      );
      const downloadEnd = Date.now();

      // Stop periodic updates
      if (downloadInterval) {
        clearInterval(downloadInterval);
      }

      // Update stage with actual end time
      stages[stages.length - 1].endMs = downloadEnd;

      // Send progress after download stage
      if (onProgress) {
        onProgress({
          action: result.action === "POLLED" ? "POLLED" : "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          sessionLabel: sessionLabel || undefined,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: [...stages],
          error: result.action === "ERROR" ? result.error : undefined,
        });
      }

      // Calculate duration
      const duration = Date.now() - sessionStart.getTime();

      // Process the result
      switch (result.action) {
        case "POLLED":
          // Stage 3: Insert (database write)
          const insertStart = Date.now();
          stages.push({
            name: "insert",
            startMs: insertStart,
            endMs: insertStart,
          });

          // Start periodic progress updates for insert stage
          let insertInterval: NodeJS.Timeout | null = null;
          if (onProgress) {
            insertInterval = setInterval(() => {
              stages[stages.length - 1].endMs = Date.now();
              onProgress({
                action: "POLLED",
                systemId: system.id,
                displayName: system.displayName || undefined,
                vendorType: system.vendorType,
                sessionLabel: sessionLabel || undefined,
                durationMs: Date.now() - pollStartTime,
                startMs: pollStartTime,
                endMs: Date.now(),
                stages: [...stages],
                inProgress: true,
              });
            }, 200);
          }

          // Store the data if provided
          if (result.data) {
            const dataArray = Array.isArray(result.data)
              ? result.data
              : [result.data];

            for (const data of dataArray) {
              // Calculate delay (timestamp should be a Date object from adapters)
              const inverterTime = data.timestamp;
              const receivedTime = new Date();
              const delaySeconds = Math.floor(
                (receivedTime.getTime() - inverterTime.getTime()) / 1000,
              );

              // Insert reading into database (Drizzle handles Date -> Unix conversion)
              // Skip database write in dry run mode
              if (!dryRun) {
                await db.insert(readings).values({
                  systemId: system.id,
                  inverterTime, // Pass Date directly - Drizzle converts to Unix timestamp
                  receivedTime,
                  delaySeconds,
                  solarW: data.solarW ?? null, // Preserve null, don't convert to 0
                  solarLocalW: data.solarLocalW ?? null,
                  solarRemoteW: data.solarRemoteW ?? null,
                  loadW: data.loadW ?? null,
                  batteryW: data.batteryW ?? null,
                  gridW: data.gridW ?? null,
                  batterySOC:
                    data.batterySOC != null
                      ? Math.round(data.batterySOC * 10) / 10
                      : null,
                  faultCode: data.faultCode ?? null,
                  faultTimestamp: data.faultTimestamp
                    ? Math.floor(data.faultTimestamp.getTime() / 1000)
                    : null,
                  generatorStatus: data.generatorStatus ?? null,
                  // Energy interval counters (Wh) - integers, preserve nulls
                  solarWhInterval:
                    data.solarWhInterval != null
                      ? Math.round(data.solarWhInterval)
                      : null,
                  loadWhInterval:
                    data.loadWhInterval != null
                      ? Math.round(data.loadWhInterval)
                      : null,
                  batteryInWhInterval:
                    data.batteryInWhInterval != null
                      ? Math.round(data.batteryInWhInterval)
                      : null,
                  batteryOutWhInterval:
                    data.batteryOutWhInterval != null
                      ? Math.round(data.batteryOutWhInterval)
                      : null,
                  gridInWhInterval:
                    data.gridInWhInterval != null
                      ? Math.round(data.gridInWhInterval)
                      : null,
                  gridOutWhInterval:
                    data.gridOutWhInterval != null
                      ? Math.round(data.gridOutWhInterval)
                      : null,
                  // Energy counters (kWh) - rounded to 3 decimal places, preserve nulls
                  solarKwhTotal:
                    data.solarKwhTotal != null
                      ? Math.round(data.solarKwhTotal * 1000) / 1000
                      : null,
                  loadKwhTotal:
                    data.loadKwhTotal != null
                      ? Math.round(data.loadKwhTotal * 1000) / 1000
                      : null,
                  batteryInKwhTotal:
                    data.batteryInKwhTotal != null
                      ? Math.round(data.batteryInKwhTotal * 1000) / 1000
                      : null,
                  batteryOutKwhTotal:
                    data.batteryOutKwhTotal != null
                      ? Math.round(data.batteryOutKwhTotal * 1000) / 1000
                      : null,
                  gridInKwhTotal:
                    data.gridInKwhTotal != null
                      ? Math.round(data.gridInKwhTotal * 1000) / 1000
                      : null,
                  gridOutKwhTotal:
                    data.gridOutKwhTotal != null
                      ? Math.round(data.gridOutKwhTotal * 1000) / 1000
                      : null,
                });

                // Update 5-minute aggregated data
                await updateAggregatedData(system.id, inverterTime);
              }
            }
          }

          // Update polling status with raw response
          // Note: We update polling status even in dry run mode to track that the poll happened
          await updatePollingStatusSuccess(system.id, result.rawResponse);
          const insertEnd = Date.now();

          // Stop periodic updates
          if (insertInterval) {
            clearInterval(insertInterval);
          }

          // Update stage with actual end time
          stages[stages.length - 1].endMs = insertEnd;

          // Update session with successful result
          await sessionManager.updateSessionResult(dbSessionId, {
            duration,
            successful: true,
            response: result.rawResponse,
            numRows: result.recordsProcessed || 0,
          });

          const successResult: PollingResult = {
            action: "POLLED",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            recordsProcessed: result.recordsProcessed,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages,
            ...(includeRaw && result.rawResponse
              ? { rawResponse: result.rawResponse }
              : {}),
            lastPoll: formatTimeAEST(fromDate(now, "Australia/Brisbane")),
          };
          results.push(successResult);

          // Send final progress after insert stage
          if (onProgress) {
            onProgress(successResult);
          }

          console.log(
            `[Cron] ${formatSystemId(system)} - Success (${result.recordsProcessed} records)`,
          );
          break;

        case "SKIPPED":
          // This case should never be reached since we check shouldPoll before creating session
          console.warn(
            `[Cron] ${formatSystemId(system)} - Unexpected SKIPPED result after shouldPoll check`,
          );
          break;

        case "ERROR":
          // Update error status with rawResponse for debugging
          await updatePollingStatusError(
            system.id,
            result.error || "Unknown error",
            result.rawResponse,
          );

          // Update session with error result
          await sessionManager.updateSessionResult(dbSessionId, {
            duration,
            successful: false,
            errorCode: result.errorCode || null,
            error: result.error || null,
            response: result.rawResponse, // Include rawResponse even for errors
            numRows: 0,
          });

          const errorResult: PollingResult = {
            action: "ERROR",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            error: result.error,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages,
            ...(includeRaw && result.rawResponse
              ? { rawResponse: result.rawResponse }
              : {}),
            lastPoll: system.pollingStatus?.lastPollTime
              ? formatTimeAEST(
                  fromDate(
                    system.pollingStatus.lastPollTime,
                    "Australia/Brisbane",
                  ),
                )
              : null,
          };
          results.push(errorResult);
          console.error(
            `[Cron] ${formatSystemId(system)} - Error: ${result.error}`,
          );
          break;
      }
    } catch (error) {
      console.error(`[Cron] Error polling ${system.id}:`, error);

      // Update polling status with error
      await updatePollingStatusError(
        system.id,
        error instanceof Error ? error : "Unknown error",
      );

      // Update session with unexpected error
      try {
        const duration = Date.now() - sessionStart.getTime();
        await sessionManager.updateSessionResult(dbSessionId, {
          duration,
          successful: false,
          error: error instanceof Error ? error.message : "Unknown error",
          numRows: 0,
        });
      } catch (sessionError) {
        console.error(
          `[Cron] Failed to update session for error:`,
          sessionError,
        );
      }

      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        sessionLabel: sessionLabel || undefined,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        stages,
        lastPoll: system.pollingStatus?.lastPollTime
          ? formatTimeAEST(
              fromDate(system.pollingStatus.lastPollTime, "Australia/Brisbane"),
            )
          : null,
      };
      results.push(errorResult);
    }
  }

  return results;
}

export async function GET(request: NextRequest) {
  const apiStartTime = Date.now(); // Track API call start time
  const sessionId = getNextSessionId(); // Get session ID for this API invocation

  try {
    // Validate cron request or admin user
    if (!(await validateCronRequest(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Determine session cause: CRON (scheduled) vs ADMIN (manual trigger) vs ADMIN-DRYRUN (dry run)
    const authHeader = request.headers.get("authorization");
    const isCronRequest = authHeader === `Bearer ${process.env.CRON_SECRET}`;

    // In development, allow testing specific systems with isUserOriginated flag
    const searchParams = request.nextUrl.searchParams;
    const testSystemId = searchParams.get("systemId");
    const isUserOriginated = searchParams.get("force") === "true"; // Keep "force" param name for backwards compatibility
    const includeRaw = searchParams.get("includeRaw") === "true";
    const dryRun = searchParams.get("dryRun") === "true";

    const sessionCause = isCronRequest
      ? "CRON"
      : dryRun
        ? "ADMIN-DRYRUN"
        : "ADMIN";

    if (testSystemId && isUserOriginated) {
      console.log(
        `[Cron] Testing system ${testSystemId} with isUserOriginated=true`,
      );
    }

    console.log("[Cron] Starting system polling...");

    // TEMPORARY: Clear SystemsManager cache to ensure fresh polling status data
    // TODO: Implement proper request-scoped caching instead of global singleton
    SystemsManager.clearInstance();

    // Get SystemsManager with fresh data for this request
    const systemsManager = SystemsManager.getInstance();

    // Get systems to poll
    let activeSystems;
    if (testSystemId) {
      // With systemId parameter, get just that system
      const system = await systemsManager.getSystem(parseInt(testSystemId));
      activeSystems = system ? [system] : [];
      console.log(`[Cron] Testing single system: ${testSystemId}`);
    } else {
      // Normal operation - get only active systems
      activeSystems = await systemsManager.getActiveSystems();
    }

    if (activeSystems.length === 0) {
      console.log("[Cron] No active systems to poll");
      return NextResponse.json({
        success: true,
        message: "No systems to poll",
        count: 0,
      });
    }

    console.log(
      `[Cron] Starting polling session ${sessionId} with ${activeSystems.length} systems`,
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
            // Send initial metadata with list of systems to be polled
            // Only include systems that actually support polling (not push-only)
            const systemsList = activeSystems
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
              timestamp: formatTimeAEST(
                fromDate(new Date(), "Australia/Brisbane"),
              ),
              sessionStartMs: apiStartTime,
              totalSystems: activeSystems.length,
              systems: systemsList,
            };
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "start", data: metadata })}\n\n`,
              ),
            );

            // Poll all systems with progress callbacks
            const results = await pollAllSystems({
              activeSystems,
              sessionId,
              isUserOriginated,
              includeRaw,
              dryRun,
              sessionCause,
              onProgress: (result: PollingResult) => {
                // Send progress event for each stage completion
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "progress", data: result })}\n\n`,
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

            const summary = {
              sessionId,
              timestamp: formatTimeAEST(
                fromDate(new Date(), "Australia/Brisbane"),
              ),
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
            };

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "complete", data: summary })}\n\n`,
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
                `data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`,
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
    const results = await pollAllSystems({
      activeSystems,
      sessionId,
      isUserOriginated,
      includeRaw,
      dryRun,
      sessionCause,
    });

    const successCount = results.filter((r) => r.action === "POLLED").length;
    const skippedCount = results.filter((r) => r.action === "SKIPPED").length;
    const failureCount = results.filter((r) => r.action === "ERROR").length;

    // Create sanitized results for logging (truncate rawResponse if present)
    const resultsForLogging = results.map((r) => {
      const log: any = { ...r };
      // Only include rawResponse in log if it exists
      if ("rawResponse" in r && r.rawResponse) {
        log.rawResponse =
          JSON.stringify(r.rawResponse).substring(0, 60) + "...";
      } else if ("rawResponse" in r) {
        // Remove the field if it's explicitly undefined
        delete log.rawResponse;
      }
      return log;
    });

    // Calculate total API call duration
    const durationMs = Date.now() - apiStartTime;

    console.log(
      `[Cron] Polling complete in ${durationMs} ms. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`,
      resultsForLogging,
    );

    // Format timestamp using AEST
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
    ); // AEST timezone offset
  } catch (error) {
    console.error("[Cron] Fatal error:", error);

    // Calculate duration even for errors
    const durationMs = Date.now() - apiStartTime;

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs,
      },
      { status: 500 },
    );
  }
}
