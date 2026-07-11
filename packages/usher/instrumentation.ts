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
  if (process.env.USHER_AUTOSTART === "false") return;

  const { startUsher } = await import("./core/usher");
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  // Not awaited: startUsher runs the loop forever. Catch config/startup errors so they don't crash boot.
  startUsher({ log }).catch((e) => {
    console.error(
      `[usher] not started: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}
