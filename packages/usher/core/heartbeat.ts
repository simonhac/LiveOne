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
 * 🛑 What counts as a heartbeat is the whole design. We ping only when REAL DEVICE READINGS WERE
 * ACCEPTED BY THE RECEIVER. Two weaker conditions are both wrong:
 *   - "the tick succeeded" — a source can tick happily while every push fails.
 *   - "a push succeeded" — on a read error with a supervisor attached, the hub still delivers the
 *     synthetic control-plane points, and that push succeeds. A totally dead generator would
 *     therefore keep the heartbeat green forever. `hasDeviceReadings` is what excludes that.
 */

import type { PushOutcome } from "./pusher";

/**
 * Outbound rate cap. Must stay comfortably BELOW the fastest site's delivery cadence: at 60 s it
 * collided with kinkora's 60 s pushes, so jitter alone would drop every second ping and halve the
 * effective heartbeat period — which silently eats the monitor's grace window. 30 s still bounds us
 * to 2 pings/min for any pathologically fast source.
 */
const DEFAULT_THROTTLE_MS = 30_000;
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
   * Record a delivery outcome. Fire-and-forget: never awaited, never throws, and never rejects —
   * a monitoring side-channel must not be able to affect collection.
   */
  onDelivery(r: { outcome: PushOutcome; hasDeviceReadings: boolean }): void;
}

export function createHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  let lastPingAt = -Infinity;

  return {
    onDelivery(r) {
      // See the header: real device readings, actually accepted by the receiver.
      if (r.outcome !== "ok" || !r.hasDeviceReadings) return;
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
