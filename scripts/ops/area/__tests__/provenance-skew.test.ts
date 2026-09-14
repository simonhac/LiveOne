import { describe, it, expect } from "@jest/globals";
import { tierSkew } from "../purge";

/**
 * The tier-skew check.
 *
 * `area provenance` reported `dailyRows: 349` (a year of fold rows) beside `agg1dRows: 426` — which
 * across six blend points is ~71 days — and said nothing. So the blend's daily rollup being eight
 * months short of its own 5-minute data was something you found by accident, when a 1d baseline
 * capture came back all-null. These are the numbers from that real reading (Kinkora Rd, prod,
 * 2026-09-15).
 */

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Exactly what `tierSkew` reads, so the fixture cannot drift from the function's own shape. */
type Report = Parameters<typeof tierSkew>[0];

const report = (over: Partial<Report> = {}): Report =>
  ({
    dailyRows: 349,
    firstDay: "2025-10-03",
    lastDay: "2026-09-16",
    helper: { deviceId: "dv_h", name: "helper", pointRids: [1, 2, 3, 4, 5, 6] },
    agg5mRows: 596_524,
    agg1dRows: 426,
    agg5mSpan: { firstMs: ms("2025-10-03"), lastMs: ms("2026-09-16") },
    agg1dSpan: { firstDay: "2026-07-08", lastDay: "2026-09-16" },
    bindings: 6,
    ...over,
  }) as Report;

describe("tierSkew", () => {
  it("names the short tier and the one it is short against", () => {
    const out = tierSkew(report());
    expect(out.join("\n")).toContain("blend 1d spans only 71");
    expect(out.join("\n")).toContain("battery fold spans 349");
  });

  it("says nothing when the tiers agree", () => {
    expect(
      tierSkew(
        report({
          agg1dSpan: { firstDay: "2025-10-03", lastDay: "2026-09-16" },
        }),
      ),
    ).toEqual([]);
  });

  /**
   * Deliberately coarse. These tiers are rebuilt by different passes and legitimately differ by a
   * warm-up day or two; a tight threshold would train the reader to ignore the warning.
   */
  it("tolerates a tier that is merely a little behind", () => {
    expect(
      tierSkew(
        report({
          agg1dSpan: { firstDay: "2025-12-03", lastDay: "2026-09-16" },
        }),
      ),
    ).toEqual([]);
  });

  /** A single tier cannot disagree with anything. */
  it("says nothing when only one tier exists", () => {
    expect(tierSkew(report({ agg5mSpan: null, agg1dSpan: null }))).toEqual([]);
  });

  /**
   * 🛑 A deployment older than this check omits the span fields entirely. It must stay quiet rather
   * than report every area as skewed — absent evidence is not evidence.
   */
  it("stays quiet against a server that serves no spans", () => {
    expect(
      tierSkew(
        report({
          agg5mSpan: undefined,
          agg1dSpan: undefined,
          firstDay: null,
          lastDay: null,
        }),
      ),
    ).toEqual([]);
  });

  it("flags a fold that is short against a long 5m history", () => {
    const out = tierSkew(
      report({
        firstDay: "2026-08-01",
        lastDay: "2026-09-16",
        agg1dSpan: { firstDay: "2025-10-03", lastDay: "2026-09-16" },
      }),
    );
    expect(out.join("\n")).toContain("battery fold spans only 47");
  });
});
