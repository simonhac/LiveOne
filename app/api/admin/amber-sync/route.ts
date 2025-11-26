import { NextRequest, NextResponse } from "next/server";
import { updateUsage, updateForecasts } from "@/lib/vendors/amber/client";
import { parseDateISO } from "@/lib/date-utils";
import type { AmberSyncResult } from "@/lib/vendors/amber/types";
import {
  getOverviewKeys,
  getSampleRecordKeys,
} from "@/lib/vendors/amber/types";
import { toZoned, fromDate } from "@internationalized/date";
import { sessionManager } from "@/lib/session-manager";
import type { SessionInfo } from "@/lib/point/point-manager";
import { getNextSessionId, formatSessionId } from "@/lib/session-id";
import { requireSystemAccess } from "@/lib/api-auth";

/**
 * Format timestamp as AEST (UTC+10) time string (HH:MM)
 * Used for characterisations
 */
function formatAESTTime(timestampMs: number): string {
  const zonedTime = toZoned(fromDate(new Date(timestampMs), "UTC"), "+10:00");
  return `${String(zonedTime.hour).padStart(2, "0")}:${String(zonedTime.minute).padStart(2, "0")}`;
}

/**
 * Format timestamp as AEST (UTC+10) datetime string (YYYY-MM-DD HH:MM)
 * Used for sample records
 */
function formatAESTDateTime(timestampMs: number): string {
  const zonedTime = toZoned(fromDate(new Date(timestampMs), "UTC"), "+10:00");
  return `${String(zonedTime.year).padStart(4, "0")}-${String(zonedTime.month).padStart(2, "0")}-${String(zonedTime.day).padStart(2, "0")} ${String(zonedTime.hour).padStart(2, "0")}:${String(zonedTime.minute).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  try {
    // Clone request to read body twice (once for auth, once for processing)
    const body = await request.json();
    const { systemIdentifier, action, startDate, days, dryRun, showSample } =
      body;

    // Validate inputs before auth check
    if (!systemIdentifier || !action || !startDate || !days) {
      return new Response("Missing required parameters", { status: 400 });
    }

    const systemId = parseInt(systemIdentifier, 10);
    if (isNaN(systemId)) {
      return new Response("Invalid system identifier", { status: 400 });
    }

    // Check system access (owner or admin can sync)
    const authResult = await requireSystemAccess(request, systemId, {
      requireWrite: true,
    });
    if (authResult instanceof NextResponse) return authResult;

    if (!["usage", "pricing", "both"].includes(action)) {
      return new Response("Invalid action", { status: 400 });
    }

    const numberOfDays = parseInt(days, 10);
    if (isNaN(numberOfDays) || numberOfDays < 1 || numberOfDays > 30) {
      return new Response("Invalid days value", { status: 400 });
    }

    const firstDay = parseDateISO(startDate);

    // Credentials from environment
    const credentials = {
      apiKey:
        process.env.AMBER_API_KEY || "psk_a5b4b523ec85b30a203212597a58c3af",
      siteId: process.env.AMBER_SITE_ID || "01E8RD8Q0GABW66Z0WP8RDT6X1",
    };

    const encoder = new TextEncoder();

    // Generate session ID and label
    const sessionIdStr = getNextSessionId();
    const sessionLabel = formatSessionId(sessionIdStr, 1); // Sub-sequence 1 for Amber sync

    const stream = new ReadableStream({
      async start(controller) {
        const send = (
          text: string | string[],
          emphasis = false,
          heading?: 0 | 1 | 2,
        ) => {
          const lines = Array.isArray(text) ? text : [text];
          for (const line of lines) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ text: line, emphasis, heading })}\n\n`,
              ),
            );
          }
        };

        const sendLinefeed = () => send("\u00A0");

        const sendHeader = (text: string, level: 0 | 1 | 2 = 1) => {
          send(text, true, level);
        };

        const delay = () => new Promise((resolve) => setTimeout(resolve, 100));

        const startTime = Date.now();
        let session: SessionInfo | null = null;
        let totalRowsInserted = 0;
        let overallSuccess = true;
        let overallError: string | null = null;

        try {
          // Create session at the start
          session = await sessionManager.createSession({
            sessionLabel,
            systemId,
            cause: dryRun ? "ADMIN-DRYRUN" : "ADMIN",
            started: new Date(),
          });

          // Initial header
          sendHeader("AMBER ELECTRIC DATA SYNC TERMINAL", 0);
          await delay();

          if (dryRun) {
            send("DRY RUN MODE - No database writes will occur", true);
            send("   Add dry run toggle to actually persist to the database");
          } else {
            send("LIVE MODE - Database writes ENABLED", true);
            send("   Data will be written to the database!");
          }
          await delay();

          send(`Testing Amber sync for system ${systemId}:`);
          send(
            `    day: ${firstDay.toString()} for ${numberOfDays} ${numberOfDays === 1 ? "day" : "days"}`,
          );
          send(`    action: *${action}*`);
          send(`    session ID: ${session.id}`);

          const audits: AmberSyncResult[] = [];

          // Run usage sync if requested
          let usageRowsInserted = 0;
          if (action === "usage" || action === "both") {
            const audit = await updateUsage(
              systemId,
              firstDay,
              numberOfDays,
              credentials,
              session,
              dryRun,
            );
            audits.push(audit);
            usageRowsInserted = audit.summary.numRowsInserted;
            if (!audit.success) {
              overallSuccess = false;
              overallError = audit.summary.error || "Usage sync failed";
            }
            totalRowsInserted += audit.summary.numRowsInserted;
          }

          // Run pricing sync if requested
          let priceRowsInserted = 0;
          if (action === "pricing" || action === "both") {
            const audit = await updateForecasts(
              systemId,
              firstDay,
              numberOfDays,
              credentials,
              session,
              dryRun,
            );
            audits.push(audit);
            priceRowsInserted = audit.summary.numRowsInserted;
            if (!audit.success) {
              overallSuccess = false;
              overallError = audit.summary.error || "Pricing sync failed";
            }
            totalRowsInserted += audit.summary.numRowsInserted;
          }

          // Display row counts
          sendLinefeed();
          send("Rows inserted:");
          if (action === "usage" || action === "both") {
            send(`    usage: ${usageRowsInserted}`, true);
          }
          if (action === "pricing" || action === "both") {
            send(`    price: ${priceRowsInserted}`, true);
          }
          await delay();

          // Display each audit
          for (let i = 0; i < audits.length; i++) {
            const audit = audits[i];
            const taskName =
              i === 0 && action === "both"
                ? "USAGE"
                : i === 1 && action === "both"
                  ? "PRICING"
                  : action.toUpperCase();

            sendHeader(`${taskName} SYNC AUDIT SUMMARY`, 1);
            await delay();

            send(`System ID: ${audit.systemId}`);
            send(`First Day: ${audit.firstDay.toString()}`, true);
            send(
              `Last Day: ${audit.firstDay.add({ days: audit.numberOfDays - 1 }).toString()}`,
            );
            send(`Number of Days: ${audit.numberOfDays}`);
            send(`Success: ${audit.success ? "YES" : "NO"}`);
            send(`Total stages: ${audit.summary.totalStages}`);
            send(`Rows inserted: ${audit.summary.numRowsInserted}`, true);
            send(`Duration: ${audit.summary.durationMs}ms`);
            await delay();

            if (audit.summary.error) {
              sendLinefeed();
              send(`ERROR: ${audit.summary.error}`);
              await delay();
            }

            if (audit.summary.exception) {
              sendLinefeed();
              send(`EXCEPTION: ${JSON.stringify(audit.summary.exception)}`);
              await delay();
            }

            // Display each stage result
            for (const stage of audit.stages) {
              sendHeader(stage.stage, 2);
              await delay();

              if (stage.request) {
                send(`Request: ${stage.request}`, false);
              }
              if (stage.discovery) {
                send(`Discovery: ${stage.discovery}`, true);
              }
              send(`Num Records: ${stage.info.numRecords}`);
              if (stage.info.numRecords > 0) {
                const uniformity = stage.info.uniformQuality ?? "not uniform";
                // Only quote single-character uniformity values (quality codes)
                const formattedUniformity =
                  uniformity.length === 1 ? `'${uniformity}'` : uniformity;
                send(`Uniformity: ${formattedUniformity}`);
              }
              await delay();

              // Display overviews (includes comparison notation for comparison stages)
              const overviewKeys = getOverviewKeys(stage.info);
              if (overviewKeys.length > 0) {
                sendLinefeed();
                if (stage.info.numRecords === 0) {
                  send(`Comparison Overviews (${overviewKeys.length} series):`);
                } else {
                  send(
                    `Regular Overviews by point (${overviewKeys.length} series):`,
                  );
                }
                for (const pointKey of overviewKeys.sort()) {
                  send(
                    `  ${pointKey.padEnd(20)}: ${stage.info.overviews[pointKey]}`,
                  );
                }
                await delay();
              }

              if (stage.info.numRecords === 0 && overviewKeys.length === 0) {
                sendLinefeed();
                send(
                  "No regular overview or canonical display (0 superior records).",
                );
                await delay();
              } else {
                if (stage.info.characterisation) {
                  sendLinefeed();
                  send(
                    `Characterisation (${stage.info.characterisation.length} ranges):`,
                  );
                  for (const range of stage.info.characterisation) {
                    const startTime = formatAESTTime(range.rangeStartTimeMs);
                    const endTime = formatAESTTime(range.rangeEndTimeMs);
                    const quality = range.quality || "null";
                    const points = range.pointOriginIds.join(", ") || "(none)";
                    send(
                      `  ${startTime} -> ${endTime} | Quality: '${quality}' | Points: ${points}`,
                    );
                  }
                  await delay();
                }

                // Display sample records if available and requested
                if (showSample) {
                  const sampleKeys = getSampleRecordKeys(stage.info);
                  if (sampleKeys.length > 0) {
                    sendLinefeed();
                    send("Sample Records (up to 2 from each point):");
                    for (const pointKey of sampleKeys.sort()) {
                      const sampleInfo = stage.info.sampleRecords![pointKey];
                      sendLinefeed();
                      send(`  ${pointKey}:`);
                      for (
                        let idx = 0;
                        idx < sampleInfo.records.length;
                        idx++
                      ) {
                        const r = sampleInfo.records[idx];
                        const timeStr = formatAESTDateTime(r.measurementTimeMs);
                        const value =
                          typeof r.rawValue === "number"
                            ? r.rawValue.toFixed(3)
                            : r.rawValue;
                        const quality = r.quality || "—";
                        send(
                          `    ${idx + 1}. ${timeStr} | value: ${value} | quality: ${quality}`,
                        );
                      }
                      if (sampleInfo.numSkipped) {
                        send(
                          `    (and ${sampleInfo.numSkipped} ${sampleInfo.numSkipped === 1 ? "record" : "records"} omitted for brevity)`,
                        );
                      }
                    }
                    await delay();
                  }
                }

                // Display canonical table if available
                if (stage.info.canonical && stage.info.canonical.length > 0) {
                  sendLinefeed();
                  send("Canonical Display (Melbourne Timezone):");
                  for (const line of stage.info.canonical) {
                    send(line);
                  }
                  await delay();
                }
              }

              if (stage.error) {
                sendLinefeed();
                send(`ERROR: ${stage.error}`);
                await delay();
              }
            }
          }

          sendHeader("Test completed", 1);
          await delay();

          // Update session with results
          if (session) {
            const duration = Date.now() - startTime;
            await sessionManager.updateSessionResult(session.id, {
              duration,
              successful: overallSuccess,
              error: overallError,
              numRows: totalRowsInserted,
              response: audits,
            });
          }

          controller.close();
        } catch (error) {
          sendLinefeed();
          send("ERROR: Test failed with exception:");
          send(error instanceof Error ? error.message : String(error));

          // Update session with error if we have a session ID
          if (session) {
            const duration = Date.now() - startTime;
            await sessionManager.updateSessionResult(session.id, {
              duration,
              successful: false,
              error: error instanceof Error ? error.message : String(error),
              numRows: totalRowsInserted,
            });
          }

          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Internal server error",
      { status: 500 },
    );
  }
}
