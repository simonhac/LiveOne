/**
 * The polling slot rule — tested ONCE, for every vendor.
 *
 * Before this module each adapter re-implemented the same drift arithmetic (Enphase three times in
 * one method), so the rule had no single place to be verified and in practice never was. These are
 * the cases that used to live, partially, in `sigenergy/__tests__/schedule.test.ts` and
 * `tesla/__tests__/adapter.test.ts`.
 */
import { describe, expect, it } from "@jest/globals";
import {
  BREAKER_AFTER_ERRORS,
  evaluateSlot,
  nextSlotStart,
  slotOf,
} from "../schedule";

const at = (iso: string) => Date.parse(iso);

describe("slotOf / nextSlotStart", () => {
  it("anchors slots to the UTC epoch", () => {
    expect(slotOf(at("2026-08-15T05:07:31Z"), 5)).toBe(
      at("2026-08-15T05:05:00Z"),
    );
    expect(slotOf(at("2026-08-15T05:05:00Z"), 5)).toBe(
      at("2026-08-15T05:05:00Z"),
    );
    expect(slotOf(at("2026-08-15T05:07:31Z"), 60)).toBe(
      at("2026-08-15T05:00:00Z"),
    );
    expect(slotOf(at("2026-08-15T05:07:31Z"), 1)).toBe(
      at("2026-08-15T05:07:00Z"),
    );
  });

  it("always advances", () => {
    expect(nextSlotStart(at("2026-08-15T05:05:00Z"), 5)).toBe(
      at("2026-08-15T05:10:00Z"),
    );
  });
});

describe("evaluateSlot", () => {
  const every5 = { intervalMinutes: 5 };

  it("polls when the slot has not been recorded", () => {
    const d = evaluateSlot(
      at("2026-08-15T05:05:03Z"),
      at("2026-08-15T05:00:04Z"),
      every5,
    );
    expect(d.due).toBe(true);
    expect(d.reason).toBe("slot poll");
  });

  it("goes quiet once the slot is recorded", () => {
    const d = evaluateSlot(
      at("2026-08-15T05:06:10Z"),
      at("2026-08-15T05:05:04Z"),
      every5,
    );
    expect(d.due).toBe(false);
    expect(d.reason).toBe("recorded this slot");
    expect(d.nextDueMs).toBe(at("2026-08-15T05:10:00Z"));
  });

  it("retries within its budget until the slot is recorded", () => {
    const d = evaluateSlot(
      at("2026-08-15T05:06:00Z"),
      at("2026-08-15T05:00:04Z"),
      every5,
    );
    expect(d.due).toBe(true);
    expect(d.reason).toBe("retrying until slot recorded");
  });

  it("polls when never polled", () => {
    expect(evaluateSlot(at("2026-08-15T05:05:03Z"), null, every5).due).toBe(
      true,
    );
  });

  /**
   * The regression that motivated stamping the poll's START rather than its completion: a poll
   * beginning at 05:04:59 belongs to the 05:00 slot and must not silence 05:05.
   */
  it("a success at 05:04:59 does not suppress the 05:05 slot", () => {
    const d = evaluateSlot(
      at("2026-08-15T05:05:02Z"),
      at("2026-08-15T05:04:59Z"),
      every5,
    );
    expect(d.due).toBe(true);
  });

  /**
   * The defect that killed `toleranceSeconds`: under the old rule a poll 4:00 after the last one
   * fired, landing back in the slot it had already recorded.
   */
  it("never fires early — 4:00 after a poll in the same slot is not due", () => {
    const d = evaluateSlot(
      at("2026-08-15T05:04:00Z"),
      at("2026-08-15T05:00:00Z"),
      every5,
    );
    expect(d.due).toBe(false);
    expect(d.reason).toBe("recorded this slot");
  });

  describe("offset", () => {
    const offset2 = { intervalMinutes: 5, offsetMinutes: 2 };

    it("holds the poll until the offset, then releases it", () => {
      const early = evaluateSlot(
        at("2026-08-15T05:05:30Z"),
        at("2026-08-15T05:00:04Z"),
        offset2,
      );
      expect(early.due).toBe(false);
      expect(early.nextDueMs).toBe(at("2026-08-15T05:07:00Z"));

      const open = evaluateSlot(
        at("2026-08-15T05:07:10Z"),
        at("2026-08-15T05:00:04Z"),
        offset2,
      );
      expect(open.due).toBe(true);
      expect(open.reason).toBe("slot poll");
    });

    it("can only delay within a slot, never advance into the previous one", () => {
      // A poll that ran at slot+0 (before the offset was raised) still closes the slot.
      const d = evaluateSlot(
        at("2026-08-15T05:07:10Z"),
        at("2026-08-15T05:05:01Z"),
        offset2,
      );
      expect(d.due).toBe(false);
      expect(d.reason).toBe("recorded this slot");
    });
  });

  it("rejects a non-positive interval rather than dividing by zero", () => {
    expect(() =>
      evaluateSlot(Date.now(), null, { intervalMinutes: 0 }),
    ).toThrow(/intervalMinutes/);
  });

  it("works at 1-minute slots (the tightest device)", () => {
    const every1 = { intervalMinutes: 1 };
    expect(
      evaluateSlot(
        at("2026-08-15T05:06:03Z"),
        at("2026-08-15T05:05:02Z"),
        every1,
      ).due,
    ).toBe(true);
    expect(
      evaluateSlot(
        at("2026-08-15T05:06:40Z"),
        at("2026-08-15T05:06:02Z"),
        every1,
      ).due,
    ).toBe(false);
  });

  it("works at 60-minute slots (Enphase)", () => {
    const hourly = { intervalMinutes: 60 };
    expect(
      evaluateSlot(
        at("2026-08-15T06:00:30Z"),
        at("2026-08-15T05:02:00Z"),
        hourly,
      ).due,
    ).toBe(true);
    expect(
      evaluateSlot(
        at("2026-08-15T05:59:00Z"),
        at("2026-08-15T05:02:00Z"),
        hourly,
      ).due,
    ).toBe(false);
  });

  /** Tesla switches interval on charging state; the slot rule just takes the narrower slot. */
  it("honours a dynamic interval", () => {
    const idle = evaluateSlot(
      at("2026-08-15T05:02:00Z"),
      at("2026-08-15T05:00:10Z"),
      { intervalMinutes: 12 },
    );
    expect(idle.due).toBe(false);
    const charging = evaluateSlot(
      at("2026-08-15T05:02:00Z"),
      at("2026-08-15T05:00:10Z"),
      { intervalMinutes: 2 },
    );
    expect(charging.due).toBe(true);
  });

  /**
   * The retry budget. Property #2 (a failure must not consume its slot) is what makes a vendor blip
   * cheap; unbounded, it is also what makes a vendor OUTAGE expensive. These pin the bound.
   */
  describe("retry budget", () => {
    const lastSuccess = at("2026-08-15T05:00:04Z");

    it("allows the first attempt and one retry, then stops for the slot", () => {
      const due = ["05:05:33", "05:06:33"].map(
        (t) => evaluateSlot(at(`2026-08-15T${t}Z`), lastSuccess, every5).due,
      );
      const notDue = ["05:07:33", "05:08:33", "05:09:33"].map(
        (t) => evaluateSlot(at(`2026-08-15T${t}Z`), lastSuccess, every5).due,
      );
      expect(due).toEqual([true, true]);
      expect(notDue).toEqual([false, false, false]);
    });

    it("points nextDueMs at the next slot once the budget is spent", () => {
      const d = evaluateSlot(at("2026-08-15T05:08:00Z"), lastSuccess, every5);
      expect(d.due).toBe(false);
      expect(d.reason).toBe("retry budget spent for this slot");
      expect(d.nextDueMs).toBe(at("2026-08-15T05:10:00Z"));
    });

    it("measures the window from the OFFSET, not the slot start", () => {
      const offset2 = { intervalMinutes: 5, offsetMinutes: 2 };
      // Opens at 05:07. The retry at 05:08 is still inside the budget…
      expect(
        evaluateSlot(at("2026-08-15T05:08:10Z"), lastSuccess, offset2).due,
      ).toBe(true);
      // …but 05:09 is not, and the next chance is the next slot's offset.
      const spent = evaluateSlot(
        at("2026-08-15T05:09:10Z"),
        lastSuccess,
        offset2,
      );
      expect(spent.due).toBe(false);
      expect(spent.nextDueMs).toBe(at("2026-08-15T05:12:00Z"));
    });

    it("closes the window to one attempt once the breaker trips", () => {
      const tripped = { consecutiveErrors: BREAKER_AFTER_ERRORS };
      expect(
        evaluateSlot(at("2026-08-15T05:05:33Z"), lastSuccess, every5, tripped)
          .due,
      ).toBe(true);
      const d = evaluateSlot(
        at("2026-08-15T05:06:33Z"),
        lastSuccess,
        every5,
        tripped,
      );
      expect(d.due).toBe(false);
      expect(d.reason).toMatch(/breaker open/);
    });

    /**
     * A device that has never succeeded closes no slot, so the retry budget above never engages and
     * it polls every minute forever. `device_never_polled` is only a `warn`, so nothing pages while
     * a dead credential spends 1440 calls a day.
     */
    describe("a device that has never succeeded", () => {
      it("keeps asking while the failures are few — it has no reading yet", () => {
        for (const t of ["05:05:33", "05:06:33", "05:09:33"]) {
          expect(
            evaluateSlot(at(`2026-08-15T${t}Z`), null, every5, {
              consecutiveErrors: 4,
            }).due,
          ).toBe(true);
        }
      });

      it("drops to one attempt per slot once the breaker trips", () => {
        const tripped = { consecutiveErrors: BREAKER_AFTER_ERRORS };
        expect(
          evaluateSlot(at("2026-08-15T05:05:33Z"), null, every5, tripped).due,
        ).toBe(true);
        const d = evaluateSlot(
          at("2026-08-15T05:06:33Z"),
          null,
          every5,
          tripped,
        );
        expect(d.due).toBe(false);
        expect(d.reason).toMatch(/never polled — breaker open/);
        expect(d.nextDueMs).toBe(at("2026-08-15T05:10:00Z"));
      });

      it("still polls a brand-new device immediately", () => {
        expect(evaluateSlot(at("2026-08-15T05:05:33Z"), null, every5).due).toBe(
          true,
        );
      });
    });

    it("restores the full window as soon as something succeeds", () => {
      // `consecutive_errors` is zeroed by any successful poll, so recovery needs no timer.
      expect(
        evaluateSlot(at("2026-08-15T05:06:33Z"), lastSuccess, every5, {
          consecutiveErrors: 0,
        }).due,
      ).toBe(true);
    });

    it("leaves a 1-minute slot alone — it rolls over before the window closes", () => {
      const every1 = { intervalMinutes: 1 };
      for (const t of ["05:05:33", "05:06:33", "05:07:33"]) {
        expect(
          evaluateSlot(
            at(`2026-08-15T${t}Z`),
            at("2026-08-15T05:04:33Z"),
            every1,
          ).due,
        ).toBe(true);
      }
    });

    // The knob exists; see `SlotSchedule.retryWindowMinutes` for why "its slot is an hour" is not a
    // reason to reach for it. No vendor overrides it today.
    it("honours a widened window", () => {
      const wide = { intervalMinutes: 60, retryWindowMinutes: 10 };
      const hourly = at("2026-08-15T05:00:04Z");
      expect(evaluateSlot(at("2026-08-15T06:09:00Z"), hourly, wide).due).toBe(
        true,
      );
      expect(evaluateSlot(at("2026-08-15T06:11:00Z"), hourly, wide).due).toBe(
        false,
      );
    });

    /**
     * The measurement this whole change exists for. Amber (device 9) has a scheduled nightly vendor
     * outage 00:05-00:30 AEST; prod recorded 25 consecutive failed polls on 2026-08-18 14:05-14:29
     * UTC, one per minute, none of which could ever have succeeded.
     */
    describe("Amber's nightly vendor outage (prod, 2026-08-18)", () => {
      /** Replay the `* * * * *` cron across the outage, at the ~:33s phase prod actually polls on. */
      const replay = (
        schedule: { intervalMinutes: number; retryWindowMinutes?: number },
        withBreaker = true,
      ) => {
        const downFrom = at("2026-08-15T14:05:00Z");
        const downUntil = at("2026-08-15T14:30:00Z");
        let lastSuccessMs = at("2026-08-15T13:55:33Z");
        let consecutiveErrors = 0;
        let attempts = 0;

        for (let m = 0; m <= 35; m++) {
          const nowMs = at("2026-08-15T14:00:33Z") + m * 60_000;
          const state = withBreaker ? { consecutiveErrors } : undefined;
          if (!evaluateSlot(nowMs, lastSuccessMs, schedule, state).due)
            continue;
          const up = nowMs < downFrom || nowMs >= downUntil;
          if (nowMs >= downFrom && nowMs < downUntil) attempts++;
          if (up) {
            lastSuccessMs = nowMs;
            consecutiveErrors = 0;
          } else {
            consecutiveErrors++;
          }
        }
        return attempts;
      };

      it("reproduces the 25 wasted polls with no budget and no breaker", () => {
        // What shipped in #376: retry until the slot closes (a window as wide as the slot), and
        // nothing watching the failure count. This is the prod trace, exactly.
        expect(
          replay({ intervalMinutes: 5, retryWindowMinutes: 5 }, false),
        ).toBe(25);
      });

      it("costs 7 polls under the budget + breaker", () => {
        // 2 attempts each for the 14:05 and 14:10 slots, then the breaker trips at 5 consecutive
        // failures and 14:15/14:20/14:25 get one apiece.
        expect(replay({ intervalMinutes: 5 })).toBe(7);
      });
    });
  });

  it("counts elapsed time in whole slots, not in gaps — a long outage recovers immediately", () => {
    const d = evaluateSlot(
      at("2026-08-15T09:00:10Z"),
      at("2026-08-15T05:00:00Z"),
      every5,
    );
    expect(d.due).toBe(true);
    expect(d.slotStartMs).toBe(at("2026-08-15T09:00:00Z"));
  });
});
