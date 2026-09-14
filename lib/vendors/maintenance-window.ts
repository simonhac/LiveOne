/**
 * A vendor's scheduled, measured window of unavailability.
 *
 * This is a MONITORING concept, not a scheduling one: nothing here gates a poll. Deciding not to
 * poll during a vendor's maintenance would mean missing the moment it comes back early, and would
 * hide a real outage that happened to start inside the window. We keep polling exactly as before
 * and only change the VERDICT — see `lib/monitoring/device-staleness.ts`.
 */

import { fromDate } from "@internationalized/date";

export interface MaintenanceWindow {
  /**
   * The IANA zone the VENDOR runs its schedule in — not the device's `timezoneOffsetMin`, which is
   * a deliberately fixed offset for day bucketing and would sit an hour wrong for half the year.
   * A vendor keyed to a fixed offset should say so with a non-DST zone (`Australia/Brisbane`).
   *
   * ⚠️ A window in a zone that DOES observe DST has wall-clock semantics, with three consequences:
   * it fires twice on a fall-back day, not at all if it lands inside a spring-forward gap, and —
   * because `maintenanceWindowOpenForMs` subtracts wall-clock times — its reported "open for" can
   * jump backwards mid-window at a transition (Melbourne 01:55–03:35 on 5 Apr 2026 reports an hour
   * open at 15:55Z and five minutes open five real minutes later), which momentarily tightens the
   * age bound its caller derives from it and can alert on a legitimate maintenance outage. The
   * first two are
   * genuinely correct for a vendor that schedules by local wall clock; the third is a LIMITATION,
   * not a semantic — fixing it means resolving the window's opening instant, which is ambiguous on
   * a fall-back day. All three are reasons to prefer a fixed-offset zone (`Australia/Brisbane`,
   * `Etc/GMT-10`) when the evidence says the vendor is keyed to one, as Amber's does. No vendor
   * declares a DST-observing window today; the first that does must revisit this.
   */
  timezone: string;
  /** "HH:MM" in `timezone`. Inclusive. */
  start: string;
  /** "HH:MM" in `timezone`. Exclusive. May be earlier than `start`, meaning the window wraps midnight. */
  end: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** "HH:MM" → minutes since local midnight, or null if it isn't that. */
function parseHhMm(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * How long `window` has been open at `now`, in whole MILLISECONDS — or null if `now` is outside it.
 *
 * Callers want the elapsed time, not just a boolean: a vendor's window excuses a failure young
 * enough to have been caused by it, and says nothing about one that had been running long before
 * it opened. See `evaluateDeviceHealth`.
 *
 * 🛑 **Milliseconds, and integers, on purpose.** The caller subtracts this from a device's
 * staleness, and both quantities advance with the same clock — so their DIFFERENCE is the constant
 * "how long before the window opened was the last success", and the verdict is identical at every
 * instant inside the window. That invariant is fragile in two ways this signature protects
 * against: rounding either side independently makes the two values tick over at different moments,
 * and doing the arithmetic in fractional MINUTES loses it to floating-point error (15 vs
 * 15.000000000000014 one second apart). Either way a device sitting on the tolerance flips
 * 200/503/200 across a single minute — the monitor resolving and reopening an incident on nothing,
 * which is the exact failure mode this whole mechanism exists to remove.
 *
 * A window that does not parse returns null — the failure mode is "alert as usual", never "go quiet
 * on a typo". A declaration is a compile-time constant in an adapter, so a malformed one is a bug
 * for the tests to catch, not a reason to suppress an alarm in production. The `timezone` check is
 * a RUNTIME one on purpose: `fromDate` silently falls back to the process zone for a missing zone
 * rather than throwing, which would suppress at whatever time of day Vercel's clock happened to
 * agree with.
 */
export function maintenanceWindowOpenForMs(
  window: MaintenanceWindow,
  now: Date,
): number | null {
  const start = parseHhMm(window?.start);
  const end = parseHhMm(window?.end);
  if (start === null || end === null || start === end) return null;
  if (typeof window.timezone !== "string" || window.timezone.length === 0)
    return null;

  let local;
  try {
    local = fromDate(now, window.timezone);
  } catch {
    return null; // unknown zone — same principle as an unparseable time
  }
  const wholeMinutes = local.hour * 60 + local.minute;
  const msIntoDay =
    wholeMinutes * MS_PER_MINUTE + local.second * 1000 + local.millisecond;

  // Membership is judged on whole minutes, so "00:35" means all of 00:34 is still in and 00:35:00
  // is out; the sub-minute part only ever refines the ELAPSED count.
  const inside =
    start < end
      ? wholeMinutes >= start && wholeMinutes < end
      : wholeMinutes >= start || wholeMinutes < end; // wraps midnight
  if (!inside) return null;

  return (msIntoDay - start * MS_PER_MINUTE + MS_PER_DAY) % MS_PER_DAY;
}
