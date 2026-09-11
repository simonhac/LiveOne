/**
 * Tests for the `import` verb's CSV parser.
 *
 * 🛑 Strictness is the feature. A reader that shrugs at a short row or an unexpected header produces
 * a plausible-looking import against the wrong point or the wrong hour — and unlike every other
 * writer, nothing downstream can detect that later, because an import has no source of truth to be
 * re-derived from. So every malformed shape must be a refusal, not a skipped row.
 */
import { describe, it, expect } from "@jest/globals";
import { CliFailure } from "@/lib/cli/cli";
import { parseCsv, importCommand } from "../cli";
import { IMPORTABLE_QUALITIES } from "@/lib/data-quality";

/**
 * The `what` line of a refusal — the headline the operator reads. `CliFailure`'s Error `message` is
 * the `why`, so asserting with `toThrow` would silently test the wrong half of the message.
 */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliFailure) return e.detail.what;
    throw e;
  }
  throw new Error("expected a refusal, but the call returned");
}

const HEAD = "point,interval_end,value";
const PT = "pt_3ae6h0d8f2avvbadgq4t3ctsgq";

describe("parseCsv", () => {
  it("reads a well-formed file", () => {
    const rows = parseCsv(`${HEAD}\n${PT},2026-09-11T00:05:00Z,387\n`);
    expect(rows).toEqual([
      { point: PT, intervalEnd: "2026-09-11T00:05:00Z", value: 387 },
    ]);
  });

  it("locates columns BY HEADER, not by position", () => {
    // A file written by a different tool may order them differently; silently reading column 0 as
    // the point is how an import lands against whatever a timestamp happens to resolve to.
    const rows = parseCsv(
      `value,point,interval_end\n387,${PT},2026-09-11T00:05:00Z\n`,
    );
    expect(rows[0]).toEqual({
      point: PT,
      intervalEnd: "2026-09-11T00:05:00Z",
      value: 387,
    });
  });

  it("keeps a non-numeric value as a string, for text points", () => {
    const rows = parseCsv(`${HEAD}\n${PT},2026-09-11T00:05:00Z,running\n`);
    expect(rows[0].value).toBe("running");
  });

  it("ignores blank lines and # comments", () => {
    const rows = parseCsv(
      `# reconstructed 2026-09-11\n${HEAD}\n\n${PT},2026-09-11T00:05:00Z,1\n\n`,
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a file whose header names no timestamp column", () => {
    expect(refusal(() => parseCsv(`point,value\n${PT},1\n`))).toMatch(
      /names neither interval_end nor interval_start/,
    );
  });

  it("refuses a file whose header is missing the value column", () => {
    expect(
      refusal(() =>
        parseCsv(`point,interval_end\n${PT},2026-09-11T00:05:00Z\n`),
      ),
    ).toMatch(/missing: value/);
  });

  it("refuses a short row rather than shifting the remaining cells", () => {
    expect(
      refusal(() => parseCsv(`${HEAD}\n${PT},2026-09-11T00:05:00Z\n`)),
    ).toMatch(/line 2 has 2 column\(s\)/);
  });

  it("refuses a header with no rows", () => {
    expect(refusal(() => parseCsv(`${HEAD}\n`))).toMatch(/no rows/);
  });

  it("refuses an empty file", () => {
    expect(refusal(() => parseCsv("   \n\n"))).toMatch(/empty/);
  });
});

describe("the command spec", () => {
  it("is dry-run by default, because an import has no source of truth to re-derive from", () => {
    expect(importCommand.mutates).toBe(true);
  });

  it("offers exactly the recognised quality markers, and no default", () => {
    // 🛑 A default would be wrong in both directions: `good` launders a reconstruction into a
    // measurement, `interpolated` defames a measurement recovered from an export.
    const q = importCommand.flags!.quality as {
      values?: readonly string[];
      default?: unknown;
    };
    expect(q.values).toEqual([...IMPORTABLE_QUALITIES]);
    expect(q.default).toBeUndefined();
  });

  it("offers no marker that reads as 'provenance never recorded'", () => {
    // The allow-list is deliberately narrower than KNOWN_QUALITIES. `unknown` and `.` rank 0, which
    // is the exact outcome this verb exists to prevent; `a`/`b`/`e`/`f` are Amber's storage
    // abbreviations and are not claims anyone can act on about another vendor's point.
    const q = importCommand.flags!.quality as { values?: readonly string[] };
    for (const bad of ["unknown", ".", "a", "b", "e", "f"])
      expect(q.values).not.toContain(bad);
  });

  it("requires a session, and does not default one", () => {
    // 🛑 Without it, `--quality=good` is indistinguishable from a live measurement forever after.
    // A per-invocation default would also scatter one repair job across as many sessions as the
    // file happened to be chunked into.
    const sess = importCommand.flags!.session as { default?: unknown };
    expect(sess).toBeDefined();
    expect(sess.default).toBeUndefined();
  });

  it("does not overwrite better-graded readings unless asked", () => {
    const flag = importCommand.flags!["overwrite-measured"] as {
      type: string;
      default?: unknown;
    };
    expect(flag.type).toBe("boolean");
    expect(flag.default).toBeFalsy();
  });
});

describe("the timestamp column names its own convention", () => {
  // 🛑 A 5m row is keyed on the interval END, but `liveone device history --format csv` and both
  // vendor archives stamp the START — and both land on 5-minute boundaries, so reading one as the
  // other validates cleanly and shifts every row by a whole interval. Putting the convention in the
  // HEADER rather than a flag is what makes that undetectable mistake impossible: a flag can
  // disagree with the file it is pointed at, and the person running the command is often not the
  // person who wrote the file.
  it("passes a start-stamped file through as intervalStart", () => {
    const rows = parseCsv(
      `point,interval_start,value\n${PT},2026-09-11T00:05:00Z,387\n`,
    );
    expect(rows).toEqual([
      { point: PT, intervalStart: "2026-09-11T00:05:00Z", value: 387 },
    ]);
  });

  it("refuses a file that names both, rather than picking one", () => {
    expect(
      refusal(() =>
        parseCsv(`point,interval_end,interval_start,value\n${PT},a,b,1\n`),
      ),
    ).toMatch(/names both interval_end and interval_start/);
  });
});
