/**
 * Collection health and delivery health became two separate questions when the push moved off the
 * tick path. This pins the seam between them.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { recordTick, recordDelivery, getTickState } from "../usher-state";
import { registry } from "../registry";
import type { ScheduledEntry, TickResult } from "../../core/run";

const entry = {
  source: { siteId: "sheephouse", name: "musher" },
} as unknown as ScheduledEntry;

const tick = (over: Partial<TickResult> = {}): TickResult => ({
  name: "musher",
  siteId: "sheephouse",
  count: 13,
  active: false,
  deliveryActive: false,
  at: "2026-09-11T04:00:00.000Z",
  ...over,
});

beforeEach(() => {
  registry.tickStates.clear();
});

describe("recordTick / recordDelivery", () => {
  it("a queued tick does not clobber the last delivery outcome", () => {
    recordTick(entry, tick({ delivered: true, queued: true }));
    recordDelivery("sheephouse", "transient", true);
    expect(getTickState("sheephouse")?.pushOk).toBe(false);

    // The next tick is queued too — it knows nothing about delivery, so it must leave it alone.
    // Taking r.pushOk (undefined) here would hide a failing receiver on every single tick.
    recordTick(entry, tick({ delivered: true, queued: true }));
    expect(getTickState("sheephouse")?.pushOk).toBe(false);
    expect(getTickState("sheephouse")?.lastPushError).toMatch(/spooled/);

    recordDelivery("sheephouse", "ok");
    expect(getTickState("sheephouse")?.pushOk).toBe(true);
    expect(getTickState("sheephouse")?.lastPushError).toBeUndefined();
  });

  it("still takes pushOk from the tick when the push was inline (--once)", () => {
    recordTick(entry, tick({ delivered: true, pushOk: true }));
    expect(getTickState("sheephouse")?.pushOk).toBe(true);
    recordTick(entry, tick({ delivered: true, pushOk: false }));
    expect(getTickState("sheephouse")?.pushOk).toBe(false);
  });

  it("counts consecutive READ failures, and delivery failures do not reset them", () => {
    recordTick(entry, tick({ count: null, error: "modbus dead" }));
    recordTick(entry, tick({ count: null, error: "modbus dead" }));
    expect(getTickState("sheephouse")?.consecutiveErrors).toBe(2);

    recordDelivery("sheephouse", "ok");
    expect(getTickState("sheephouse")?.consecutiveErrors).toBe(2);

    recordTick(entry, tick());
    expect(getTickState("sheephouse")?.consecutiveErrors).toBe(0);
  });

  it("ignores a delivery for a site that has never ticked", () => {
    expect(() => recordDelivery("nowhere", "ok")).not.toThrow();
    expect(getTickState("nowhere")).toBeUndefined();
  });
});
