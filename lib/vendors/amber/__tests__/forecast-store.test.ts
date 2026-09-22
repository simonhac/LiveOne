/**
 * The in-force pick itself runs in Postgres (`DISTINCT ON … observed_at <= cutoff ORDER BY
 * observed_at DESC`), so these tests pin the SQL that expresses it and the mapping of what comes
 * back. The pure twin of the same rule, `forecastInForceAt`/`cutoffMsFor`, is covered in
 * `forecast-accuracy.test.ts`.
 */
import { describe, expect, it } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  InForceTooLarge,
  readAsOf,
  readCaptureHealth,
  readInForce,
} from "../forecast-store";

const dialect = new PgDialect();

/** An executor that answers each query from a list, in order, and records the rendered SQL. */
function fakeExec(answers: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  return {
    queries,
    exec: {
      execute: async (q: SQL) => {
        const rendered = dialect.sqlToQuery(q);
        queries.push({
          sql: rendered.sql.replace(/\s+/g, " "),
          params: rendered.params,
        });
        return { rows: answers[i++] ?? [] };
      },
    },
  };
}

const T = (iso: string) => String(Date.parse(iso));

describe("readInForce", () => {
  const window = {
    deviceRid: 9,
    channel: "general",
    fromMs: Date.parse("2026-08-31T14:00:00Z"),
    toMs: Date.parse("2026-09-01T14:00:00Z"),
  };

  it("picks the latest revision at or before interval_end − lead (anchor end)", async () => {
    const { exec, queries } = fakeExec([
      [{ interval_end_ms: T("2026-09-01T04:00:00Z") }],
      [
        {
          interval_end_ms: T("2026-09-01T04:00:00Z"),
          observed_at_ms: T("2026-09-01T02:55:02Z"),
          duration_min: 30,
          per_kwh: 21.5,
          adv_low: 18,
          adv_predicted: "20.1",
          adv_high: 30,
          descriptor: "neutral",
          spike_status: "none",
          interval_type: "f",
        },
      ],
    ]);
    const out = await readInForce(
      { ...window, leads: [1], anchor: "end" },
      exec,
    );

    const q = queries[1];
    expect(q.sql).toContain("SELECT DISTINCT ON (interval_end)");
    expect(q.sql).toContain("ORDER BY interval_end, observed_at DESC");
    expect(q.sql).toMatch(
      /observed_at <= interval_end - interval '0' - \$\d+ \* interval '1 hour'/,
    );
    expect(q.params).toContain(1);
    expect(q.params).toContain("2026-08-31 14:00:00.000");

    expect(out).toEqual({
      channel: "general",
      captured: ["2026-09-01T04:00:00.000Z"],
      leads: [
        {
          lead: 1,
          rows: [
            {
              intervalEnd: "2026-09-01T04:00:00.000Z",
              observedAt: "2026-09-01T02:55:02.000Z",
              durationMin: 30,
              perKwh: 21.5,
              advLow: 18,
              advPredicted: 20.1,
              advHigh: 30,
              descriptor: "neutral",
              spikeStatus: "none",
              intervalType: "f",
            },
          ],
        },
      ],
    });
  });

  it("anchor=start shifts the cutoff back by each row's own duration_min", async () => {
    const { exec, queries } = fakeExec([[], []]);
    await readInForce({ ...window, leads: [6], anchor: "start" }, exec);
    expect(queries[1].sql).toMatch(
      /observed_at <= interval_end - duration_min \* interval '1 minute' - \$\d+ \* interval '1 hour'/,
    );
    expect(queries[1].params).toContain(6);
  });

  it("refuses before the lead scans when captured × leads exceeds maxRows", async () => {
    const captured = Array.from({ length: 10 }, (_, i) => ({
      interval_end_ms: String(i),
    }));
    const { exec, queries } = fakeExec([captured]);
    await expect(
      readInForce(
        { ...window, leads: [1, 2, 3], anchor: "end", maxRows: 29 },
        exec,
      ),
    ).rejects.toBeInstanceOf(InForceTooLarge);
    expect(queries).toHaveLength(1);
  });

  it("makes one round trip per lead, after the captured set", async () => {
    const { exec, queries } = fakeExec([[], [], [], []]);
    const out = await readInForce(
      { ...window, leads: [1, 2, 6], anchor: "end" },
      exec,
    );
    expect(queries).toHaveLength(4);
    expect(out.leads.map((l) => l.lead)).toEqual([1, 2, 6]);
  });
});

describe("readAsOf", () => {
  it("reconstructs the step function at `at` across every channel, incl. site", async () => {
    const { exec, queries } = fakeExec([
      [
        {
          channel: "site",
          interval_end_ms: T("2026-09-01T01:00:00Z"),
          observed_at_ms: T("2026-09-01T00:00:00Z"),
          duration_min: 30,
          per_kwh: null,
          adv_low: null,
          adv_predicted: null,
          adv_high: null,
          descriptor: null,
          spike_status: null,
          interval_type: "f",
          spot_per_kwh: 8.2,
          renewables: 41,
        },
      ],
    ]);
    const rows = await readAsOf(
      {
        deviceRid: 9,
        atMs: Date.parse("2026-09-01T00:00:00Z"),
        horizonHours: 2,
      },
      exec,
    );
    expect(queries[0].sql).toContain("DISTINCT ON (channel, interval_end)");
    expect(queries[0].params).toEqual(
      expect.arrayContaining([
        "2026-09-01 00:00:00.000",
        "2026-09-01 02:00:00.000",
      ]),
    );
    expect(rows[0]).toMatchObject({
      channel: "site",
      spotPerKwh: 8.2,
      renewables: 41,
      perKwh: null,
    });
  });
});

describe("readCaptureHealth", () => {
  const opts = {
    deviceRid: 9,
    fromMs: Date.parse("2026-09-01T00:00:00Z"),
    toMs: Date.parse("2026-09-02T00:00:00Z"),
    nowMs: Date.parse("2026-09-02T00:10:00Z"),
  };

  it("stops after the overview when nothing was captured", async () => {
    const { exec, queries } = fakeExec([[{ rows: "0" }]]);
    const h = await readCaptureHealth(opts, exec);
    expect(queries).toHaveLength(1);
    expect(h.rows).toBe(0);
    expect(h.gaps).toEqual([]);
  });

  it("attributes each gap: no poll → cron-missed, a failure → failed, else sub-threshold", async () => {
    const gap = (polls: number, failed: number) => ({
      prev_ms: T("2026-09-01T01:00:00Z"),
      next_ms: T("2026-09-01T01:20:00Z"),
      gap_min: "20",
      polls_inside: String(polls),
      failed_inside: String(failed),
      reason: failed ? "502 Bad Gateway" : null,
    });
    const { exec } = fakeExec([
      [
        {
          rows: "1000",
          polls: "280",
          first_obs_ms: T("2026-09-01T00:00:00Z"),
          last_obs_ms: T("2026-09-02T00:00:00Z"),
          min_target_ms: T("2026-09-01T00:30:00Z"),
          max_target_ms: T("2026-09-03T14:00:00Z"),
        },
      ],
      [{ polls: "287", failed: "5", top_error: "502 Bad Gateway" }],
      [{ min_h: "14.2", max_h: "36.1" }],
      [gap(0, 0), gap(3, 2), gap(4, 0)],
      [
        {
          channel: "general",
          interval_type: "f",
          n: "900",
          targets: "96",
          with_price: "900",
          with_band: "880",
        },
      ],
    ]);
    const h = await readCaptureHealth(opts, exec);
    expect(h).toMatchObject({
      rows: 1000,
      captures: 280,
      polls: 287,
      failedPolls: 5,
      topError: "502 Bad Gateway",
      newestAgeMin: 10,
      horizonMinHours: 14.2,
      horizonMaxHours: 36.1,
    });
    expect(h.gaps.map((g) => g.verdict)).toEqual([
      "cron-missed",
      "failed",
      "sub-threshold",
    ]);
    expect(h.breakdown).toEqual([
      {
        channel: "general",
        intervalType: "f",
        rows: 900,
        targets: 96,
        withPrice: 900,
        withBand: 880,
      },
    ]);
  });
});
