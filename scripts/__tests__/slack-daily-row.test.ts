import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dailyHeader,
  dailyLabel,
  dateKeyFor,
  formatDuration,
  renderDailyText,
  type DailySyncState,
} from "../utils/slack-daily-row";
import { describeRun } from "../utils/report-sync-run-to-slack";

// Table cases live in a fixture so the exact rendered strings (glyphs, "  ·  " joins, link syntax)
// are reviewable as data. Every case is PAST-dated, so all 12 buckets are "due" and the output is
// independent of the clock — same trick the-gitfather's slack-render fixtures use.
const cases = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/sync-daily-render-cases.json"),
    "utf8",
  ),
) as { name: string; state: DailySyncState; expected: string }[];

// 2026-08-18 12:00 Sydney (AEST = UTC+10).
const NOON_SYDNEY = new Date(Date.UTC(2026, 7, 18, 2, 0, 0));

describe("sync daily row renderer", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(renderDailyText(c.state, NOON_SYDNEY)).toBe(c.expected);
  });

  it("only shows ⬜ for elapsed buckets, with a +1h grace", () => {
    // 05:30 Sydney → due buckets need 2*slot + 1 <= 5, i.e. slots 0,1,2 (00/02/04). The 06:00
    // bucket has only just opened, so a run that is merely late is not yet called missing.
    const now = new Date(Date.UTC(2026, 7, 18, 19, 30, 0)); // 2026-08-19 05:30 Sydney
    const state: DailySyncState = {
      channel: "C1",
      ts: "T",
      date: "2026-08-19",
      header: "*H*",
      entries: [],
    };
    expect(renderDailyText(state, now)).toBe(
      "*H*\n⬜ 00:00  ·  ⬜ 02:00  ·  ⬜ 04:00",
    );
  });

  it("suppresses a bucket's ⬜ once any run in it has ticked", () => {
    const now = new Date(Date.UTC(2026, 7, 18, 19, 30, 0)); // 05:30 Sydney
    const state: DailySyncState = {
      channel: "C1",
      ts: "T",
      date: "2026-08-19",
      header: "*H*",
      entries: [{ label: "02:20", status: "ok", detail: "58s" }],
    };
    expect(renderDailyText(state, now)).toBe(
      "*H*\n⬜ 00:00  ·  ✅ 02:20 (58s)  ·  ⬜ 04:00",
    );
  });

  it("renders an unlinked label when the entry has no url", () => {
    const state: DailySyncState = {
      channel: "C1",
      ts: "T",
      date: "2026-08-19",
      header: "*H*",
      entries: [{ label: "00:20", status: "fail", detail: "12s, timed out" }],
    };
    const now = new Date(Date.UTC(2026, 7, 18, 15, 30, 0)); // 01:30 Sydney
    expect(renderDailyText(state, now)).toBe("*H*\n❌ 00:20 (12s, timed out)");
  });
});

describe("time formatting in DISPLAY_TZ (Australia/Sydney)", () => {
  it.each([
    [0, "0s"],
    [58, "58s"],
    [59, "59s"],
    [60, "1m 00s"],
    [81, "1m 21s"],
    [333, "5m 33s"],
    [900, "15m 00s"],
  ])("formatDuration(%i) → %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("labels and dates a run in Sydney time, not UTC", () => {
    // 2026-08-17 22:20 UTC is already 2026-08-18 08:20 in Sydney — the row must be the Sydney day.
    const now = new Date(Date.UTC(2026, 7, 17, 22, 20, 0));
    expect(dailyLabel(now)).toBe("08:20");
    expect(dateKeyFor(now)).toBe("2026-08-18");
  });

  it("rolls the day over on the Sydney boundary", () => {
    const beforeMidnight = new Date(Date.UTC(2026, 7, 17, 13, 59, 0)); // 23:59 Sydney
    const afterMidnight = new Date(Date.UTC(2026, 7, 17, 14, 1, 0)); // 00:01 Sydney next day
    expect(dateKeyFor(beforeMidnight)).toBe("2026-08-17");
    expect(dailyLabel(beforeMidnight)).toBe("23:59");
    expect(dateKeyFor(afterMidnight)).toBe("2026-08-18");
    expect(dailyLabel(afterMidnight)).toBe("00:01");
  });

  it("names the day and the offset in force (AEST in winter, AEDT in summer)", () => {
    expect(dailyHeader(NOON_SYDNEY)).toBe(
      "*sync prod→dev — Tue 18 Aug 2026 (AEST)*",
    );
    // 2026-01-13 12:00 Sydney — daylight saving.
    expect(dailyHeader(new Date(Date.UTC(2026, 0, 13, 1, 0, 0)))).toBe(
      "*sync prod→dev — Tue 13 Jan 2026 (AEDT)*",
    );
  });
});

describe("describeRun folds the workflow env into one tick", () => {
  // SYNC_START is stamped in epoch seconds by the workflow; `now` closes the interval.
  const now = new Date(Date.UTC(2026, 7, 18, 2, 0, 0)); // 12:00 Sydney
  const startedSecondsAgo = (n: number): string =>
    String(Math.floor(now.getTime() / 1000) - n);
  const URL = "https://github.com/o/r/actions/runs/1/job/2";

  it("a clean run is a ✅ tick with just the duration", () => {
    const { entry, alert } = describeRun(now, URL, {
      JOB_STATUS: "success",
      SYNC_START: startedSecondsAgo(81),
      GITHUB_EVENT_NAME: "schedule",
    });
    expect(entry).toMatchObject({
      label: "12:00",
      status: "ok",
      detail: "1m 21s",
      url: URL,
      manual: false,
    });
    expect(alert).toBe("");
  });

  it("recovered connection dropouts turn the tick ⚠️ instead of posting their own message", () => {
    const { entry, alert } = describeRun(now, URL, {
      JOB_STATUS: "success",
      SYNC_START: startedSecondsAgo(81),
      SYNC_CONNECTION_DROPOUT_COUNT: "2",
      SYNC_CONNECTION_DROPOUT_STAGES: "prod→dev DB sync (2)",
    });
    expect(entry.status).toBe("warn");
    expect(entry.detail).toBe("1m 21s, 2 recovered");
    expect(alert).toBe("");
  });

  it("over the 5-min target is ⚠️, and stacks with recovered dropouts", () => {
    expect(
      describeRun(now, URL, {
        JOB_STATUS: "success",
        SYNC_START: startedSecondsAgo(400),
      }).entry,
    ).toMatchObject({ status: "warn", detail: "6m 40s, over target" });
    expect(
      describeRun(now, URL, {
        JOB_STATUS: "success",
        SYNC_START: startedSecondsAgo(400),
        SYNC_CONNECTION_DROPOUT_COUNT: "1",
      }).entry.detail,
    ).toBe("6m 40s, 1 recovered, over target");
  });

  it("a failure is ❌ with the classified stage, plus a loud alert to thread", () => {
    const { entry, alert } = describeRun(now, URL, {
      JOB_STATUS: "failure",
      SYNC_START: startedSecondsAgo(333),
      SYNC_FAILURE_STAGE: "prod→dev DB sync",
      SYNC_FAILURE_MODE: "database connection dropout",
      SYNC_FAILURE_DETAIL: "ECONNRESET; 3-attempt retry budget exhausted",
    });
    expect(entry.status).toBe("fail");
    expect(entry.detail).toBe(
      "5m 33s, prod→dev DB sync: database connection dropout",
    );
    expect(alert).toContain(
      "FAILED at prod→dev DB sync: database connection dropout",
    );
    expect(alert).toContain(URL);
  });

  it("a timeout (cancelled) still ticks — ❌, never a missing run", () => {
    const { entry, alert } = describeRun(now, URL, {
      JOB_STATUS: "cancelled",
      SYNC_START: startedSecondsAgo(900),
    });
    expect(entry.status).toBe("fail");
    expect(entry.detail).toBe("15m 00s, timed out");
    expect(alert).toContain("TIMED OUT");
  });

  it("marks a workflow_dispatch run manual, and copes with a missing SYNC_START", () => {
    const { entry } = describeRun(now, URL, {
      JOB_STATUS: "success",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    expect(entry.manual).toBe(true);
    expect(entry.detail).toBe(""); // no duration known → no parens, rather than a bogus one
  });
});
