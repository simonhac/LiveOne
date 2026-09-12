/** Offline comparison: npx tsx scripts/gousher/compare-readings.ts input.json > report.json */
import { readFileSync } from "node:fs";
import { compareIntervals } from "../../lib/collectors/interval-comparison";
const file = process.argv[2];
if (!file) throw new Error("Usage: compare-readings.ts input.json");
const report = compareIntervals(JSON.parse(readFileSync(file, "utf8")));
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!report.passed) process.exitCode = 1;
