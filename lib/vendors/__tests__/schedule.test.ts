/**
 * The polling slot rule — tested ONCE, for every vendor.
 *
 * Before this module each adapter re-implemented the same drift arithmetic (Enphase three times in
 * one method), so the rule had no single place to be verified and in practice never was. These are
 * the cases that used to live, partially, in `sigenergy/__tests__/schedule.test.ts` and
 * `tesla/__tests__/adapter.test.ts`.
 */
import { describe, expect, it } from "@jest/globals";
import { evaluateSlot, nextSlotStart, slotOf } from "../schedule";

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

  it("retries every tick until the slot is recorded", () => {
    for (const t of ["05:06:00", "05:07:00", "05:09:59"]) {
      const d = evaluateSlot(
        at(`2026-08-15T${t}Z`),
        at("2026-08-15T05:00:04Z"),
        every5,
      );
      expect(d.due).toBe(true);
      expect(d.reason).toBe("retrying until slot recorded");
    }
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
