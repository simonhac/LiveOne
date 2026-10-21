/**
 * The "it's back" half of the device alert.
 *
 * `/api/cron/monitor-observations` says a device is down every 15 minutes for as long as it is down
 * — 39 times across the 17 Oct 2026 Kutis outage — and then said nothing when it came back, so the
 * last thing in the channel was an alert that had stopped being true nine seconds after it was sent.
 *
 * Decided at the POLL that succeeds, not by the monitor: that success is the one moment the
 * transition happens, so the notice goes out exactly once without the monitor having to remember
 * what it said last time (and without a missed cron tick swallowing it).
 */
import { DateTime } from "luxon";
import { sendAlert } from "@/lib/alerts";
import {
  alertable,
  classifyDeviceHealth,
  isMonitored,
  type StaleAdapter,
} from "@/lib/monitoring/device-staleness";
import type { PreviousPollState } from "@/lib/polling-utils";

/** "9 h 55 m", "40 m", "2 d 3 h" — the outage's length, as a person would say it. */
export function formatOutage(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}

/**
 * The recovery notice for a successful poll, or null when there is nothing to announce.
 *
 * "Something to announce" is exactly "the monitor would have been alerting on this device the
 * instant before this poll" — judged by `classifyDeviceHealth`, the monitor's own verdict, so an
 * outage the monitor never raised (a short blip, a vendor inside its declared maintenance window)
 * never gets a recovery either.
 */
export function recoveryNotice(params: {
  device: {
    id: number;
    displayName: string;
    vendorType: string;
    displayTimezone: string;
  };
  adapter: StaleAdapter;
  prev: PreviousPollState | null;
  recoveredAtMs: number;
}): string | null {
  const { device, adapter, prev, recoveredAtMs } = params;
  // Only a device the monitor judges can have been alerted on — see `isMonitored`.
  if (!isMonitored(adapter)) return null;
  // No previous success: a first-ever poll is an arrival, not a recovery.
  if (!prev || prev.prevSuccessMs == null) return null;

  const outageMs = recoveredAtMs - prev.prevSuccessMs;
  const before = classifyDeviceHealth(
    {
      rid: device.id,
      name: device.displayName,
      vendor: device.vendorType,
      staleMs: outageMs,
      consecutiveErrors: prev.prevConsecutiveErrors,
      nowMs: recoveredAtMs,
    },
    adapter,
  );
  if (alertable([before]).length === 0) return null;

  const at = DateTime.fromMillis(recoveredAtMs, {
    zone: device.displayTimezone,
    locale: "en-AU",
  }).toFormat("HH:mm ZZZZ");
  const failed =
    prev.prevConsecutiveErrors > 0
      ? ` (${prev.prevConsecutiveErrors} failed poll${prev.prevConsecutiveErrors === 1 ? "" : "s"})`
      : "";
  return (
    `✅ ${device.vendorType} device ${device.id} (${device.displayName}) recovered at ${at} ` +
    `after ${formatOutage(outageMs)} without a successful poll${failed}.`
  );
}

/** Send {@link recoveryNotice} when there is one. Best-effort: never throws. */
export async function announceRecovery(
  params: Parameters<typeof recoveryNotice>[0],
): Promise<void> {
  try {
    const text = recoveryNotice(params);
    if (!text) return;
    console.log(`[Recovery] ${text}`);
    await sendAlert(text, "[Recovery]");
  } catch (err) {
    console.error("[Recovery] notice failed (swallowed):", err);
  }
}
