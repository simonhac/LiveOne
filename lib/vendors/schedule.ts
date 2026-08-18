/**
 * The polling schedule — one rule for every polled vendor.
 *
 * A device's timeline is divided into fixed **slots** of `intervalMinutes`, anchored to the UTC
 * epoch (so a 5-minute slot starts at :00/:05/:10 …). A poll is due when the current slot has not
 * yet been recorded, and never before `slot start + offset`. That's the whole algorithm; the
 * minutely cron re-evaluates it each tick, which is what turns a dropped tick or a failed vendor
 * call into a retry seconds later rather than a lost cycle.
 *
 * Three properties are load-bearing, each of them a defect in the scheme this replaces:
 *
 * 1. **Never early.** The old rule fired at `now - lastPoll >= interval - toleranceSeconds`, so
 *    Amber (tolerance 60s) fired 12% of its polls at 4:00 elapsed — landing them back in the
 *    PREVIOUS 5-minute slot, whereupon the next poll slipped to compensate and the phase
 *    random-walked. Only 65% of Amber's polls landed on the 5-minute minute, against 86% for the
 *    one adapter that was already boundary-aligned. A slot model has no need for an early
 *    allowance, so `toleranceSeconds` is gone rather than carried over.
 *
 * 2. **Keyed on the last SUCCESS, not the last attempt.** A failed poll must not consume its slot,
 *    or a vendor blip costs a whole interval. (Sigenergy already depended on this and defends it by
 *    classing an all-null snapshot as a failure rather than an empty success.)
 *
 * 3. **Keyed on when the poll STARTED.** `device_state.last_success_time` used to be stamped at
 *    completion, so a poll starting 10:04:58 and finishing 10:05:02 recorded itself into the 10:05
 *    slot and suppressed it. The stamp is now the poll's start instant, which is also what
 *    `sessions.created_at` records — the two finally agree.
 *
 * Pure and clock-free: everything takes `nowMs` explicitly so it can be tested without fake timers.
 */

const MINUTE_MS = 60_000;

/** What a vendor declares. Anything beyond this is a gate, not a schedule. */
export interface SlotSchedule {
  /** Slot width in minutes. Must be > 0. */
  intervalMinutes: number;
  /**
   * Whole minutes into the slot before a poll may run. For vendors whose data is published AFTER
   * the interval it describes (NEM dispatch, and anything derived from it), polling at the slot
   * boundary samples the previous interval; the offset is that publication lag, measured — see
   * `scripts/utils/poll-cadence.ts`. Only ever DELAYS a poll within its slot; it can never advance
   * one into the previous slot.
   */
  offsetMinutes?: number;
}

export interface SlotDecision {
  due: boolean;
  reason: string;
  /** Start of the slot `nowMs` falls in. */
  slotStartMs: number;
  /** When the next poll could next become due — for display only; nothing sleeps on it. */
  nextDueMs: number;
}

/** Start of the slot containing `ms`, anchored to the UTC epoch. */
export function slotOf(ms: number, intervalMinutes: number): number {
  const slotMs = intervalMinutes * MINUTE_MS;
  return Math.floor(ms / slotMs) * slotMs;
}

/** Start of the slot after the one containing `ms`. */
export function nextSlotStart(ms: number, intervalMinutes: number): number {
  return slotOf(ms, intervalMinutes) + intervalMinutes * MINUTE_MS;
}

/**
 * Is a poll due now?
 *
 * @param lastSuccessMs - when the last SUCCESSFUL poll STARTED, or null if never
 */
export function evaluateSlot(
  nowMs: number,
  lastSuccessMs: number | null,
  schedule: SlotSchedule,
): SlotDecision {
  const { intervalMinutes } = schedule;
  if (!(intervalMinutes > 0)) {
    throw new Error(`intervalMinutes must be > 0 (got ${intervalMinutes})`);
  }
  const offsetMs = (schedule.offsetMinutes ?? 0) * MINUTE_MS;
  const slotStartMs = slotOf(nowMs, intervalMinutes);
  const openMs = slotStartMs + offsetMs;

  // Not yet at the offset: the vendor hasn't published this slot's data.
  if (nowMs < openMs) {
    return {
      due: false,
      reason: `awaiting +${schedule.offsetMinutes}m into the slot`,
      slotStartMs,
      nextDueMs: openMs,
    };
  }

  if (lastSuccessMs === null) {
    return { due: true, reason: "never polled", slotStartMs, nextDueMs: nowMs };
  }

  // A success anywhere in THIS slot closes it. Comparing slots (rather than `lastSuccessMs >=
  // slotStartMs`) is what makes the offset safe: a poll at slot+0 and a poll at slot+2 both close
  // the same slot, so raising an offset can never cause a double-poll.
  if (slotOf(lastSuccessMs, intervalMinutes) >= slotStartMs) {
    const next = slotStartMs + intervalMinutes * MINUTE_MS + offsetMs;
    return {
      due: false,
      reason: "recorded this slot",
      slotStartMs,
      nextDueMs: next,
    };
  }

  return {
    due: true,
    // Distinguishing the first attempt from a retry is the signal that tells a capture outage apart
    // from a vendor that simply had nothing new — they look identical downstream otherwise.
    reason:
      nowMs - openMs < MINUTE_MS ? "slot poll" : "retrying until slot recorded",
    slotStartMs,
    nextDueMs: nowMs,
  };
}
