/**
 * Enphase's eligibility gate — the daylight window and the overnight repair window.
 *
 * This logic was entirely untested before: it lived inside a 171-line `evaluateSchedule` override
 * that also re-implemented the cadence, and there was no `enphase/__tests__/` directory at all.
 * Reducing the adapter to a gate is what made it testable — the slot rule it used to carry is now
 * verified once for every vendor in `lib/vendors/__tests__/schedule.test.ts`.
 */
import { describe, expect, it } from "@jest/globals";
import { EnphaseAdapter } from "../adapter";
import type { DeviceConfigView } from "@/lib/registry/device-config";

class TestableEnphaseAdapter extends EnphaseAdapter {
  gate(device: DeviceConfigView, now: Date) {
    return this.isEligible(device, now);
  }
}
const adapter = new TestableEnphaseAdapter();

/** Melbourne, AEST (+10). Enphase's default when a device carries no location. */
const device = {
  id: 5,
  timezoneOffsetMin: 600,
  location: null,
  pollingStatus: null,
} as unknown as DeviceConfigView;

/** A local AEST wall-clock time on a mid-winter day, as the UTC instant it corresponds to. */
const localAest = (hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 6, 15, hh - 10, mm));

describe("EnphaseAdapter.isEligible", () => {
  it("allows polling in the middle of the day", async () => {
    expect(await adapter.gate(device, localAest(12))).toBe(true);
  });

  it("blocks polling in the dead of night, outside the repair window", async () => {
    const r = await adapter.gate(device, localAest(23, 30));
    expect(r).not.toBe(true);
    expect((r as { reason: string }).reason).toMatch(/after dusk/);
  });

  it("allows the overnight repair window (01:00-05:00 local)", async () => {
    for (const h of [1, 3, 5]) {
      expect(await adapter.gate(device, localAest(h, 30))).toBe(true);
    }
  });

  it("blocks the gap between the repair window and dawn", async () => {
    const r = await adapter.gate(device, localAest(6));
    expect(r).not.toBe(true);
    expect((r as { reason: string }).reason).toMatch(/before dawn/);
  });

  it("explains how long the wait is, so a skip is legible in the poll result", async () => {
    const r = await adapter.gate(device, localAest(6));
    expect((r as { reason: string }).reason).toMatch(/\d+m/);
  });

  it("uses the device's own location when it has one", async () => {
    // Perth is ~2700 km west, so in AEST terms its dawn is nearly 2 h later (08:49 vs 07:05 on this
    // date). At 07:30 AEST the Melbourne default is in daylight and a Perth device is not — the
    // whole point of reading `device.location` rather than assuming everyone is in Victoria.
    const perth = {
      ...device,
      location: { lat: -31.95, lon: 115.86 },
    } as unknown as DeviceConfigView;
    expect(await adapter.gate(device, localAest(7, 30))).toBe(true);
    expect(await adapter.gate(perth, localAest(7, 30))).not.toBe(true);
  });

  it("falls back to the default location when the stored one is malformed", async () => {
    const broken = {
      ...device,
      location: "not json",
    } as unknown as DeviceConfigView;
    // Same verdict as the default-location device rather than a throw.
    expect(await adapter.gate(broken, localAest(12))).toBe(true);
    expect(await adapter.gate(broken, localAest(23, 30))).not.toBe(true);
  });
});
