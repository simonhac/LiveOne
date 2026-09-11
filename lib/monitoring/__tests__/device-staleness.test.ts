/**
 * The per-device verdict that both the monitor cron and /api/health/devices read. The cases that
 * matter are the boundaries: a device inside its budget but failing every poll (the leading
 * indicator we didn't have on 2026-09-11), and a vendor whose declared budget overrides the
 * generic slot multiple (Amber's nightly maintenance window).
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const getAdapter = jest.fn();
jest.mock("@/lib/vendors/registry", () => ({
  VendorRegistry: {
    getAdapter: (v: string) => getAdapter(v),
  },
}));

import {
  evaluateDeviceHealth,
  unhealthy,
  DEVICE_FAILING_ERRORS,
} from "../device-staleness";

type Row = {
  rid: number;
  name: string;
  vendor: string;
  stale_min: string | null;
  consecutive_errors: number | null;
};

/** Minimal stand-in for the drizzle handle — the query is fixed, only the rows vary. */
const dbWith = (rows: Row[]) => ({ execute: async () => ({ rows }) }) as never;

const row = (over: Partial<Row> = {}): Row => ({
  rid: 1,
  name: "Test device",
  vendor: "selectronic",
  stale_min: "1",
  consecutive_errors: 0,
  ...over,
});

beforeEach(() => {
  getAdapter.mockReset();
  // default: a 1-minute poll vendor with no declared budget → budget = 3 min
  getAdapter.mockReturnValue({ dataSource: "poll", pollIntervalMinutes: 1 });
});

describe("evaluateDeviceHealth", () => {
  it("reports a healthy device as ok", async () => {
    const out = await evaluateDeviceHealth(dbWith([row()]));
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("ok");
    expect(unhealthy(out)).toHaveLength(0);
  });

  it("flags a device past 3x its slot as stale", async () => {
    const out = await evaluateDeviceHealth(dbWith([row({ stale_min: "4" })]));
    expect(out[0]).toMatchObject({ code: "device_poll_stale", budgetMin: 3 });
    expect(out[0].message).toMatch(/3× its 1 min slot \(3 min\)/);
  });

  it("honours a vendor's declared budget over the generic multiple", async () => {
    // Amber: 5-minute slot but a declared 45-minute budget for its nightly maintenance window.
    getAdapter.mockReturnValue({
      dataSource: "poll",
      pollIntervalMinutes: 5,
      staleBudgetMinutes: 45,
    });
    const ok = await evaluateDeviceHealth(
      dbWith([row({ vendor: "amber", stale_min: "30" })]),
    );
    expect(ok[0].code).toBe("ok"); // 30 min would be stale on 3x5, but not on its own budget
    const bad = await evaluateDeviceHealth(
      dbWith([row({ vendor: "amber", stale_min: "50" })]),
    );
    expect(bad[0].code).toBe("device_poll_stale");
    expect(bad[0].message).toMatch(/declared 45 min staleness budget/);
  });

  // The whole point of the leading indicator: a generous budget lets a device fail every poll for
  // a long time while still looking perfectly healthy to a staleness check.
  it("flags a device that is failing but not yet stale", async () => {
    getAdapter.mockReturnValue({
      dataSource: "poll",
      pollIntervalMinutes: 5,
      staleBudgetMinutes: 45,
    });
    const out = await evaluateDeviceHealth(
      dbWith([
        row({
          vendor: "amber",
          stale_min: "20",
          consecutive_errors: DEVICE_FAILING_ERRORS,
        }),
      ]),
    );
    expect(out[0].code).toBe("device_failing");
    expect(out[0].message).toMatch(/failed 5 polls in a row/);
    expect(out[0].message).toMatch(/still inside its 45 min budget/);
  });

  it("reports an already-stale device as stale, not twice", async () => {
    const out = await evaluateDeviceHealth(
      dbWith([row({ stale_min: "60", consecutive_errors: 99 })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("device_poll_stale");
  });

  it("does not flag a failure run below the threshold", async () => {
    const out = await evaluateDeviceHealth(
      dbWith([row({ consecutive_errors: DEVICE_FAILING_ERRORS - 1 })]),
    );
    expect(out[0].code).toBe("ok");
  });

  it("reports a device that has never succeeded", async () => {
    const out = await evaluateDeviceHealth(dbWith([row({ stale_min: null })]));
    expect(out[0]).toMatchObject({
      code: "device_never_polled",
      staleMin: null,
    });
  });

  // Push vendors have no schedule to be late against — their liveness is their own heartbeat's job.
  it("skips push vendors entirely", async () => {
    getAdapter.mockReturnValue({ dataSource: "push" });
    const out = await evaluateDeviceHealth(
      dbWith([row({ vendor: "deepsea", stale_min: "9999" })]),
    );
    expect(out).toHaveLength(0);
  });

  it("skips a vendor with no adapter", async () => {
    getAdapter.mockReturnValue(null);
    const out = await evaluateDeviceHealth(
      dbWith([row({ vendor: "helper", stale_min: "9999" })]),
    );
    expect(out).toHaveLength(0);
  });

  it("treats a null consecutive_errors as zero", async () => {
    const out = await evaluateDeviceHealth(
      dbWith([row({ consecutive_errors: null })]),
    );
    expect(out[0].consecutiveErrors).toBe(0);
    expect(out[0].code).toBe("ok");
  });
});
