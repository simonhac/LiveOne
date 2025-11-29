import { NextRequest, NextResponse } from "next/server";
import { SystemsManager } from "@/lib/systems-manager";
import { formatSystemId } from "@/lib/system-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import { getSystemCredentials } from "@/lib/secure-credentials";
import type { PollingResult, PollStage } from "@/lib/vendors/types";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { fromDate } from "@internationalized/date";
import { formatTimeAEST } from "@/lib/date-utils";
import { getNextSessionId, formatSessionId } from "@/lib/session-id";
import { jsonResponse, transformForStorage } from "@/lib/json";

/**
 * Helper function to poll all systems with optional progress callbacks.
 * This function handles the login stage (credential fetch) and delegates
 * the rest (session creation, fetch, insert, session update) to the adapter.
 *
 * @param onSessionStart - Callback called when a system's session is assigned (before polling starts)
 * @param onProgress - Callback called after each stage completes (login, fetch, process)
 */
async function pollAllSystems(params: {
  activeSystems: any[];
  sessionLabelPrefix: string;
  forcePollAll: boolean;
  pollReason: string;
  includeRaw: boolean;
  dryRun: boolean;
  sessionCause: "CRON" | "ADMIN" | "ADMIN-DRYRUN";
  onSessionStart?: (data: {
    systemId: number;
    sessionId: number;
    sessionLabel: string;
  }) => void;
  onProgress?: (result: PollingResult) => void;
}): Promise<PollingResult[]> {
  const {
    activeSystems,
    sessionLabelPrefix,
    forcePollAll,
    pollReason,
    includeRaw,
    dryRun,
    sessionCause,
    onSessionStart,
    onProgress,
  } = params;

  const results: PollingResult[] = [];
  let subSequence = 0;

  // Poll each system using the vendor adapter architecture
  for (const system of activeSystems) {
    const pollStartTime = Date.now();
    const loginStages: PollStage[] = [];
    let capturedSessionId: number | undefined;
    subSequence++;
    const sessionLabel = formatSessionId(sessionLabelPrefix, subSequence);

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
      continue;
    }

    console.log(
      `[Cron] Processing systemId=${system.id} (${system.vendorType}/${system.vendorSiteId} '${system.displayName}') with session ${sessionLabel}`,
    );

    // Check if system has an owner
    if (!system.ownerClerkUserId) {
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        error: "No owner configured",
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
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel,
            durationMs: Date.now() - pollStartTime,
            startMs: pollStartTime,
            endMs: Date.now(),
            stages: [...loginStages],
            inProgress: true,
          });
        }, 200);
      }

      const credentials = await getSystemCredentials(
        system.ownerClerkUserId,
        system.id,
      );

      // Finalize login stage
      if (loginInterval) clearInterval(loginInterval);
      loginStages[0].endMs = Date.now();

      // Send progress after login stage completes
      if (onProgress) {
        onProgress({
          action: "POLLED",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: [...loginStages],
          inProgress: true,
        });
      }

      // Fusher systems don't need credentials for polling - they use push
      if (
        !credentials &&
        adapter.vendorType !== "fusher" &&
        adapter.vendorType !== "fronius"
      ) {
        console.error(
          `[Cron] No credentials found for ${system.vendorType} system ${system.id}`,
        );
        const errorResult: PollingResult = {
          action: "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          error: "No credentials found",
          durationMs: Date.now() - pollStartTime,
          startMs: pollStartTime,
          endMs: Date.now(),
          stages: loginStages,
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

      // Call adapter.poll() with new PollOptions - adapter handles session, fetch, insert
      const result = await adapter.poll(system, credentials, {
        forcePollAll,
        pollReason,
        sessionLabel,
        sessionCause,
        dryRun,
        onSessionStart: (data) => {
          // Capture sessionId for final result
          capturedSessionId = data.sessionId;
          // Forward session-start with system metadata if callback provided
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
                systemId: system.id,
                displayName: system.displayName || undefined,
                vendorType: system.vendorType,
                durationMs: Date.now() - pollStartTime,
                startMs: pollStartTime,
                endMs: Date.now(),
                stages: [...loginStages, ...(partial.stages || [])],
              });
            }
          : undefined,
      });

      // Merge login stage with adapter's fetch + process stages
      const allStages = [...loginStages, ...(result.stages || [])];

      // Build final result
      const now = new Date();
      const finalResult: PollingResult = {
        ...result,
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
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
            : system.pollingStatus?.lastPollTime
              ? formatTimeAEST(
                  fromDate(
                    system.pollingStatus.lastPollTime,
                    "Australia/Brisbane",
                  ),
                )
              : null,
      };

      results.push(finalResult);

      // Send final progress
      if (onProgress) {
        onProgress(finalResult);
      }

      // Log result
      switch (result.action) {
        case "POLLED":
          console.log(
            `[Cron] ${formatSystemId(system)} - Success (${result.recordsProcessed} records)`,
          );
          break;
        case "SKIPPED":
          console.log(
            `[Cron] ${formatSystemId(system)} - Skipped: ${result.reason}`,
          );
          break;
        case "ERROR":
          console.error(
            `[Cron] ${formatSystemId(system)} - Error: ${result.error}`,
          );
          break;
      }
    } catch (error) {
      console.error(`[Cron] Error polling ${system.id}:`, error);
      const errorResult: PollingResult = {
        action: "ERROR",
        systemId: system.id,
        displayName: system.displayName || undefined,
        vendorType: system.vendorType,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - pollStartTime,
        startMs: pollStartTime,
        endMs: Date.now(),
        stages: loginStages,
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
  const apiStartTime = Date.now();
  const sessionId = getNextSessionId();

  try {
    const authResult = await requireCronOrAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

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

    // Clear SystemsManager cache to ensure fresh polling status data
    SystemsManager.invalidateCache();
    const systemsManager = SystemsManager.getInstance();

    // Get systems to poll
    let activeSystems;
    if (testSystemId) {
      const system = await systemsManager.getSystem(parseInt(testSystemId));
      activeSystems = system ? [system] : [];
      console.log(`[Cron] Testing single system: ${testSystemId}`);
    } else {
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
              sessionStartTimeMs: apiStartTime,
              totalSystems: activeSystems.length,
              systems: systemsList,
            };
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(transformForStorage({ type: "start", data: metadata }))}\n\n`,
              ),
            );

            // Poll all systems with progress callbacks
            // Note: session-start is merged into progress events (first progress includes sessionLabel/sessionId)
            const results = await pollAllSystems({
              activeSystems,
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
    const results = await pollAllSystems({
      activeSystems,
      sessionLabelPrefix: sessionId,
      forcePollAll,
      pollReason,
      includeRaw,
      dryRun,
      sessionCause,
    });

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

    console.log(
      `[Cron] Polling complete in ${durationMs} ms. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`,
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
  }
}
