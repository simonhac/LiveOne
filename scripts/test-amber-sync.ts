/**
 * Test script for Amber sync client
 * Tests the methodical audit-based syncing system
 *
 * ⚠️  DRY RUN BY DEFAULT - No database writes unless --dry=false
 * ⚠️  SAMPLE RECORDS HIDDEN BY DEFAULT - Add --sample=true to show sample records
 *
 * Usage:
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=forecasts
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=usage
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=both
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --days=3 --action=both
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=both --dry=false  # Actually write to DB
 *   npx tsx scripts/test-amber-sync.ts --date=2025-11-19 --action=both --sample=true  # Show sample records
 */

import { updateUsage, updateForecasts } from "../lib/vendors/amber/client.js";
import { parseDateISO } from "../lib/date-utils.js";
import type { AmberSyncResult } from "../lib/vendors/amber/types.js";
import {
  getOverviewKeys,
  getSampleRecordKeys,
} from "../lib/vendors/amber/types.js";
import { toZoned, fromDate } from "@internationalized/date";

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

async function testSync() {
  // Amber system ID (from dev database)
  const systemId = 10001;

  // Parse command line arguments
  const args = process.argv.slice(2);
  let dateArg = "";
  let actionArg = "usage";
  let daysArg = "1";
  let dryRun = true; // Default to dry run
  let showSample = false; // Default to not showing sample records

  for (const arg of args) {
    if (arg.startsWith("--date=")) {
      dateArg = arg.substring(7);
    } else if (arg.startsWith("--action=")) {
      actionArg = arg.substring(9).toLowerCase();
    } else if (arg.startsWith("--days=")) {
      daysArg = arg.substring(7);
    } else if (arg.startsWith("--dry=")) {
      const dryValue = arg.substring(6).toLowerCase();
      dryRun = dryValue !== "false";
    } else if (arg.startsWith("--sample=")) {
      const sampleValue = arg.substring(9).toLowerCase();
      showSample = sampleValue === "true";
    }
  }

  if (!dateArg) {
    console.error("Error: --date argument is required");
    console.error(
      "Usage: npx tsx scripts/test-amber-sync.ts --date=YYYY-MM-DD [--days=N] [--dry=true|false] [--sample=true|false] --action=usage|forecasts|both",
    );
    console.error(
      "\n⚠️  DRY RUN BY DEFAULT - Add --dry=false to actually persist to the database",
    );
    console.error(
      "⚠️  SAMPLE RECORDS HIDDEN BY DEFAULT - Add --sample=true to show sample records",
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

  console.log("=".repeat(60));
  if (dryRun) {
    console.log("🧪 DRY RUN MODE - No database writes will occur");
    console.log("   Add --dry=false to actually persist to the database");
  } else {
    console.log("⚠️  LIVE MODE - Database writes ENABLED");
    console.log("   Data will be written to the database!");
  }
  console.log("=".repeat(60));
  console.log(`Testing Amber sync for system ${systemId}:`);
  console.log(
    `    day: ${firstDay.toString()} for ${numberOfDays} ${numberOfDays === 1 ? "day" : "days"}`,
  );
  console.log(`    action: *${actionArg}*`);
  console.log("=".repeat(60));

  const audits: AmberSyncResult[] = [];

  if (actionArg === "usage" || actionArg === "both") {
    const audit = await updateUsage(
      systemId,
      firstDay,
      numberOfDays,
      credentials,
      -1, // sessionId: -1 for test script
      dryRun,
    );
    audits.push(audit);
  }

  if (actionArg === "forecasts" || actionArg === "both") {
    const audit = await updateForecasts(
      systemId,
      firstDay,
      numberOfDays,
      credentials,
      -1, // sessionId: -1 for test script
      dryRun,
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
    console.log(`Success: ${audit.success ? "✅ YES" : "❌ NO"}`);
    console.log(`Total stages: ${audit.summary.totalStages}`);
    console.log(`Rows inserted: ${audit.summary.numRowsInserted}`);
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
      console.log(`Num Records: ${stage.info.numRecords}`);
      console.log(`Uniformity: '${stage.info.uniformQuality}'`);

      // Display comparison overviews first if present (even when numRecords is 0)
      if (stage.info.comparisonOverviews) {
        const compKeys = Object.keys(stage.info.comparisonOverviews);
        if (compKeys.length > 0) {
          console.log(`\nComparison Overviews (${compKeys.length} series):`);
          for (const pointKey of compKeys.sort()) {
            console.log(
              `  ${pointKey.padEnd(20)}: ${stage.info.comparisonOverviews[pointKey]}`,
            );
          }
        }
      }

      if (stage.info.numRecords === 0) {
        console.log(
          "\nNo regular overview or canonical display (0 superior records).",
        );
      } else {
        // Display regular overviews sorted by point key
        const overviewKeys = getOverviewKeys(stage.info);
        if (overviewKeys.length > 0) {
          console.log(
            `\nRegular Overviews by point (${overviewKeys.length} series):`,
          );
          for (const pointKey of overviewKeys.sort()) {
            console.log(
              `  ${pointKey.padEnd(20)}: ${stage.info.overviews[pointKey]}`,
            );
          }
        }

        if (stage.info.characterisation) {
          console.log(
            `\nCharacterisation (${stage.info.characterisation.length} ranges):`,
          );
          for (const range of stage.info.characterisation) {
            const startTime = formatAESTTime(range.rangeStartTimeMs);
            const endTime = formatAESTTime(range.rangeEndTimeMs);
            const quality = range.quality || "null";
            const points = range.pointOriginIds.join(", ") || "(none)";
            console.log(
              `  ${startTime} → ${endTime} | Quality: '${quality}' | Points: ${points}`,
            );
          }
        }

        // Display sample records if available and requested
        if (showSample) {
          const sampleKeys = getSampleRecordKeys(stage.info);
          if (sampleKeys.length > 0) {
            console.log(`\nSample Records (up to 2 from each point):`);
            for (const pointKey of sampleKeys.sort()) {
              const sampleInfo = stage.info.sampleRecords![pointKey];
              console.log(`\n  ${pointKey}:`);
              for (let i = 0; i < sampleInfo.records.length; i++) {
                const r = sampleInfo.records[i];
                const timeStr = formatAESTDateTime(r.measurementTimeMs);
                const value =
                  typeof r.rawValue === "number"
                    ? r.rawValue.toFixed(3)
                    : r.rawValue;
                const quality = r.quality || "—";
                console.log(
                  `    ${i + 1}. ${timeStr} | value: ${value} | quality: ${quality}`,
                );
              }
              if (sampleInfo.numSkipped) {
                console.log(
                  `    (and ${sampleInfo.numSkipped} ${sampleInfo.numSkipped === 1 ? "record" : "records"} omitted for brevity)`,
                );
              }
            }
          }
        }

        // Display canonical table if available
        if (stage.info.canonical && stage.info.canonical.length > 0) {
          console.log("\nCanonical Display (Melbourne Timezone):");
          for (const line of stage.info.canonical) {
            console.log(line);
          }
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

    // Create a clean version without records and samples (temporary)
    const cleanAudit = {
      systemId: audit.systemId,
      firstDay: audit.firstDay.toString(),
      numberOfDays: audit.numberOfDays,
      stages: audit.stages.map((stage) => ({
        stage: stage.stage,
        request: stage.request,
        discovery: stage.discovery,
        info: {
          numRecords: stage.info.numRecords,
          uniformQuality: stage.info.uniformQuality,
          overviews: stage.info.overviews,
          characterisation: stage.info.characterisation?.map((range) => ({
            rangeStartTimeMs: range.rangeStartTimeMs,
            rangeEndTimeMs: range.rangeEndTimeMs,
            quality: range.quality,
            pointOriginIds: range.pointOriginIds,
          })),
          // Temporarily omit sampleRecords
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
