/**
 * Per-site dead-man's-switch ping.
 *
 * The hub's only outbound channel is its push to gusher, which meant the ONLY liveness signal for a
 * site was receiver-side `device_state` freshness alerting. On 2026-09-11 the receiver was down for
 * the entire window in which the Daylesford collector died — so the thing that would have raised
 * the alarm was itself the thing that was broken, and the collector stayed dead for 4 h 49 m.
 *
 * A heartbeat to an external third party (BetterStack) is strictly better, because it fires
 * whether gusher is down, the hub is wedged, the hub is dead, or Fly is down. Silence is the alarm,
 * so there is no failure mode in which the alarm is missing.
 *
 * 🛑 What counts as a heartbeat is the whole design. We ping only when a tick DELIVERED REAL DEVICE
 * READINGS. Two weaker conditions are both wrong:
 *   - "the tick succeeded" — a source can tick happily while every push fails.
 *   - "a push succeeded" — on a read error with a supervisor attached, tickOnce still delivers the
 *     synthetic control-plane points and reports pushOk. A totally dead generator would therefore
 *     keep the heartbeat green forever. `count !== null` is what excludes that.
 */

const DEFAULT_THROTTLE_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

export interface HeartbeatOptions {
  /** ping URL (a BetterStack heartbeat). */
  url: string;
  /** at most one ping per this long; default 60 s */
  throttleMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export interface Heartbeat {
  /**
   * Record a tick. Fire-and-forget: never awaited, never throws, and never rejects — a monitoring
   * side-channel must not be able to affect collection.
   */
  onTick(result: {
    delivered?: boolean;
    pushOk?: boolean;
    count: number | null;
  }): void;
}

export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  let lastPingAt = -Infinity;

  return {
    onTick(result) {
      // See the header: real readings, actually delivered, actually accepted.
      if (!result.delivered || !result.pushOk || result.count === null) return;
      const t = now();
      if (t - lastPingAt < throttleMs) return;
      lastPingAt = t;
      void (async () => {
        try {
          await doFetch(opts.url, {
            method: "POST",
            signal: AbortSignal.timeout(PING_TIMEOUT_MS),
          });
        } catch (e) {
          // A failed heartbeat is not an incident — the monitor will notice the silence itself.
          log(
            `heartbeat ping failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
    },
  };
}

/**
 * Resolve a site's heartbeat URL from the env var its config names.
 *
 * Indirection via the YAML (like `apiKeyEnv` / `passkeyEnv`), NOT a derived name convention: there
 * is no literal `*_API_KEY` anywhere in this package, and sheephouse's key is `MUSHER_API_KEY`, not
 * `SHEEPHOUSE_API_KEY`. Guessing names is how you get a silent no-op.
 *
 * Unset or unnamed = no heartbeat for that site, silently. Monitoring is opt-in per site.
 */
export function resolveHeartbeatUrl(
  heartbeatUrlEnv: string | undefined,
): string | undefined {
  if (!heartbeatUrlEnv) return undefined;
  return process.env[heartbeatUrlEnv] || undefined;
}
