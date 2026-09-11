/**
 * Stall watchdog — the in-process answer to "the loop stopped and nobody noticed".
 *
 * On 2026-09-11 musher's run loop wedged mid-tick and stayed wedged for 4 h 49 m. Nothing in the
 * system could see it: Next installs its own uncaughtException/unhandledRejection handlers so the
 * process never exits, and Fly cannot health-check this app at all (the only published service is
 * UDP wireguard; the HTTP server is bound to loopback on purpose so the generator control route is
 * not reachable from either site LAN). So the machine stayed "up" and empty.
 *
 * 🛑 Do NOT rebuild this on `registry.tickStates.lastTickAt`. `recordTick` runs only after a tick
 * COMPLETES, and completion is precisely what is missing in a stall — the timestamp would freeze at
 * the last healthy tick and the watchdog would be reading its own blind spot. We stamp the START of
 * each tick instead.
 *
 * EXIT, don't try to self-heal. The wedge lives in socket/library state below our abstractions, so
 * a fresh process is the only guaranteed clean slate. That is safe here because RunSupervisor
 * persists an absolute `stopAt` (fsync'd, before the start write) and resume() re-arms a future
 * deadline or releases immediately on a past one — a restart mid-run neither extends nor abandons a
 * commanded generator run. And with a wedged device mutex the hub cannot stop a running engine at
 * all, so restarting strictly improves the safety posture.
 *
 * There is deliberately no alert webhook here. The heartbeat (core/heartbeat.ts) is the alarm: the
 * exit stops the pings, and the monitor notices the silence. One alerting path, not two.
 */

const STARTUP_GRACE_MS = 120_000;
const MIN_STALL_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 30_000;

export interface WatchdogOptions {
  now?: () => number;
  exit?: (code: number) => void;
  log?: (m: string) => void;
  startupGraceMs?: number;
}

export interface Watchdog {
  /** Called at the TOP of each tick — see the header for why not on completion. */
  noteTickStart(siteId: string): void;
  /** Register a site's expected cadence so its stall threshold can be derived. */
  register(siteId: string, cadenceMs: number): void;
  /** One sweep. Exported for tests; the timer calls it. */
  check(): void;
  start(): { stop: () => void };
}

/**
 * A site is stalled once it has gone 4 cadences without STARTING a tick, floored at 5 minutes.
 *
 * 4x because a single slow tick is normal and must never restart the hub; the 5-minute floor keeps
 * a fast cadence (kinkora polls every 60 s) comfortably clear of the 30 s tick cap plus the device
 * mutex's queue and hold budgets, which can legitimately stack to ~60 s on a bad read.
 */
export function stallThresholdMs(cadenceMs: number): number {
  return Math.max(4 * cadenceMs, MIN_STALL_MS);
}

export function createWatchdog(opts: WatchdogOptions = {}): Watchdog {
  const now = opts.now ?? Date.now;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((m: string) => console.error(m));
  const startupGraceMs = opts.startupGraceMs ?? STARTUP_GRACE_MS;
  const startedAt = now();
  const cadences = new Map<string, number>();
  const lastTickStart = new Map<string, number>();
  let fired = false;

  return {
    register(siteId, cadenceMs) {
      cadences.set(siteId, cadenceMs);
    },
    noteTickStart(siteId) {
      lastTickStart.set(siteId, now());
    },
    check() {
      if (fired) return; // exit() may be a no-op in tests; never fire twice
      const t = now();
      if (t - startedAt < startupGraceMs) return;
      for (const [siteId, cadenceMs] of cadences) {
        const last = lastTickStart.get(siteId);
        // Never ticked at all = a config or construction problem, not a stall. Exiting would only
        // crash-loop the machine, and would take the healthy site down with it on every restart.
        if (last === undefined) continue;
        const age = t - last;
        const threshold = stallThresholdMs(cadenceMs);
        if (age >= threshold) {
          fired = true;
          log(
            `[watchdog] ${siteId} has not started a tick for ${Math.round(age / 1000)}s ` +
              `(threshold ${Math.round(threshold / 1000)}s) — the run loop is wedged. Exiting to restart.`,
          );
          exit(1);
          return;
        }
      }
    },
    start() {
      const timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
      // unref so `--once` and tests can exit without clearing it (matches the maintenance timer).
      timer.unref?.();
      return { stop: () => clearInterval(timer) };
    },
  };
}
