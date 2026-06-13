/**
 * Run-tracking feature flag. Read once at module load. Only the exact string "true"
 * (trimmed, case-insensitive) is truthy — mirrors lib/areas/flags.ts and lib/dashboard/flags.ts.
 *
 * Off  → the run-periods cron no-ops and the run-periods API returns empty (legacy behaviour).
 * On   → the cron reconciles device run periods and the API serves them.
 * Independent of AREAS_TABLE.
 */

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

export const RUN_TRACKING = envFlag("RUN_TRACKING");
