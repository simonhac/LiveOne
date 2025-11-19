/**
 * Test script for Amber sync client
 * Tests the methodical audit-based syncing system
 *
 * Usage:
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=forecasts
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=usage
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=both
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --days=3 --action=both
 */

import { updateUsage, updateForecasts } from "@/lib/vendors/amber/client";
import { parseDateISO } from "@/lib/date-utils";
import type { SyncAudit } from "@/lib/vendors/amber/types";

async function testSync() {
  // Amber system ID (from dev database)
  const systemId = 10001;

  // Parse command line arguments
  const args = process.argv.slice(2);
  let dateArg = "";
  let actionArg = "usage";
  let daysArg = "1";

  for (const arg of args) {
    if (arg.startsWith("--date=")) {
      dateArg = arg.substring(7);
    } else if (arg.startsWith("--action=")) {
      actionArg = arg.substring(9).toLowerCase();
    } else if (arg.startsWith("--days=")) {
      daysArg = arg.substring(7);
    }
  }

  if (!dateArg) {
    console.error("Error: --date argument is required");
    console.error(
      "Usage: npx tsx scripts/test-amber-sync.ts --date=YYYY-MM-DD [--days=N] --action=usage|forecasts|both",
    );
    process.exit(1);
  }

  // Validate action argument
  if (!["usage", "forecasts", "both"].includes(actionArg)) {
    console.error(`Invalid action: ${actionArg}`);
    console.error("Valid options: usage, forecasts, both");
    process.exit(1);
  }

  // Parse and validate days
  const numberOfDays = parseInt(daysArg, 10);
  if (isNaN(numberOfDays) || numberOfDays < 1 || numberOfDays > 30) {
    console.error(`Invalid --days value: ${daysArg}`);
    console.error("Must be a number between 1 and 30");
    process.exit(1);
  }

  const firstDay = parseDateISO(dateArg);

  // Credentials from environment or hardcoded for testing
  const credentials = {
    apiKey: process.env.AMBER_API_KEY || "psk_a5b4b523ec85b30a203212597a58c3af",
    siteId: process.env.AMBER_SITE_ID || "01E8RD8Q0GABW66Z0WP8RDT6X1",
  };

  console.log(
    `Testing Amber sync for system ${systemId}, first day: ${firstDay.toString()}, days: ${numberOfDays}, action: ${actionArg}...`,
  );
  console.log("=".repeat(60));

  const audits: SyncAudit[] = [];

  if (actionArg === "usage" || actionArg === "both") {
    const audit = await updateUsage(
      systemId,
      firstDay,
      numberOfDays,
      credentials,
    );
    audits.push(audit);
  }

  if (actionArg === "forecasts" || actionArg === "both") {
    const audit = await updateForecasts(
      systemId,
      firstDay,
      numberOfDays,
      credentials,
    );
    audits.push(audit);
  }

  // Display each audit
  for (let i = 0; i < audits.length; i++) {
    const audit = audits[i];
    const taskName =
      i === 0 && actionArg === "both"
        ? "USAGE"
        : i === 1 && actionArg === "both"
          ? "FORECASTS"
          : actionArg.toUpperCase();

    console.log("\n" + "=".repeat(60));
    console.log(`=== ${taskName} SYNC AUDIT SUMMARY ===`);
    console.log("=".repeat(60));
    console.log(`System ID: ${audit.systemId}`);
    console.log(`First Day: ${audit.firstDay.toString()}`);
    console.log(`Number of Days: ${audit.numberOfDays}`);
    console.log(`Total stages: ${audit.summary.totalStages}`);
    console.log(`Duration: ${audit.summary.durationMs}ms`);

    if (audit.summary.error) {
      console.log(`\n❌ ERROR: ${audit.summary.error}`);
    }

    if (audit.summary.exception) {
      console.log(`\n❌ EXCEPTION:`, audit.summary.exception);
    }

    // Display each stage result
    for (const stage of audit.stages) {
      console.log("\n" + "-".repeat(60));
      console.log(`--- ${stage.stage} ---`);
      console.log("-".repeat(60));
      if (stage.request) {
        console.log(`Request: ${stage.request}`);
      }
      if (stage.discovery) {
        console.log(`Discovery: ${stage.discovery}`);
      }
      console.log(`Completeness: ${stage.info.completeness}`);
      console.log(`Num Records: ${stage.info.numRecords}`);

      // Display overviews sorted by point key
      if (stage.info.overviews.size > 0) {
        console.log(
          `\nOverviews by point (${stage.info.overviews.size} series):`,
        );
        const sortedPoints = Array.from(stage.info.overviews.entries()).sort(
          (a, b) => a[0].localeCompare(b[0]),
        );
        for (const [pointKey, overview] of sortedPoints) {
          console.log(`  ${pointKey.padEnd(20)}: ${overview}`);
        }
      } else {
        console.log("\nNo overviews available");
      }

      if (stage.info.characterisation) {
        console.log(
          `\nCharacterisation (${stage.info.characterisation.length} ranges):`,
        );
        for (const range of stage.info.characterisation) {
          // Convert to AEST (UTC+10) and format as HH:MM
          const startAEST = new Date(
            range.rangeStartTimeMs + 10 * 60 * 60 * 1000,
          );
          const endAEST = new Date(range.rangeEndTimeMs + 10 * 60 * 60 * 1000);
          const startTime = `${String(startAEST.getUTCHours()).padStart(2, "0")}:${String(startAEST.getUTCMinutes()).padStart(2, "0")}`;
          const endTime = `${String(endAEST.getUTCHours()).padStart(2, "0")}:${String(endAEST.getUTCMinutes()).padStart(2, "0")}`;
          const quality = range.quality || "null";
          const points = range.pointOriginIds.join(", ") || "(none)";
          console.log(`  ${startTime} → ${endTime} | Quality: ${quality}`);
          console.log(`    Points: ${points}`);
        }
      } else if (stage.records && stage.records.size > 0) {
        console.log(`\nRecords: ${stage.records.size} time intervals`);
      }

      // Display canonical table if available
      if (stage.info.canonical && stage.info.canonical.length > 0) {
        console.log("\nCanonical Display (Melbourne Timezone):");
        for (const line of stage.info.canonical) {
          console.log(line);
        }
      }

      if (stage.error) {
        console.log(`\n❌ ERROR:`, stage.error);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Test completed");
  console.log("=".repeat(60));

  // Print full audit JSON at the end (without records)
  for (let i = 0; i < audits.length; i++) {
    const audit = audits[i];
    const taskName =
      i === 0 && actionArg === "both"
        ? "USAGE"
        : i === 1 && actionArg === "both"
          ? "FORECASTS"
          : actionArg.toUpperCase();

    console.log("\n" + "=".repeat(60));
    console.log(`${taskName} AUDIT JSON (records omitted):`);
    console.log("=".repeat(60));

    // Create a clean version without records
    const cleanAudit = {
      systemId: audit.systemId,
      firstDay: audit.firstDay.toString(),
      numberOfDays: audit.numberOfDays,
      stages: audit.stages.map((stage) => ({
        stage: stage.stage,
        request: stage.request,
        discovery: stage.discovery,
        info: {
          completeness: stage.info.completeness,
          overviews: Object.fromEntries(stage.info.overviews),
          numRecords: stage.info.numRecords,
          characterisation: stage.info.characterisation?.map((range) => ({
            rangeStartTimeMs: range.rangeStartTimeMs,
            rangeEndTimeMs: range.rangeEndTimeMs,
            quality: range.quality,
            pointOriginIds: range.pointOriginIds,
          })),
        },
        error: stage.error,
      })),
      summary: audit.summary,
    };

    // Custom JSON formatting: keep arrays on single lines
    const jsonStr = JSON.stringify(cleanAudit, null, 2);
    const formatted = jsonStr.replace(
      /"pointOriginIds":\s*\[\s*([^\]]+?)\s*\]/g,
      (match, content) => {
        const cleaned = content.replace(/\s+/g, " ").replace(/\n/g, "");
        return `"pointOriginIds": [${cleaned}]`;
      },
    );

    console.log(formatted);
  }
}

// Run the test
testSync().catch((error) => {
  console.error("\n❌ Test failed with exception:");
  console.error(error);
  process.exit(1);
});
