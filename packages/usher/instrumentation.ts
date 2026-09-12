/**
 * Next.js instrumentation — runs once when the usher server boots. Starts the collector run-loop
 * (load usher.yaml → build sources → run). Fired-and-not-awaited so it doesn't block startup; the
 * loop runs for the server's lifetime (a persistent Fly machine / Pi).
 *
 * Config-load errors (e.g. no usher.yaml in local dev) are logged, not fatal — the server + inspector
 * still come up (the inspector just shows "not started"). Set USHER_AUTOSTART=false to skip.
 */
export async function register() {
  // Only in the Node.js server runtime (not edge, not build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

  // Process metrics to Better Stack. ABOVE the USHER_AUTOSTART guard on purpose: that flag turns
  // off the *collector loop*, and it is set precisely when someone is debugging this process —
  // which is exactly when its memory and event-loop numbers matter most. Tying observability to it
  // would blind you at the moment you reached for the switch.
  //
  // Wrapped because losing metrics must never cost a reading: liveone-flyhub had no telemetry of
  // any kind before 2026-09-12, and the usher's actual job is polling generators and inverters.
  try {
    const { initTelemetry } = await import("./core/telemetry");
    const { startRuntimeMetrics } = await import("./core/runtime-metrics");
    initTelemetry(log);
    startRuntimeMetrics(log);
  } catch (e) {
    log(
      `[usher] runtime metrics not started: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (process.env.USHER_AUTOSTART === "false") return;

  const { startUsher } = await import("./core/usher");

  // Not awaited: startUsher runs the loop forever. Catch config/startup errors so they don't crash boot.
  startUsher({ log }).catch((e) => {
    console.error(
      `[usher] not started: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}
