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

export async function GET(request: NextRequest) {
  const apiStartTime = Date.now(); // Track API call start time
  const sessionId = getNextSessionId(); // Get session ID for this API invocation

  try {
    // Validate cron request or admin user
    if (!(await validateCronRequest(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Determine session cause: CRON (scheduled) vs ADMIN (manual trigger)
    const authHeader = request.headers.get("authorization");
    const isCronRequest = authHeader === `Bearer ${process.env.CRON_SECRET}`;
    const sessionCause = isCronRequest ? "CRON" : "ADMIN";

    // In development, allow testing specific systems with force flag
    const searchParams = request.nextUrl.searchParams;
    const testSystemId = searchParams.get("systemId");
    const forceTest = searchParams.get("force") === "true";
    const includeRaw = searchParams.get("includeRaw") === "true";

    if (testSystemId && forceTest) {
      console.log(`[Cron] Testing system ${testSystemId} with force=true`);
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

    const results: PollingResult[] = [];
    let subSequence = 0;

    // Poll each system using the new vendor adapter architecture
    for (const system of activeSystems) {
      subSequence++; // Increment for each system
      const sessionLabel = formatSessionId(sessionId, subSequence);
      // Get the vendor adapter first to check if it supports polling
      const adapter = VendorRegistry.getAdapter(system.vendorType);

      if (!adapter) {
        console.error(`[Cron] Unknown vendor type: ${system.vendorType}`);
        results.push({
          action: "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          error: `Unknown vendor type: ${system.vendorType}`,
          lastPoll: system.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  system.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        });
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
      const shouldPollCheck = await adapter.shouldPoll(system, forceTest, now);

      if (!shouldPollCheck.shouldPoll) {
        results.push({
          action: "SKIPPED",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          reason: shouldPollCheck.reason,
          lastPoll: system.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  system.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        });
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
          results.push({
            action: "ERROR",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            error: "No owner configured",
            lastPoll: system.pollingStatus?.lastPollTime
              ? formatTimeAEST(
                  fromDate(
                    system.pollingStatus.lastPollTime,
                    "Australia/Brisbane",
                  ),
                )
              : null,
          });
          continue;
        }

        // Get credentials for this system
        const credentials = await getSystemCredentials(
          system.ownerClerkUserId,
          system.id,
        );

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
          results.push({
            action: "ERROR",
            systemId: system.id,
            displayName: system.displayName || undefined,
            vendorType: system.vendorType,
            sessionLabel: sessionLabel || undefined,
            error: "No credentials found",
            lastPoll: system.pollingStatus?.lastPollTime
              ? formatTimeAEST(
                  fromDate(
                    system.pollingStatus.lastPollTime,
                    "Australia/Brisbane",
                  ),
                )
              : null,
          });
          continue;
        }

        // Let the adapter handle the polling logic
        const result = await adapter.poll(
          system,
          credentials,
          forceTest,
          now,
          dbSessionId,
        );

        // Calculate duration
        const duration = Date.now() - sessionStart.getTime();

        // Process the result
        switch (result.action) {
          case "POLLED":
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

            // Update polling status with raw response
            await updatePollingStatusSuccess(system.id, result.rawResponse);

            // Update session with successful result
            await sessionManager.updateSessionResult(dbSessionId, {
              duration,
              successful: true,
              response: result.rawResponse,
              numRows: result.recordsProcessed || 0,
            });

            results.push({
              action: "POLLED",
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              sessionLabel: sessionLabel || undefined,
              recordsProcessed: result.recordsProcessed,
              ...(includeRaw && result.rawResponse
                ? { rawResponse: result.rawResponse }
                : {}),
              lastPoll: formatTimeAEST(fromDate(now, "Australia/Brisbane")),
            });

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
            // Update error status
            await updatePollingStatusError(
              system.id,
              result.error || "Unknown error",
            );

            // Update session with error result
            await sessionManager.updateSessionResult(dbSessionId, {
              duration,
              successful: false,
              errorCode: result.errorCode || null,
              error: result.error || null,
              numRows: 0,
            });

            results.push({
              action: "ERROR",
              systemId: system.id,
              displayName: system.displayName || undefined,
              vendorType: system.vendorType,
              sessionLabel: sessionLabel || undefined,
              error: result.error,
              lastPoll: system.pollingStatus?.lastPollTime
                ? formatTimeAEST(
                    fromDate(
                      system.pollingStatus.lastPollTime,
                      "Australia/Brisbane",
                    ),
                  )
                : null,
            });
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

        results.push({
          action: "ERROR",
          systemId: system.id,
          displayName: system.displayName || undefined,
          vendorType: system.vendorType,
          sessionLabel: sessionLabel || undefined,
          error: error instanceof Error ? error.message : "Unknown error",
          lastPoll: system.pollingStatus?.lastPollTime
            ? formatTimeAEST(
                fromDate(
                  system.pollingStatus.lastPollTime,
                  "Australia/Brisbane",
                ),
              )
            : null,
        });
      }
    }

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

    console.log(
      `[Cron] Polling complete. success: ${successCount}, failed: ${failureCount}, skipped: ${skippedCount}`,
      resultsForLogging,
    );

    // Calculate total API call duration
    const durationMs = Date.now() - apiStartTime;

    // Format timestamp using AEST
    const nowZoned = fromDate(new Date(), "Australia/Brisbane");
    const timestamp = formatTimeAEST(nowZoned);

    return NextResponse.json({
      success: true,
      sessionId,
      timestamp,
      durationMs,
      summary: {
        total: results.length,
        successful: successCount,
        failed: failureCount,
        skipped: skippedCount,
      },
      results,
    });
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
