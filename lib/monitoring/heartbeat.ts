/**
 * Outbound dead-man's-switch ping (BetterStack heartbeat).
 *
 * The serverless twin of `packages/usher/core/heartbeat.ts`, and deliberately NOT a copy of it. The
 * hub is a long-lived process, so there it is fire-and-forget with a throttle across ticks. Here we
 * are inside a Vercel function that is frozen the moment the handler returns — an un-awaited fetch
 * is simply killed, silently, which would make the heartbeat look dead while the collector was
 * fine. So this one is AWAITED, and bounded instead of throttled.
 *
 * Why an external heartbeat at all, when `/api/cron/monitor-observations` already checks staleness:
 * every one of those checks runs inside this app and queries the same Postgres it is judging. On
 * 2026-09-11 Postgres went away, every check degraded to `warn`, the webhook was never called, and
 * the outage ran 8 h 49 m before a human noticed. Silence reaching a third party cannot fail that
 * way — it is the one signal that does not depend on the thing it is watching.
 */

const PING_TIMEOUT_MS = 5_000;

/**
 * Ping a heartbeat URL. Returns whether the ping was accepted.
 *
 * Never throws: a monitoring side-channel must not be able to fail a cron run. `undefined` url =
 * heartbeat not configured for this deployment, which is a silent no-op by design (dev and preview
 * must not ping production's heartbeat).
 */
export async function pingHeartbeat(
  url: string | undefined,
  opts: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<boolean> {
  if (!url) return false;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));
  try {
    const res = await doFetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`[heartbeat] ping rejected with ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    // A missed ping is not an incident on its own — the monitor's grace period absorbs it, and if
    // they keep failing the resulting silence is exactly the alarm we want.
    log(
      `[heartbeat] ping failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * The poll loop's heartbeat URL, or undefined when unconfigured.
 *
 * One heartbeat for the whole loop rather than one per device: it answers "is the collector alive
 * and landing data", which is the question no in-app check can answer about itself. Per-device
 * granularity is `monitor-observations`' job (and `/api/health/devices`), where it is cheap.
 */
export function collectorHeartbeatUrl(): string | undefined {
  return process.env.COLLECTOR_HEARTBEAT_URL || undefined;
}
