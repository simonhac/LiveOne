/**
 * Success-path chatter that production does not ship.
 *
 * Every production `console.*` line goes through the Vercel log drain to Better Stack, which is on
 * the 3 GB/month free tier. Vercel wraps each line in ~800 bytes of envelope (request metadata,
 * deployment ids, proxy block), so the COUNT of lines is the cost, not their length: a 40-byte
 * "Processed in 11ms" costs about the same as a 280-byte one. Measured 2026-10-02, the drain was
 * at ~120 MB/day (~3.6 GB/month), mostly per-request and per-device success lines like the ones
 * routed through here.
 *
 * Use this for "it worked" lines that repeat on every request or every device on every tick.
 * Errors, warnings, and the once-per-tick summary lines (`[Cron] Starting polling session`,
 * `[Cron] Polling complete`) stay on `console.*`: they are what the drain is for.
 *
 * On in dev, preview, tests, and operator CLIs (anything not VERCEL_ENV=production). In
 * production, set LOG_LEVEL=debug to turn it back on while diagnosing.
 */
export function debugLog(...args: unknown[]): void {
  if (
    process.env.VERCEL_ENV === "production" &&
    process.env.LOG_LEVEL !== "debug"
  ) {
    return;
  }
  console.log(...args);
}
