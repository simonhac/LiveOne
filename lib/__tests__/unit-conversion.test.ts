/**
 * Unit handling must FAIL CLOSED: a value whose unit could not be read is returned unscaled, never
 * scaled on a guess.
 *
 * Why this test exists. There are two W→kW converters in the fleet — `convertUnits` here and
 * `convertToKw` in `lib/charts/lines-data.ts` — and they used to DISAGREE about the same
 * missing-unit case. `lines-data` lowercases into `""` and returns the value untouched;
 * `site-data-processor` was called as `convertUnits(dataSeries.units || "W")`, so a series arriving
 * without a unit was assumed to be watts and divided by 1000. Same input, two answers, 1000x apart,
 * and neither path says which one a given chart took.
 *
 * Nothing is known to be firing: `units` is sourced from the point itself (`build-series.ts` and
 * `list-series.ts` both set it from `series.point.metricUnit` = `points.unit`). This pins the rule
 * so the trap cannot be reopened by a future caller that does not have a unit to hand.
 *
 * ⚠️ Scope. This is a hardcoded special case, not a unit model: it CARRIES units, it does not
 * RECONCILE them. Two sources of one quantity in different native units (NEM spot price is `$/MWh`
 * from OpenElectricity, `cents_kWh` from Amber) both pass through here unscaled and are each
 * labelled correctly — and are still not comparable. That is ha-parity #6.
 */
import { describe, it, expect } from "@jest/globals";
import { convertUnits } from "@/lib/site-data-processor";

describe("convertUnits", () => {
  it("scales the SI power/energy units it recognises", () => {
    expect(convertUnits("W")).toBe(1000);
    expect(convertUnits("Wh")).toBe(1000);
  });

  it("is case-insensitive, matching lines-data.ts's converter", () => {
    // The two converters must agree on every input, not merely on the happy path.
    expect(convertUnits("w")).toBe(1000);
    expect(convertUnits("wh")).toBe(1000);
  });

  it("passes through units that are already scaled", () => {
    expect(convertUnits("kW")).toBe(1);
    expect(convertUnits("kWh")).toBe(1);
  });

  it("passes through non-power units untouched", () => {
    for (const u of ["%", "cents_kWh", "$/MWh", "tCO2e/MWh", "text", "MW"])
      expect(convertUnits(u)).toBe(1);
  });

  it("🛑 FAILS CLOSED on a missing or unrecognised unit", () => {
    // The regression this file exists for: these must not be treated as watts.
    expect(convertUnits("")).toBe(1);
    expect(convertUnits(undefined as unknown as string)).toBe(1);
    expect(convertUnits(null as unknown as string)).toBe(1);
    expect(convertUnits("furlongs/fortnight")).toBe(1);
  });
});
