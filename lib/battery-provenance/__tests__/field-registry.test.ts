/**
 * Runtime complement of the registry's `satisfies Record<ProvenanceFieldKey, …>` compile guard:
 * the compile check proves FIELD_META covers every column; these prove the CHART/table layer
 * actually consumes what the API ships (no orphaned field, no duplicate series).
 */
import { describe, expect, it } from "@jest/globals";
import {
  BOOKKEEPING_ROWS,
  FIELD_META,
  FOLD_DERIVED_KEYS,
  PLOTTABLE_ROW_KEYS,
  PROVENANCE_CHARTS,
  PROVENANCE_FIELD_KEYS,
  type ProvenanceDailyResponse,
  type ProvenanceFieldKey,
} from "../field-registry";

const allSeries = PROVENANCE_CHARTS.flatMap((c) => c.series);

/** A one-day response where field k has value v (all other fields null). */
function responseWith(
  values: Partial<Record<ProvenanceFieldKey, number>>,
): ProvenanceDailyResponse {
  const fields = Object.fromEntries(
    PROVENANCE_FIELD_KEYS.map((k) => [k, [values[k] ?? null]]),
  ) as ProvenanceDailyResponse["fields"];
  return {
    areaId: "test",
    systemId: null,
    range: { start: "2026-01-01", end: "2026-01-01" },
    days: ["2026-01-01"],
    fields,
    rowMeta: { firstIntervalEnd: [null], version: [null], updatedAt: [null] },
  };
}

describe("field-registry", () => {
  it("series ids are unique across the whole panel", () => {
    const ids = allSeries.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("chart ids are unique", () => {
    const ids = PROVENANCE_CHARTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every field key is consumed by a series, a band, or a bookkeeping row", () => {
    // A field is "consumed by a series" if setting ONLY that field to a sentinel makes some
    // series produce a non-null value — this catches value() accessors reading the wrong key.
    const consumedBySeries = new Set<ProvenanceFieldKey>();
    for (const key of PROVENANCE_FIELD_KEYS) {
      // Derived fold ratios also need the storedKwh denominator — keep it in BOTH sides so the
      // only delta is `key` itself (and drop it from both when key IS the denominator).
      const denom = key === "foldStoredKwh" ? {} : { foldStoredKwh: 42 };
      const resp = responseWith({ ...denom, [key]: 42 });
      const zero = responseWith(denom);
      for (const s of allSeries) {
        if (s.value(resp.fields, 0) !== s.value(zero.fields, 0)) {
          consumedBySeries.add(key);
          break;
        }
      }
    }
    const bandFields = new Set(
      PROVENANCE_CHARTS.map((c) => c.bandField).filter(Boolean),
    );
    const bookkeepingIds = new Set(BOOKKEEPING_ROWS.map((r) => r.id));

    const orphans = PROVENANCE_FIELD_KEYS.filter(
      (k) =>
        !consumedBySeries.has(k) &&
        !bandFields.has(k) &&
        !bookkeepingIds.has(k),
    );
    expect(orphans).toEqual([]);
  });

  it("field-backed series inherit their field's label/unit/decimals", () => {
    for (const s of allSeries) {
      const meta = FIELD_META[s.id as ProvenanceFieldKey];
      if (!meta) continue; // derived series carry their own meta
      expect(s.label).toBe(meta.label);
      expect(s.unit).toBe(meta.unit);
      expect(s.decimals).toBe(meta.decimals);
    }
  });

  it("every series has a non-trivial description for the label tooltip", () => {
    for (const s of allSeries) {
      expect(s.description.length).toBeGreaterThan(40);
    }
    for (const r of BOOKKEEPING_ROWS) {
      expect(r.description.length).toBeGreaterThan(20);
    }
  });

  it("y1 series only appear on charts that declare a y1 axis", () => {
    for (const c of PROVENANCE_CHARTS) {
      for (const s of c.series) {
        if (s.axis === "y1") expect(c.y1).toBeDefined();
      }
    }
  });

  it("derived fold ratios null out on an empty store", () => {
    const empty = responseWith({ foldCarbonG: 1000, foldStoredKwh: 0 });
    const carbon = allSeries.find((s) => s.id === "foldCarbonIntensity")!;
    expect(carbon.value(empty.fields, 0)).toBeNull();

    const live = responseWith({ foldCarbonG: 1000, foldStoredKwh: 10 });
    expect(carbon.value(live.fields, 0)).toBe(100);
  });

  it("key partitions cover exactly the field set", () => {
    expect([...PLOTTABLE_ROW_KEYS, ...FOLD_DERIVED_KEYS].sort()).toEqual(
      [...PROVENANCE_FIELD_KEYS].sort(),
    );
  });
});
