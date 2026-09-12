/**
 * The grammar, in the reference zone the whole feature is built around (`Australia/Melbourne`,
 * which has both DST transitions and a +10/+11 offset, so a rule that survives here survives).
 */
import { describe as describeSuite, expect, it } from "@jest/globals";
import type { ExerciseSchedule } from "@/lib/db/planetscale/schema";
import {
  describe as describeSchedule,
  isExhausted,
  nextOccurrence,
  occurrencesBetween,
  parseRRuleSubset,
  previousOccurrence,
  toICalFragment,
} from "../recurrence";

const TZ = "Australia/Melbourne";

const schedule = (over: Partial<ExerciseSchedule>): ExerciseSchedule => ({
  start: "2026-09-17T09:00",
  graceMinutes: 180,
  ...over,
});

/** Local wall clock in TZ -> epoch ms, so the expectations read as the owner would say them. */
const local = (iso: string, offsetHours: number): number =>
  Date.parse(
    `${iso}:00${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`,
  );
/** Melbourne is +10 in winter (AEST) and +11 in summer (AEDT). */
const aest = (iso: string) => local(iso, 10);
const aedt = (iso: string) => local(iso, 11);

describeSuite("parseRRuleSubset", () => {
  it("canonicalises case and part order", () => {
    const out = parseRRuleSubset("byday=th;freq=weekly;interval=2");
    expect(out).toEqual({ ok: true, value: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH" });
  });

  it("accepts the whole subset", () => {
    for (const rule of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;WKST=MO",
      "FREQ=MONTHLY;BYDAY=1SA",
      "FREQ=MONTHLY;BYMONTHDAY=-1",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
      "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1",
      "FREQ=WEEKLY;BYDAY=TH;COUNT=3",
      "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231",
      "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231T130000Z",
    ])
      expect(parseRRuleSubset(rule).ok).toBe(true);
  });

  it("refuses what is deliberately outside the subset", () => {
    const cases: [string, string][] = [
      ["FREQ=HOURLY", "not supported"],
      ["FREQ=WEEKLY;BYHOUR=9", "BYHOUR is not supported"],
      ["FREQ=WEEKLY;BYWEEKNO=3", "BYWEEKNO is not supported"],
      ["RSCALE=CHINESE;FREQ=MONTHLY", "RSCALE is not supported"],
      ["BYDAY=TH", "must include FREQ"],
      [
        "FREQ=WEEKLY;COUNT=3;UNTIL=20261231",
        "must not set both COUNT and UNTIL",
      ],
      ["FREQ=WEEKLY;BYDAY=TH;BYDAY=FR", "appears more than once"],
      ["FREQ=WEEKLY;INTERVAL=0", "INTERVAL must be"],
      ["FREQ=WEEKLY;BYDAY=THU", "BYDAY term"],
      ["FREQ=WEEKLY;UNTIL=20261231T130000", "UNTIL must be"],
      ["FREQ=MONTHLY;BYMONTHDAY=32", "BYMONTHDAY term"],
      ["FREQ=WEEKLY;NONSENSE", "not KEY=VALUE"],
    ];
    for (const [rule, needle] of cases) {
      const out = parseRRuleSubset(rule);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain(needle);
    }
  });

  it("refuses a non-string", () => {
    expect(parseRRuleSubset(undefined).ok).toBe(false);
    expect(parseRRuleSubset("").ok).toBe(false);
  });

  // 🛑 The three ways a rule used to pass validation and then break something downstream. Each of
  // these stored happily before, because the "second gate" only CONSTRUCTED the library object and
  // construction is lazy.
  it("refuses an unmatchable BYDAY ordinal instead of storing a rule nothing can expand", () => {
    // `6MO` under FREQ=MONTHLY has no sixth Monday to find, so the library hunts to its 10,000
    // iteration guard and THROWS — at expansion, long after the row was written. That made every
    // later `GET /api/v4/automations?area=…` 500, because the list maps each row through
    // `automationWire` -> `nextOccurrence`.
    const out = parseRRuleSubset("FREQ=MONTHLY;BYDAY=6MO");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("out of range");

    // RFC 5545 caps the ordinal at 53 whatever the frequency.
    expect(parseRRuleSubset("FREQ=YEARLY;BYDAY=54MO").ok).toBe(false);
    expect(parseRRuleSubset("FREQ=MONTHLY;BYDAY=-6FR").ok).toBe(false);

    // ...and the forms that ARE meaningful still pass.
    expect(parseRRuleSubset("FREQ=MONTHLY;BYDAY=1SA").ok).toBe(true);
    expect(parseRRuleSubset("FREQ=MONTHLY;BYDAY=5MO").ok).toBe(true);
    expect(parseRRuleSubset("FREQ=MONTHLY;BYDAY=-1FR").ok).toBe(true);
    expect(parseRRuleSubset("FREQ=YEARLY;BYDAY=53MO").ok).toBe(true);
  });

  it("refuses a NEGATIVE BYMONTH, which the library would silently drop", () => {
    // Counting from the end is meaningful for BYMONTHDAY (-1 = the last day) and BYSETPOS, and
    // meaningless for a month. One shared `Math.abs` range check accepted all three; the library
    // then sanitised BYMONTH to 1..12 and removed the filter the owner actually wrote.
    const out = parseRRuleSubset("FREQ=MONTHLY;BYMONTH=-2;BYMONTHDAY=1");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("BYMONTH term");

    expect(parseRRuleSubset("FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=1").ok).toBe(
      true,
    );
    // The signed parts keep their negatives.
    expect(parseRRuleSubset("FREQ=MONTHLY;BYMONTHDAY=-1").ok).toBe(true);
    expect(parseRRuleSubset("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1").ok).toBe(true);
  });

  it("refuses a rule the library cannot EXPAND, not merely one it cannot construct", () => {
    // A rule whose only match is a date that never occurs. Constructing it succeeds; asking for one
    // occurrence is what surfaces the problem, which is why the gate now asks.
    const out = parseRRuleSubset("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not a valid recurrence rule");
  });
});

describeSuite("one-off (no rrule)", () => {
  const once = schedule({ start: "2026-09-12T09:00" });

  it("has exactly one occurrence and is then exhausted", () => {
    expect(previousOccurrence(once, TZ, aest("2026-09-12T12:00"))).toEqual({
      atMs: aest("2026-09-12T09:00"),
    });
    expect(nextOccurrence(once, TZ, aest("2026-09-12T09:00"))).toBeNull();
    expect(isExhausted(once, TZ, aest("2026-09-12T09:00"))).toBe(true);
  });

  it("is not exhausted, and has no previous slot, before it happens", () => {
    expect(previousOccurrence(once, TZ, aest("2026-09-12T08:59"))).toBeNull();
    expect(isExhausted(once, TZ, aest("2026-09-11T00:00"))).toBe(false);
  });
});

describeSuite("previousOccurrence", () => {
  const weekly = schedule({ rrule: "FREQ=WEEKLY;BYDAY=TH" });

  it("is INCLUSIVE of an exact hit on the slot instant", () => {
    const at = aest("2026-09-17T09:00");
    expect(previousOccurrence(weekly, TZ, at)).toEqual({ atMs: at });
  });

  it("holds the local wall clock across the October DST start", () => {
    // AEDT begins 2026-10-04. The Thursdays either side must both be 09:00 LOCAL, an hour apart
    // in absolute terms — the case the old day-subtracting lookback existed to get right.
    expect(previousOccurrence(weekly, TZ, aest("2026-10-01T23:00"))).toEqual({
      atMs: aest("2026-10-01T09:00"),
    });
    expect(previousOccurrence(weekly, TZ, aedt("2026-10-08T23:00"))).toEqual({
      atMs: aedt("2026-10-08T09:00"),
    });
  });

  it("holds the local wall clock across the April DST end", () => {
    // A start EARLIER in the year, since the shared fixture begins in September.
    const weekly = schedule({
      start: "2026-01-01T09:00",
      rrule: "FREQ=WEEKLY;BYDAY=TH",
    });
    expect(previousOccurrence(weekly, TZ, aedt("2026-04-02T23:00"))).toEqual({
      atMs: aedt("2026-04-02T09:00"),
    });
    expect(previousOccurrence(weekly, TZ, aest("2026-04-09T23:00"))).toEqual({
      atMs: aest("2026-04-09T09:00"),
    });
  });

  it("returns LAST week's slot when today's has not arrived yet", () => {
    expect(previousOccurrence(weekly, TZ, aest("2026-09-24T08:00"))).toEqual({
      atMs: aest("2026-09-17T09:00"),
    });
  });

  it("picks the nearest of several weekdays", () => {
    const multi = schedule({
      start: "2026-09-07T09:00",
      rrule: "FREQ=WEEKLY;BYDAY=MO,TH",
    });
    // Fri 11 Sep — Thursday is nearer than Monday.
    expect(previousOccurrence(multi, TZ, aest("2026-09-11T12:00"))).toEqual({
      atMs: aest("2026-09-10T09:00"),
    });
    // Wed 9 Sep — now Monday is the most recent.
    expect(previousOccurrence(multi, TZ, aest("2026-09-09T12:00"))).toEqual({
      atMs: aest("2026-09-07T09:00"),
    });
  });

  it("lands a Sunday slot correctly on the spring-forward day itself", () => {
    // Sun 4 Oct 2026 is the transition day; 09:00 is well clear of the 02:00 gap the parser bans.
    const sunday = schedule({
      start: "2026-09-20T09:00",
      rrule: "FREQ=WEEKLY;BYDAY=SU",
    });
    expect(previousOccurrence(sunday, TZ, aedt("2026-10-04T12:00"))).toEqual({
      atMs: aedt("2026-10-04T09:00"),
    });
  });

  it("returns null before the schedule starts", () => {
    expect(previousOccurrence(weekly, TZ, aest("2026-09-16T09:00"))).toBeNull();
  });
});

describeSuite("intervals and ordinals", () => {
  it("anchors a fortnight on start, not on the week number", () => {
    const fortnightly = schedule({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH" });
    const got = occurrencesBetween(
      fortnightly,
      TZ,
      aest("2026-09-01T00:00"),
      aedt("2026-11-01T00:00"),
    ).map((s) => s.atMs);
    expect(got).toEqual([
      aest("2026-09-17T09:00"),
      aest("2026-10-01T09:00"),
      aedt("2026-10-15T09:00"),
      aedt("2026-10-29T09:00"),
    ]);
  });

  it("expands a first-Saturday rule", () => {
    const firstSat = schedule({ rrule: "FREQ=MONTHLY;BYDAY=1SA" });
    const got = occurrencesBetween(
      firstSat,
      TZ,
      aest("2026-09-17T00:00"),
      aedt("2026-12-31T00:00"),
    ).map((s) => s.atMs);
    expect(got).toEqual([
      aest("2026-10-03T09:00"),
      aedt("2026-11-07T09:00"),
      aedt("2026-12-05T09:00"),
    ]);
  });

  it("expands a last-day-of-month rule", () => {
    const monthEnd = schedule({ rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" });
    const got = occurrencesBetween(
      monthEnd,
      TZ,
      aest("2026-09-17T00:00"),
      aedt("2026-12-01T00:00"),
    ).map((s) => s.atMs);
    expect(got).toEqual([
      aest("2026-09-30T09:00"),
      aedt("2026-10-31T09:00"),
      aedt("2026-11-30T09:00"),
    ]);
  });
});

describeSuite("exhaustion", () => {
  it("ends after COUNT instances", () => {
    const counted = schedule({ rrule: "FREQ=WEEKLY;BYDAY=TH;COUNT=3" });
    const last = aest("2026-10-01T09:00");
    expect(isExhausted(counted, TZ, aest("2026-09-24T09:00"))).toBe(false);
    expect(isExhausted(counted, TZ, last)).toBe(true);
    expect(nextOccurrence(counted, TZ, last)).toBeNull();
  });

  it("ends after UNTIL, read as a local calendar date", () => {
    const bounded = schedule({ rrule: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261015" });
    const got = occurrencesBetween(
      bounded,
      TZ,
      aest("2026-09-01T00:00"),
      aedt("2026-12-01T00:00"),
    ).map((s) => s.atMs);
    expect(got[got.length - 1]).toBe(aedt("2026-10-15T09:00"));
    expect(isExhausted(bounded, TZ, aedt("2026-10-15T09:00"))).toBe(true);
  });
});

describeSuite("exdates and rdates", () => {
  const weekly = schedule({ rrule: "FREQ=WEEKLY;BYDAY=TH" });

  it("an exdate removes exactly one instance", () => {
    const skipped = { ...weekly, exdates: ["2026-09-24T09:00"] };
    expect(previousOccurrence(skipped, TZ, aest("2026-09-24T23:00"))).toEqual({
      atMs: aest("2026-09-17T09:00"),
    });
    expect(nextOccurrence(skipped, TZ, aest("2026-09-17T09:00"))).toEqual({
      atMs: aest("2026-10-01T09:00"),
    });
  });

  it("an rdate adds one", () => {
    const extra = { ...weekly, rdates: ["2026-09-20T09:00"] };
    expect(nextOccurrence(extra, TZ, aest("2026-09-17T09:00"))).toEqual({
      atMs: aest("2026-09-20T09:00"),
    });
  });

  it("an rdate can extend an otherwise exhausted one-off", () => {
    const once = schedule({
      start: "2026-09-12T09:00",
      rdates: ["2026-09-19T09:00"],
    });
    expect(isExhausted(once, TZ, aest("2026-09-12T09:00"))).toBe(false);
    expect(nextOccurrence(once, TZ, aest("2026-09-12T09:00"))).toEqual({
      atMs: aest("2026-09-19T09:00"),
    });
  });
});

describeSuite("toICalFragment", () => {
  it("carries the area zone on every line, and makes a one-off a series of one", () => {
    expect(toICalFragment(schedule({ start: "2026-09-12T09:00" }), TZ)).toBe(
      "DTSTART;TZID=Australia/Melbourne:20260912T090000\nRRULE:FREQ=DAILY;COUNT=1",
    );
    expect(
      toICalFragment(
        schedule({
          rrule: "FREQ=WEEKLY;BYDAY=TH",
          exdates: ["2026-09-24T09:00"],
          rdates: ["2026-09-20T09:00"],
        }),
        TZ,
      ),
    ).toBe(
      [
        "DTSTART;TZID=Australia/Melbourne:20260917T090000",
        "RRULE:FREQ=WEEKLY;BYDAY=TH",
        "EXDATE;TZID=Australia/Melbourne:20260924T090000",
        "RDATE;TZID=Australia/Melbourne:20260920T090000",
      ].join("\n"),
    );
  });
});

describeSuite("describe", () => {
  it("words a one-off and a weekly rule", () => {
    expect(describeSchedule(schedule({}), TZ)).toBe("once");
    expect(
      describeSchedule(schedule({ rrule: "FREQ=WEEKLY;BYDAY=TH" }), TZ),
    ).toContain("Thursday");
  });
});
