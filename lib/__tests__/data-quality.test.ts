import { describe, it, expect } from "@jest/globals";
import {
  isSettledQuality,
  isDerivedQuality,
  qualityRank,
  KNOWN_QUALITIES,
  IMPORTABLE_QUALITIES,
} from "@/lib/data-quality";

describe("isSettledQuality", () => {
  it("treats good / actual / billable (long + Amber abbreviations) as settled", () => {
    for (const q of ["good", "actual", "billable", "a", "b"]) {
      expect(isSettledQuality(q)).toBe(true);
    }
  });

  it("treats forecast / estimated / unknown as provisional", () => {
    for (const q of ["forecast", "estimated", "f", "e", ".", "", "GOOD"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });

  // The allow-list is what makes a new marker safe to introduce: it is provisional until
  // someone deliberately promotes it, so a recovered interval can never be miscounted as
  // measured by a consumer that predates the marker.
  it("treats the gap-recovery markers as provisional", () => {
    for (const q of ["calculated", "interpolated"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });
});

describe("isDerivedQuality", () => {
  it("recognises the markers LiveOne writes for values it derived", () => {
    for (const q of ["calculated", "interpolated", "estimated"]) {
      expect(isDerivedQuality(q)).toBe(true);
    }
  });

  it("does not claim measured or vendor-provisional values as derived", () => {
    for (const q of [
      "good",
      "actual",
      "billable",
      "a",
      "b",
      "f",
      "forecast",
      ".",
      "",
    ]) {
      expect(isDerivedQuality(q)).toBe(false);
    }
  });

  // Derived is a strict subset of provisional — nothing may be both derived and settled.
  it("never overlaps with settled", () => {
    for (const q of ["calculated", "interpolated", "estimated"]) {
      expect(isSettledQuality(q)).toBe(false);
    }
  });
});

describe("qualityRank", () => {
  it("ranks Amber's settling sequence in the order it settles", () => {
    // f -> e -> a -> b is the progression a single interval walks as Amber finalises it, so a later
    // word must always outrank an earlier one. This is the ordering the DAO's collision-collapse
    // relies on; getting it backwards would let a re-fetch downgrade an invoiced interval.
    expect(qualityRank("b")).toBeGreaterThan(qualityRank("a"));
    expect(qualityRank("a")).toBeGreaterThan(qualityRank("e"));
    expect(qualityRank("e")).toBeGreaterThan(qualityRank("f"));
    expect(qualityRank("f")).toBeGreaterThan(qualityRank("."));
  });

  it("agrees with itself across each vendor's long and short spelling", () => {
    expect(qualityRank("billable")).toBe(qualityRank("b"));
    expect(qualityRank("actual")).toBe(qualityRank("a"));
    expect(qualityRank("forecast")).toBe(qualityRank("f"));
  });

  it("puts every settled marker above every provisional one", () => {
    for (const settled of ["good", "actual", "billable", "a", "b"])
      for (const provisional of [
        "calculated",
        "interpolated",
        "estimated",
        "e",
        "forecast",
        "f",
        ".",
      ])
        expect(qualityRank(settled)).toBeGreaterThan(qualityRank(provisional));
  });

  it("rates good and actual equally — no vendor draws that distinction", () => {
    expect(qualityRank("good")).toBe(qualityRank("actual"));
  });

  it("ranks an exact derivation above a genuine guess", () => {
    expect(qualityRank("calculated")).toBeGreaterThan(
      qualityRank("interpolated"),
    );
    expect(qualityRank("calculated")).toBeGreaterThan(qualityRank("estimated"));
  });

  it("floors anything unrecognised, null or undefined at zero", () => {
    // Same allow-list posture as isSettledQuality: an unknown marker must never displace a known
    // one, so a future vocabulary addition degrades to "loses ties" rather than "silently wins".
    for (const q of ["", "wat", "GOOD", null, undefined])
      expect(qualityRank(q)).toBe(0);
  });

  it("keeps every settled marker consistent with isSettledQuality", () => {
    for (const q of ["good", "actual", "billable", "a", "b"])
      expect(isSettledQuality(q) && qualityRank(q) > 0).toBe(true);
  });
});

describe("IMPORTABLE_QUALITIES", () => {
  it("is a subset of what the codebase can read back", () => {
    // The two lists are maintained separately on purpose, so this is the guard against drift: a
    // marker an operator can write but no consumer recognises would rank 0 forever.
    for (const q of IMPORTABLE_QUALITIES) expect(KNOWN_QUALITIES).toContain(q);
  });

  it("offers nothing that ranks zero", () => {
    // Ranking 0 means "provenance was never recorded" — the outcome `liveone import` exists to
    // prevent. Offering such a marker as a menu choice would be handing it to the operator.
    for (const q of IMPORTABLE_QUALITIES)
      expect(qualityRank(q)).toBeGreaterThan(0);
  });

  it("excludes Amber's storage abbreviations and the vendor-lifecycle words", () => {
    // `b`/`a`/`e`/`f` are a display concern that leaked into storage; `billable` and `forecast` are
    // claims only a vendor makes about its own settling series.
    for (const q of [
      "a",
      "b",
      "e",
      "f",
      ".",
      "unknown",
      "billable",
      "forecast",
    ])
      expect(IMPORTABLE_QUALITIES).not.toContain(q);
  });

  it("covers every marker derive-power.ts writes", () => {
    // The precedent this verb is modelled on. If it can produce a marker an import cannot, the two
    // paths disagree about what an operator is allowed to claim.
    for (const q of ["good", "calculated", "interpolated"])
      expect(IMPORTABLE_QUALITIES).toContain(q);
  });
});
