/**
 * ROUTE-level tests for `POST /api/v4/devices/{id}/import` — operator-supplied readings.
 *
 * 🛑 Two properties are load-bearing, and both are about the fact that NOTHING DOWNSTREAM CAN
 * SECOND-GUESS THIS WRITE. Every other writer has a source of truth it can be re-derived from; an
 * import's source of truth is a person and a file.
 *
 *   1. `quality` is required and allow-listed. The column would happily store `"estimate"`, which
 *      ranks 0 forever and reads as "provenance never recorded" — indistinguishable from data whose
 *      provenance genuinely was not. A typo here is permanent and silent.
 *   2. Points are authorised against the device in the PATH. Authorisation was granted over the
 *      device; a `pt_…` in the body is caller-supplied, and one belonging to another device would
 *      be a write into a system the caller may not hold. Refused for the WHOLE request, because a
 *      partial import leaves nobody able to say which half landed.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireDeviceAccess: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
// Tagged so the fake query builder can tell which table a SELECT is against.
jest.mock("@/lib/db/planetscale/schema", () => ({
  devices: { __table: "devices" },
  points: { __table: "points" },
  sessions: { __table: "sessions", numRows: "num_rows", id: "id" },
}));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: { insert5m: jest.fn(), read5m: jest.fn() },
}));

import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import { Point } from "@/lib/ids";
import { POST } from "../devices/[id]/import/route";

const mockAuth = jest.mocked(requireDeviceAccess);
const mockDb = jest.mocked(requirePlanetscaleDb);
const mockInsert = jest.mocked(ReadingsDao.insert5m);
const mockRead5m = jest.mocked(ReadingsDao.read5m);

const DEVICE_ID = "dv_01m22s95fteab8gr0w7wxwy4eh";
const DEVICE_UUID = "device-uuid";

/** Two real pt_ TypeIDs — the device's own, and one belonging to somewhere else. */
const POWER_PT = "pt_3ae6h0d8f2avvbadgq4t3ctsgq";
const ENERGY_PT = "pt_58s3drwwhdacg97vr2ce4s5qnj";
const FOREIGN_PT = "pt_7f3mdterw1bm781kx7dsn5jn5v";
/** A lifetime counter — `transform: 'd'`, the shape every Selectronic energy point has. */
const COUNTER_PT = "pt_79jhhnnh5pa8asvg1nkexcrd0c";

/** 2026-09-11T00:05:00Z — on a 5-minute boundary. */
const T0 = "2026-09-11T00:05:00.000Z";
const FIVE_MIN = 5 * 60 * 1000;
const at = (n: number) => new Date(Date.parse(T0) + n * FIVE_MIN).toISOString();

/** A session that exists and belongs to this device. */
const SESSION = "01a08f2e-9aa1-7917-a3bc-35663ac62736";

/** What the mocked sessions SELECT returns. Null models "no such session". */
let sessionRow: Record<string, unknown> | null;

/** What the mocked agg_5m read returns, keyed by point. */
let storedRows: Map<string, Array<Record<string, unknown>>>;

const stored = (over: Record<string, unknown> = {}) => ({
  intervalEndMs: Date.parse(T0),
  createdAtMs: 0,
  avg: 1,
  min: 1,
  max: 1,
  last: 1,
  delta: null,
  valueStr: null,
  sampleCount: 1,
  errorCount: 0,
  dataQuality: "good",
  sessionId: "someone-else",
  ...over,
});

/** Rows the mocked points SELECT returns: only the device's own two points. */
let ownPoints: Array<Record<string, unknown>>;

const post = (body: unknown, id = DEVICE_ID) =>
  POST(
    new NextRequest(`http://localhost/api/v4/devices/${id}/import`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as NextRequest,
    { params: Promise.resolve({ id }) },
  );

const reading = (point: string, value: unknown = 1, intervalEnd = T0) => ({
  point,
  intervalEnd,
  value,
});

/** The body every happy-path test starts from — quality and session are both mandatory now. */
const ok = (over: Record<string, unknown>) => ({
  quality: "good",
  sessionId: SESSION,
  ...over,
});

describe("POST /api/v4/devices/{id}/import", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ownPoints = [
      {
        id: Point.toUuid(POWER_PT as never),
        metricType: "power",
        transform: null,
        logicalPath: "load.rest-of-house",
        physicalPath: "load_w",
        unit: "W",
      },
      {
        id: Point.toUuid(ENERGY_PT as never),
        metricType: "energy",
        transform: null,
        logicalPath: "source.solar",
        physicalPath: "solar_interval_wh",
        unit: "Wh",
      },
      {
        id: Point.toUuid(COUNTER_PT as never),
        metricType: "energy",
        transform: "d",
        logicalPath: "load",
        physicalPath: "load_wh_total",
        unit: "Wh",
      },
    ];
    sessionRow = { id: SESSION, deviceRid: 13 };
    storedRows = new Map();
    mockDb.mockReturnValue({
      select: () => ({
        // Dispatch on the tagged table: three different SELECTs run in this handler and they
        // return different shapes.
        from: (t: { __table: string }) => ({
          where: (() => {
            const r: Record<string, unknown> = {
              limit: async () =>
                t.__table === "sessions"
                  ? sessionRow
                    ? [sessionRow]
                    : []
                  : [{ rid: 13, uuid: DEVICE_UUID }],
              then: (res: (v: unknown) => unknown) => res(ownPoints),
            };
            return r;
          }) as never,
        }),
      }),
      // The `num_rows` accounting write. Nothing asserts its value beyond it being attempted.
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as never);
    mockAuth.mockResolvedValue({ device: { id: 13 } } as never);
    mockInsert.mockResolvedValue({ written: 1 });
    mockRead5m.mockImplementation((async (points: string[]) => {
      const m = new Map<string, Array<Record<string, unknown>>>();
      for (const p of points) m.set(p, storedRows.get(p) ?? []);
      return m;
    }) as never);
  });

  describe("quality is required, and allow-listed", () => {
    it("refuses a body with no quality", async () => {
      const res = await post({
        sessionId: SESSION,
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/quality is required/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses a marker that is not in the vocabulary", async () => {
      // 🛑 THE test. `estimate` is a plausible typo for `estimated`; the column would take it.
      const res = await post({
        quality: "estimate",
        sessionId: SESSION,
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/unknown quality "estimate"/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("stamps the given marker on every row", async () => {
      const res = await post({
        quality: "interpolated",
        sessionId: SESSION,
        readings: [reading(POWER_PT), reading(ENERGY_PT)],
      });
      expect(res.status).toBe(200);
      const rows = mockInsert.mock.calls[0][0];
      expect(rows.every((r) => r.dataQuality === "interpolated")).toBe(true);
    });
  });

  describe("points are authorised against the device in the path", () => {
    it("refuses a point belonging to another device — for the whole request", async () => {
      const res = await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(POWER_PT), reading(FOREIGN_PT)],
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/not this device's points/);
      // Nothing partial: the valid row must not land either.
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("a single value is shaped to the point's metric type", () => {
    it("puts a power value in avg/min/max/last and leaves delta null", async () => {
      await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(POWER_PT, 387)],
      });
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        avg: 387,
        min: 387,
        max: 387,
        last: 387,
        delta: null,
      });
    });

    it("puts an interval-energy value in delta and leaves avg/last null", async () => {
      // The caller sends one `value`; which column it belongs in is a property of the POINT, so an
      // operator never has to know that energy lands somewhere different from power.
      await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(ENERGY_PT, 250)],
      });
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        delta: 250,
        avg: null,
        min: null,
        max: null,
        last: null,
      });
    });
  });

  describe("timestamps must address a real 5-minute interval", () => {
    it("refuses a timestamp off the 5-minute grid", async () => {
      const res = await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(POWER_PT, 1, "2026-09-11T00:07:00.000Z")],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not on a 5-minute boundary/);
    });

    it("refuses an unparseable timestamp", async () => {
      const res = await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(POWER_PT, 1, "yesterday")],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not a parseable timestamp/);
    });
  });

  describe("the write itself", () => {
    it("upserts, so re-importing a corrected file converges", async () => {
      await post({
        quality: "good",
        sessionId: SESSION,
        readings: [reading(POWER_PT)],
      });
      expect(mockInsert.mock.calls[0][1]).toEqual({ upsert: true });
    });

    it("writes nothing on a dry run, but still reports the plan", async () => {
      const res = await post({
        quality: "interpolated",
        sessionId: SESSION,
        readings: [reading(POWER_PT)],
        dryRun: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ dryRun: true, written: 0, rows: 1 });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses an interval other than 5m rather than silently writing one", async () => {
      const res = await post({
        interval: "1d",
        quality: "good",
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/import writes 5m only/);
    });
  });

  describe("the session is the provenance record, and it is mandatory", () => {
    // 🛑 Why this is not optional: `data_quality` grades CONFIDENCE, not provenance — that is the rule
    // `derive-power.ts` settled, and it is what lets a vendor's late-arriving sample be written
    // `good`. The other half of that rule is "which rows arrived this way is answerable from
    // `session_id`". Without a session, a `good` import is indistinguishable from a live measurement
    // forever, and `good` stops being a grade and becomes laundering.
    it("refuses a body with no sessionId", async () => {
      const res = await post({
        quality: "good",
        readings: [reading(POWER_PT)],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/sessionId is required/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses a session that does not exist", async () => {
      sessionRow = null;
      const res = await post(ok({ readings: [reading(POWER_PT)] }));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/no such session/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses a session belonging to another device", async () => {
      // `sessions.device_rid` is not nullable, so a foreign session would file this import under
      // someone else's provenance — the failure is quiet and permanent.
      sessionRow = { id: SESSION, deviceRid: 99 };
      const res = await post(ok({ readings: [reading(POWER_PT)] }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/belongs to device 99/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("stamps the session on every row", async () => {
      await post(ok({ readings: [reading(POWER_PT), reading(ENERGY_PT)] }));
      const rows = mockInsert.mock.calls[0][0];
      expect(rows.every((r) => r.sessionId === SESSION)).toBe(true);
    });
  });

  describe("interval_start vs interval_end", () => {
    // 🛑 A 5m row is keyed on the END, but `device history --format csv` and both vendor archives
    // stamp the START — and both land on 5-minute boundaries, so the wrong one validates cleanly and
    // shifts every row by one interval. Nothing downstream can detect that.
    it("refuses a row carrying neither stamp", async () => {
      const res = await post(ok({ readings: [{ point: POWER_PT, value: 1 }] }));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(
        /exactly one of intervalEnd or intervalStart/,
      );
    });

    it("refuses a row carrying both", async () => {
      const res = await post(
        ok({
          readings: [
            { point: POWER_PT, intervalEnd: T0, intervalStart: T0, value: 1 },
          ],
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(
        /exactly one of intervalEnd or intervalStart/,
      );
    });

    it("advances a start-stamped row by one interval", async () => {
      await post(
        ok({
          readings: [{ point: POWER_PT, intervalStart: T0, value: 1 }],
        }),
      );
      const [row] = mockInsert.mock.calls[0][0];
      expect(row.intervalEndMs).toBe(Date.parse(T0) + FIVE_MIN);
    });

    it("leaves an end-stamped row where it is", async () => {
      await post(ok({ readings: [reading(POWER_PT)] }));
      const [row] = mockInsert.mock.calls[0][0];
      expect(row.intervalEndMs).toBe(Date.parse(T0));
    });
  });

  describe("an import may not silently downgrade a measurement", () => {
    it("refuses when a row is graded worse than what is stored, and writes nothing", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: "good" })]);
      const res = await post(
        ok({ quality: "interpolated", readings: [reading(POWER_PT)] }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.downgraded).toBe(1);
      expect(body.downgradesOver).toEqual(["good"]);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("proceeds when asked to explicitly", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: "good" })]);
      const res = await post(
        ok({
          quality: "interpolated",
          overwriteMeasured: true,
          readings: [reading(POWER_PT)],
        }),
      );
      expect(res.status).toBe(200);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("allows an equal or better grade without asking", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: "interpolated" })]);
      const res = await post(
        ok({ quality: "good", readings: [reading(POWER_PT)] }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).replaced).toBe(1);
    });

    // 🛑 The case a rank comparison alone gets WRONG, and the one that actually matters here.
    // `recomputeAgg5mForIntervals` writes data_quality = NULL on every row it builds from raw, so
    // for fusher / mondo / selectronic — the devices an archive import is pointed at — EVERY stored
    // measurement ranks 0. Measured on the dev mirror: 207 rows over one hour of device 1, all NULL,
    // sample_count 4–6. Rank alone would rate each of them below an operator's guess.
    it("refuses to overwrite an UNMARKED row that has samples behind it", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: null, sampleCount: 5 })]);
      const res = await post(
        ok({ quality: "interpolated", readings: [reading(POWER_PT)] }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.overMeasured).toBe(1);
      expect(body.error).toMatch(/real samples behind it/);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses even when the operator claims a HIGHER grade", async () => {
      // `good` outranks null, so a rank test would wave this through. Being confident about a
      // number is not a licence to delete a measurement.
      storedRows.set(POWER_PT, [stored({ dataQuality: null, sampleCount: 5 })]);
      const res = await post(
        ok({ quality: "good", readings: [reading(POWER_PT)] }),
      );
      expect(res.status).toBe(409);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("treats an unmarked row with NO samples as an empty slot", async () => {
      // sample_count 0 is a genuinely empty aggregate — nothing is being destroyed.
      storedRows.set(POWER_PT, [stored({ dataQuality: null, sampleCount: 0 })]);
      const res = await post(ok({ readings: [reading(POWER_PT)] }));
      expect(res.status).toBe(200);
      expect((await res.json()).replaced).toBe(1);
    });

    it("proceeds over a measured row when asked explicitly", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: null, sampleCount: 5 })]);
      const res = await post(
        ok({ overwriteMeasured: true, readings: [reading(POWER_PT)] }),
      );
      expect(res.status).toBe(200);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("reports what would change, not what is in the file", async () => {
      storedRows.set(POWER_PT, [stored({ dataQuality: "good" })]);
      const res = await post(
        ok({
          readings: [reading(POWER_PT, 1, T0), reading(POWER_PT, 2, at(1))],
          dryRun: true,
        }),
      );
      const body = await res.json();
      // One interval already holds a row; the other does not. "2 rows" would hide that.
      expect(body).toMatchObject({ rows: 2, created: 1, replaced: 1 });
    });
  });

  describe("counter points get a delta, or the import writes no energy at all", () => {
    // 🛑 `recomputeAgg1dForDay` sums `agg_5m.delta`. For a transform:'d' point that delta is computed
    // only when a 5m row is built FROM RAW — which an import never is — so leaving it null would
    // report every row written and produce no daily energy, ever.
    it("differences against the stored previous interval", async () => {
      storedRows.set(COUNTER_PT, [
        stored({ intervalEndMs: Date.parse(T0) - FIVE_MIN, last: 1000 }),
      ]);
      await post(ok({ readings: [reading(COUNTER_PT, 1250)] }));
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({ last: 1250, delta: 250, avg: null });
    });

    it("chains within the batch", async () => {
      storedRows.set(COUNTER_PT, [
        stored({ intervalEndMs: Date.parse(T0) - FIVE_MIN, last: 1000 }),
      ]);
      await post(
        ok({
          readings: [
            reading(COUNTER_PT, 1250, T0),
            reading(COUNTER_PT, 1400, at(1)),
            reading(COUNTER_PT, 1500, at(2)),
          ],
        }),
      );
      const rows = mockInsert.mock.calls[0][0];
      expect(rows.map((r) => r.delta)).toEqual([250, 150, 100]);
    });

    it("chains in interval order regardless of the order the file listed", async () => {
      storedRows.set(COUNTER_PT, [
        stored({ intervalEndMs: Date.parse(T0) - FIVE_MIN, last: 1000 }),
      ]);
      await post(
        ok({
          readings: [
            reading(COUNTER_PT, 1500, at(2)),
            reading(COUNTER_PT, 1250, T0),
            reading(COUNTER_PT, 1400, at(1)),
          ],
        }),
      );
      const rows = mockInsert.mock.calls[0][0];
      expect(rows.map((r) => r.delta)).toEqual([250, 150, 100]);
    });

    it("leaves delta null rather than differencing across a hole", async () => {
      // No stored predecessor. A delta here would attribute the whole gap to one 5-minute interval.
      await post(ok({ readings: [reading(COUNTER_PT, 1250)] }));
      const [row] = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({ last: 1250, delta: null });
    });

    it("re-differences the first stored row AFTER the run", async () => {
      // That row's delta was computed when nothing preceded it, so it differences across the hole
      // this import just filled. The raw path solves the same problem with withSuccessorIntervals().
      storedRows.set(COUNTER_PT, [
        stored({ intervalEndMs: Date.parse(T0) - FIVE_MIN, last: 1000 }),
        stored({
          intervalEndMs: Date.parse(at(1)),
          last: 1400,
          delta: 400,
          dataQuality: "good",
          sessionId: "the-live-poll",
        }),
      ]);
      await post(ok({ readings: [reading(COUNTER_PT, 1250, T0)] }));
      const repairs = mockInsert.mock.calls[1][0];
      expect(repairs).toHaveLength(1);
      expect(repairs[0]).toMatchObject({
        intervalEndMs: Date.parse(at(1)),
        delta: 150,
        // Untouched: this write owns the value columns only.
        dataQuality: "good",
        sessionId: "the-live-poll",
      });
      expect(mockInsert.mock.calls[1][1]).toMatchObject({
        upsert: true,
        preserveVendorMeta: true,
      });
    });

    it("leaves the successor alone when its delta is already right", async () => {
      storedRows.set(COUNTER_PT, [
        stored({ intervalEndMs: Date.parse(at(1)), last: 1400, delta: 150 }),
      ]);
      await post(ok({ readings: [reading(COUNTER_PT, 1250, T0)] }));
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });
});
