/**
 * The per-device verdict that both the monitor cron and /api/health/devices read. The cases that
 * matter are the boundaries: a device inside its budget but failing every poll (the leading
 * indicator we didn't have on 2026-09-11), a vendor whose declared budget overrides the generic
 * slot multiple, and a vendor inside a maintenance window it told us about in advance.
 *
 * That last one is why `alertable()` exists and is tested here rather than at the route: between
 * 2026-09-11 and 2026-09-15 the failing check paged every single night for Amber's advertised
 * nightly window, because the two mechanisms were added a month apart and neither knew about the
 * other. The window cases below are what stops that being re-introduced.
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
  alertable,
  DEVICE_FAILING_ERRORS,
} from "../device-staleness";

/** Exactly what the query returns: bigint columns arrive from node-pg as strings. */
type Row = {
  rid: number;
  name: string;
  vendor: string;
  stale_ms: string | null;
  db_now_ms: string;
  consecutive_errors: number | null;
};

/** Minimal stand-in for the drizzle handle — the query is fixed, only the rows vary. */
const dbWith = (rows: Row[]) => ({ execute: async () => ({ rows }) }) as never;

/** Default evaluation instant: 15:00 Brisbane, i.e. nowhere near Amber's window. */
const DEFAULT_AT = new Date("2026-09-14T05:00:00Z");

interface RowSpec {
  rid?: number;
  vendor?: string;
  /** minutes since the last successful poll; null = never polled */
  staleMin?: number | null;
  /** the evaluation instant — the DB clock both columns are sampled on */
  at?: Date;
  errors?: number | null;
}

/**
 * Tests say "N minutes stale, evaluated at T"; the row carries the millisecond columns the
 * production query actually returns, both derived from the SAME instant exactly as the database
 * does it. See the clock note on `evaluateDeviceHealth` for why that matters.
 */
const row = (spec: RowSpec = {}): Row => ({
  rid: spec.rid ?? 1,
  name: "Test device",
  vendor: spec.vendor ?? "selectronic",
  stale_ms:
    spec.staleMin === null
      ? null
      : String(Math.round((spec.staleMin ?? 1) * 60_000)),
  db_now_ms: String((spec.at ?? DEFAULT_AT).getTime()),
  // `=== undefined`, not `??`: `errors: null` must reach production as null, which is what the
  // null-handling case below is for.
  consecutive_errors: spec.errors === undefined ? 0 : spec.errors,
});

const codeOf = async (...specs: RowSpec[]) =>
  (await evaluateDeviceHealth(dbWith(specs.map(row))))[0].code;

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
    const out = await evaluateDeviceHealth(dbWith([row({ staleMin: 4 })]));
    expect(out[0]).toMatchObject({ code: "device_poll_stale", budgetMin: 3 });
    expect(out[0].message).toMatch(/3× its 1 min slot \(3 min\)/);
  });

  it("honours a vendor's declared budget over the generic multiple", async () => {
    // A 5-minute slot with a declared 45-minute budget. No vendor declares one today — Amber did
    // until 2026-09-15, and now declares a maintenance window instead — but the lever is real.
    getAdapter.mockReturnValue({
      dataSource: "poll",
      pollIntervalMinutes: 5,
      staleBudgetMinutes: 45,
    });
    // 30 min would be stale on 3×5, but not on its own budget.
    expect(await codeOf({ vendor: "testvendor", staleMin: 30 })).toBe("ok");
    const bad = await evaluateDeviceHealth(
      dbWith([row({ vendor: "testvendor", staleMin: 50 })]),
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
          vendor: "testvendor",
          staleMin: 20,
          errors: DEVICE_FAILING_ERRORS,
        }),
      ]),
    );
    expect(out[0].code).toBe("device_failing");
    expect(out[0].message).toMatch(/failed 5 polls in a row/);
    expect(out[0].message).toMatch(/still inside its 45 min budget/);
  });

  it("reports an already-stale device as stale, not twice", async () => {
    const out = await evaluateDeviceHealth(
      dbWith([row({ staleMin: 60, errors: 99 })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("device_poll_stale");
  });

  it("does not flag a failure run below the threshold", async () => {
    expect(await codeOf({ errors: DEVICE_FAILING_ERRORS - 1 })).toBe("ok");
  });

  it("reports a device that has never succeeded", async () => {
    const out = await evaluateDeviceHealth(dbWith([row({ staleMin: null })]));
    expect(out[0]).toMatchObject({
      code: "device_never_polled",
      staleMin: null,
    });
  });

  // Push vendors have no schedule to be late against — their liveness is their own heartbeat's job.
  it("skips push vendors entirely", async () => {
    getAdapter.mockReturnValue({ dataSource: "push" });
    const out = await evaluateDeviceHealth(
      dbWith([row({ vendor: "deepsea", staleMin: 9999 })]),
    );
    expect(out).toHaveLength(0);
  });

  it("skips a vendor with no adapter", async () => {
    getAdapter.mockReturnValue(null);
    const out = await evaluateDeviceHealth(
      dbWith([row({ vendor: "helper", staleMin: 9999 })]),
    );
    expect(out).toHaveLength(0);
  });

  it("treats a null consecutive_errors as zero", async () => {
    const out = await evaluateDeviceHealth(dbWith([row({ errors: null })]));
    expect(out[0].consecutiveErrors).toBe(0);
    expect(out[0].code).toBe("ok");
  });

  it("keeps device_never_polled out of the alertable set", async () => {
    const out = await evaluateDeviceHealth(dbWith([row({ staleMin: null })]));
    expect(unhealthy(out)).toHaveLength(1);
    expect(alertable(out)).toHaveLength(0);
  });

  // ── Maintenance windows ─────────────────────────────────────────────────────────────────────
  //
  // A vendor that told us in advance it would be down is not news. It is still REPORTED — the body
  // carries the numbers — it just doesn't wake anyone. See lib/vendors/maintenance-window.ts.
  describe("a vendor inside its declared maintenance window", () => {
    // Amber's real shape: 5-minute slot, no declared budget (so the generic 15-minute cliff), and a
    // window at 00:05–00:35 UTC+10 — i.e. 14:05–14:35 UTC.
    const windowed = {
      dataSource: "poll",
      pollIntervalMinutes: 5,
      maintenanceWindow: {
        timezone: "Australia/Brisbane",
        start: "00:05",
        end: "00:35",
      },
    };
    const OPENS = new Date("2026-09-14T14:05:00Z");
    const inside = new Date("2026-09-14T14:20:00Z"); // open 15 min
    const outside = DEFAULT_AT;

    beforeEach(() => {
      getAdapter.mockReturnValue(windowed);
    });

    it("reports it, but does not alert", async () => {
      const out = await evaluateDeviceHealth(
        dbWith([
          row({
            vendor: "amber",
            staleMin: 16,
            errors: DEVICE_FAILING_ERRORS,
            at: inside,
          }),
        ]),
      );
      expect(out[0].code).toBe("device_in_maintenance");
      expect(out[0].consecutiveErrors).toBe(DEVICE_FAILING_ERRORS); // evidence survives
      expect(unhealthy(out)).toHaveLength(1); // still in the body
      expect(alertable(out)).toHaveLength(0); // but nothing pages
    });

    it("suppresses staleness inside the window too, not just failure", async () => {
      expect(await codeOf({ vendor: "amber", staleMin: 30, at: inside })).toBe(
        "device_in_maintenance",
      );
    });

    it("alerts on exactly the same device outside the window", async () => {
      const out = await evaluateDeviceHealth(
        dbWith([
          row({
            vendor: "amber",
            staleMin: 16,
            errors: DEVICE_FAILING_ERRORS,
            at: outside,
          }),
        ]),
      );
      // 16 min against the generic 3 × 5 min cliff — with the old 45-minute budget gone this is
      // already STALE at 3 pm, not merely failing. That tightening is the point of the trade.
      expect(out[0]).toMatchObject({
        code: "device_poll_stale",
        budgetMin: 15,
      });
      expect(alertable(out)).toHaveLength(1);
    });

    it("still reports the leading indicator outside the window", async () => {
      // inside 15 min, but visibly going under
      expect(
        await codeOf({
          vendor: "amber",
          staleMin: 10,
          errors: DEVICE_FAILING_ERRORS,
          at: outside,
        }),
      ).toBe("device_failing");
    });

    it("suppresses the leading indicator inside the window too", async () => {
      const out = await evaluateDeviceHealth(
        dbWith([
          row({
            vendor: "amber",
            staleMin: 10,
            errors: DEVICE_FAILING_ERRORS,
            at: inside,
          }),
        ]),
      );
      expect(out[0].code).toBe("device_in_maintenance");
      expect(alertable(out)).toHaveLength(0);
    });

    // 🛑 The case the window must NOT cover: Amber had already been dark for hours when the window
    // opened. Suppressing that would resolve and reopen a live incident for a recovery that never
    // happened. Same clock, same window — only the age of the failure differs.
    it("does not excuse a failure that was already running when the window opened", async () => {
      const out = await evaluateDeviceHealth(
        dbWith([
          row({ vendor: "amber", staleMin: 180, errors: 40, at: inside }),
        ]),
      );
      expect(out[0].code).toBe("device_poll_stale");
      expect(alertable(out)).toHaveLength(1);
    });

    // The tolerance for a failure that predates the window is exactly one budget — no more, and
    // deliberately no less (at one slot, a single late poll on an ordinary night re-creates the
    // nightly page this whole change exists to stop).
    it("tolerates at most one budget of pre-window failure", async () => {
      const at = new Date(OPENS.getTime() + 60_000); // open 1 min
      // last success at (window − 15): excused. At (window − 16): not.
      expect(await codeOf({ vendor: "amber", staleMin: 16, at })).toBe(
        "device_in_maintenance",
      );
      expect(await codeOf({ vendor: "amber", staleMin: 17, at })).toBe(
        "device_poll_stale",
      );
    });

    /**
     * A device near the tolerance must get the SAME verdict at every instant inside the window.
     * `staleMs - openForMs` is constant there — both advance with one clock — so this holds by
     * construction, but only while the arithmetic stays in integer milliseconds. Doing it in
     * fractional minutes reintroduced it as floating-point error (15 vs 15.000000000000014 one
     * second apart), and flooring the two sides independently reintroduced it as a tick-over
     * mismatch. Either way the monitor resolves and reopens an incident on nothing.
     *
     * The one-second and 500 ms samples are the point: whole and half minutes are exactly
     * representable and pass even when the arithmetic is wrong.
     */
    it("gives the same verdict at every instant inside the window", async () => {
      const offsetsMs = [0, 1_000, 30_000, 500, 61_000, 90_500];
      const verdicts = async (lastSuccessBeforeOpenMs: number) =>
        Promise.all(
          offsetsMs.map((off) =>
            codeOf({
              vendor: "amber",
              staleMin: (off + lastSuccessBeforeOpenMs) / 60_000,
              at: new Date(inside.getTime() + off),
            }),
          ),
        );

      const openFor = inside.getTime() - OPENS.getTime(); // 15 min of window already elapsed
      // Last success 15.0 min before the window opened — inside the tolerance.
      expect(await verdicts(openFor + 15 * 60_000)).toEqual(
        offsetsMs.map(() => "device_in_maintenance"),
      );
      // Half a minute older — outside it. Must alert at every instant, not alternate.
      expect(await verdicts(openFor + 15.5 * 60_000)).toEqual(
        offsetsMs.map(() => "device_poll_stale"),
      );
    });

    it("re-arms the moment the window closes", async () => {
      // The window closing is what re-arms the alarm — see the Amber adapter. At 00:40 a
      // still-dark Amber is 40 min stale against the generic 15-minute cliff.
      expect(
        await codeOf({
          vendor: "amber",
          staleMin: 40,
          errors: 8,
          at: new Date("2026-09-14T14:40:00Z"),
        }),
      ).toBe("device_poll_stale");
    });

    it("re-arms on the exact closing boundary", async () => {
      expect(
        await codeOf({
          vendor: "amber",
          staleMin: 30,
          at: new Date("2026-09-14T14:35:00Z"), // end is exclusive
        }),
      ).toBe("device_poll_stale");
    });

    it("still alerts on OTHER devices while one is in maintenance", async () => {
      getAdapter.mockImplementation((...args: unknown[]) =>
        args[0] === "amber"
          ? windowed
          : { dataSource: "poll", pollIntervalMinutes: 1 },
      );
      const out = await evaluateDeviceHealth(
        dbWith([
          row({ rid: 9, vendor: "amber", staleMin: 16, errors: 5, at: inside }),
          row({ rid: 1, vendor: "selectronic", staleMin: 99, at: inside }),
        ]),
      );
      expect(out.map((d) => d.code)).toEqual([
        "device_in_maintenance",
        "device_poll_stale",
      ]);
      expect(alertable(out)).toHaveLength(1); // the 503 still happens, for the right device
    });

    it("does not invent a verdict for a healthy device inside the window", async () => {
      expect(await codeOf({ vendor: "amber", staleMin: 2, at: inside })).toBe(
        "ok",
      );
    });
  });
});
