/**
 * The server-side gate on a re-bucket's offset.
 *
 * This is the last check before a delete-and-rebuild of a device's entire daily history, and it runs
 * on a value that arrives over the wire. The CLI validates the same rule, but the CLI is not the only
 * caller the route has to survive.
 */
import { describe, it, expect } from "@jest/globals";
import { isValidDayOffsetMin } from "../change-day-offset";

describe("isValidDayOffsetMin", () => {
  it.each([600, 660, 570, 0, -300, 840, -840, 345])(
    "accepts %i — a real fixed offset",
    (n) => {
      expect(isValidDayOffsetMin(n)).toBe(true);
    },
  );

  it.each([
    [841, "past +14h"],
    [-841, "past -14h"],
    [607, "not a quarter hour"],
    [600.5, "not whole minutes"],
    [NaN, "NaN"],
    [Infinity, "infinite"],
  ])("rejects %s (%s)", (n) => {
    expect(isValidDayOffsetMin(n)).toBe(false);
  });

  it.each([["600"], [null], [undefined], [{}], [[600]], [true]])(
    "rejects the non-number %p, rather than coercing it",
    (v) => {
      // 🛑 A coerced "600" would be indistinguishable from a deliberate one, and this value decides
      // which day every reading on the device lands in.
      expect(isValidDayOffsetMin(v)).toBe(false);
    },
  );

  it("accepts Nepal's +5:45, so the rule is 15 minutes and not 30", () => {
    expect(isValidDayOffsetMin(345)).toBe(true);
  });
});
