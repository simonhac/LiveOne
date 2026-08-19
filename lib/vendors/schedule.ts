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
 *    classing an all-null snapshot as a failure rather than an empty success.) The retry is
 *    **bounded** — see `RETRY_WINDOW_MINUTES`. Unbounded, this property is an amplifier: measured on
 *    prod, Amber's scheduled nightly vendor outage (00:05-00:30 AEST, 502s, 14 nights out of 14)
 *    turned 5 failed polls into 25, because every one of them retried every minute until its slot
 *    closed. The blip this property exists for is one tick long; a vendor that is deliberately down
 *    is not a blip, and re-asking it 5 times a slot changes nothing.
 *
 * 3. **Keyed on when the poll STARTED.** `device_state.last_success_time` used to be stamped at
 *    completion, so a poll starting 10:04:58 and finishing 10:05:02 recorded itself into the 10:05
 *    slot and suppressed it. The stamp is now the poll's start instant, which is also what
 *    `sessions.created_at` records — the two finally agree.
 *
 * Pure and clock-free: everything takes `nowMs` explicitly so it can be tested without fake timers.
 */

const MINUTE_MS = 60_000;

/**
 * How far into a slot a RETRY may still run, measured from the slot's opening (start + offset).
 *
 * Expressed as a window rather than an attempt counter on purpose: the cron is `* * * * *`, so it
 * offers at most one attempt per minute, and a 2-minute window therefore IS "at most 2 attempts"
 * — without persisting a per-slot counter, which is what keeps this function pure.
 */
export const RETRY_WINDOW_MINUTES = 2;

/**
 * Consecutive failed polls after which the retry window closes entirely (first attempt per slot
 * only) until something succeeds.
 *
 * At 2 attempts a slot this is ~3 consecutively failed slots — long enough that a vendor having a
 * bad couple of minutes still gets its retries, short enough that a vendor which is simply down
 * stops being asked twice for every slot of the outage. `device_state.consecutive_errors` is reset
 * to 0 by any successful poll (`lib/polling-utils.ts`), so recovery needs no timer.
 */
export const BREAKER_AFTER_ERRORS = 5;

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
  /**
   * Override the in-slot retry window (see {@link RETRY_WINDOW_MINUTES}).
   *
   * ⚠️ The obvious reason to widen it — "this vendor's slot is an hour, so one bad minute costs the
   * whole hour" — is wrong for the only vendor it describes. Enphase is capped at ~1000 calls a
   * MONTH (`lib/vendors/enphase/enphase-client.ts`) against a normal spend of ~18/day, so a single
   * unbounded hour of retries would burn 60 calls — 6% of the month — on a vendor that fails for
   * reasons a retry ladder cannot fix; and Enphase loses nothing anyway, because each poll fetches
   * an hour of 5-minute intervals and the overnight repair pass re-fetches yesterday once it has
   * settled. Widen this only for a vendor that is BOTH un-refetchable AND not quota-limited.
   */
  retryWindowMinutes?: number;
}

/**
 * Failure state the caller already holds, passed IN so this stays pure and clock-free.
 * `consecutiveErrors` is `device_state.consecutive_errors` verbatim.
 */
export interface SlotState {
  consecutiveErrors?: number;
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
 * @param state - failure state (see {@link SlotState}); omitted means "no failures on record"
 */
export function evaluateSlot(
  nowMs: number,
  lastSuccessMs: number | null,
  schedule: SlotSchedule,
  state?: SlotState,
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

  const intoSlotMs = nowMs - openMs;
  const breakerOpen = (state?.consecutiveErrors ?? 0) >= BREAKER_AFTER_ERRORS;

  if (lastSuccessMs === null) {
    // A device that has never succeeded has no recorded slot to close, so the retry above can never
    // engage and it polls EVERY minute, forever — 1440 calls a day at a vendor that isn't answering
    // (a dead credential, a de-registered site), and `device_never_polled` is only a `warn`, so
    // nothing pages while it happens. Against Enphase's ~1000 calls/MONTH that empties the quota in
    // under a day. The breaker applies here too; the in-slot window deliberately does not, because a
    // genuinely new device should keep asking until it gets its first reading.
    if (breakerOpen && intoSlotMs >= MINUTE_MS) {
      return {
        due: false,
        reason: `never polled — breaker open after ${state?.consecutiveErrors} consecutive failures`,
        slotStartMs,
        nextDueMs: slotStartMs + intervalMinutes * MINUTE_MS + offsetMs,
      };
    }
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

  // Distinguishing the first attempt from a retry is the signal that tells a capture outage apart
  // from a vendor that simply had nothing new — they look identical downstream otherwise.
  if (intoSlotMs < MINUTE_MS) {
    return { due: true, reason: "slot poll", slotStartMs, nextDueMs: nowMs };
  }

  // Retry, but only within the budget. The breaker (a vendor failing slot after slot) collapses the
  // window to the first attempt; a success zeroes `consecutive_errors` and restores it.
  const windowMs =
    (breakerOpen ? 1 : (schedule.retryWindowMinutes ?? RETRY_WINDOW_MINUTES)) *
    MINUTE_MS;
  if (intoSlotMs >= windowMs) {
    return {
      due: false,
      reason: breakerOpen
        ? `retry breaker open after ${state?.consecutiveErrors} consecutive failures — one attempt per slot`
        : "retry budget spent for this slot",
      slotStartMs,
      nextDueMs: slotStartMs + intervalMinutes * MINUTE_MS + offsetMs,
    };
  }

  return {
    due: true,
    reason: "retrying until slot recorded",
    slotStartMs,
    nextDueMs: nowMs,
  };
}
