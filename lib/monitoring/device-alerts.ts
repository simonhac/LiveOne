/**
 * Slack throttle for the per-device staleness alert (`/api/cron/monitor-observations`, check 2b).
 *
 * 🛑 THROTTLED PER OUTAGE. Unthrottled, a device that stays down pages on every 15-minute tick for
 * as long as it is down — the Daylesford generator, its controller unpowered by a flat starter
 * battery, posted ~300 identical messages over three days before anyone could reach the site. So an
 * outage alerts on each of its first {@link ONSET_ALERTS} ticks (the window in which it may still be
 * a blip, and in which someone is deciding what to do), then once every {@link REPEAT_HOURS}.
 *
 * The outage's identity is the device plus its LAST SUCCESS: that instant does not move while the
 * device stays down, and a recovery moves it — so the next outage is a new episode and alerts at
 * once, with nothing to clear. Deliberately not the code: a device that goes from `device_failing`
 * to `device_poll_stale` is the same outage getting older, not news.
 *
 * Only the Slack message is throttled. The verdict, the route's JSON `status`, its log line and
 * `/api/health/devices` (an external monitor's contract) are all unchanged.
 */
import { kv, kvKey } from "@/lib/kv";
import type { DeviceHealth } from "@/lib/monitoring/device-staleness";

const ONSET_ALERTS = 6;
const REPEAT_HOURS = 24;
/** Comfortably longer than any outage someone would leave unattended, so the count cannot reset. */
const EPISODE_TTL_S = 30 * 86_400;

/**
 * True when this device's outage is due a message. A KV failure fails OPEN (alerts), because a
 * missed page is worse than a repeated one — and so does an unconfigured KV, whose no-op client
 * returns null.
 */
export async function claimDeviceAlert(d: DeviceHealth): Promise<boolean> {
  const episode = `alert:device:${d.rid}:${d.lastSuccessMs ?? "never"}`;
  const countKey = kvKey(`${episode}:count`);
  const repeatKey = kvKey(`${episode}:repeat`);
  try {
    const n = await kv.incr(countKey);
    if (n == null) return true;
    if (n === 1) await kv.expire(countKey, EPISODE_TTL_S);
    if (n < ONSET_ALERTS) return true;
    // The last onset alert starts the daily clock, so the first repeat lands a day after it rather
    // than on the very next tick.
    const claimed = await kv.set(repeatKey, String(Date.now()), {
      nx: true,
      ex: REPEAT_HOURS * 3600,
    });
    return n === ONSET_ALERTS || claimed != null;
  } catch (err) {
    console.error("[MonitorObservations] alert throttle unavailable:", err);
    return true;
  }
}
