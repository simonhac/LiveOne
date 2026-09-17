/**
 * The PURE Selectronic decoder: raw `items` → canonical `SelectronicData`.
 *
 * 🛑 A separate file from `adapter.test.ts` by necessity, not by taste. That suite mocks
 * `../selectronic-client` wholesale to drive the adapter's session handling, so the real decoder is
 * unreachable from it — importing this function there returns the mock and every assertion passes
 * vacuously.
 */
import { describe, it, expect } from "@jest/globals";
import {
  BATTERY_DISCHARGE_W,
  GRID_EXPORT_W,
  GRID_IMPORT_W,
} from "@/lib/aggregation/__fixtures__/sign-convention";
import { transformSelectronicData } from "../selectronic-client";

/**
 * 🛑 Tested against `transformSelectronicData`, the PURE decoder — not through the adapter.
 *
 * That is not a convenience: `SelectronicAdapter.fetchData` builds the stored `point_readings` from
 * the decoder's output (`vendorData[field]`) and uses `transformData` only for the KV/latest value.
 * A flip placed in `transformData` would change what the dashboard shows live and leave the stored
 * column untouched — the two disagreeing again, by a new route. The adapter suite mocks the client
 * wholesale, so it cannot see the decoder at all and would have passed either way.
 */
describe("transformSelectronicData — the sign convention", () => {
  const decode = (items: Record<string, unknown>) =>
    transformSelectronicData({ items });

  // The SP-PRO signs its AC-input port NEGATIVE while the house draws from it; LiveOne's canonical
  // `bidi.*` convention is positive = inflow/import. Normalising at ingest, once, is what lets
  // every consumer read the stored column without knowing anything about Selectronic.
  it("🛑 flips grid_w to canonical import-positive", () => {
    expect(decode({ grid_w: -GRID_IMPORT_W }).gridW).toBe(GRID_IMPORT_W);
  });

  it("flips export the other way", () => {
    expect(decode({ grid_w: -GRID_EXPORT_W }).gridW).toBe(GRID_EXPORT_W);
  });

  it("does not emit -0", () => {
    expect(Object.is(decode({ grid_w: 0 }).gridW, -0)).toBe(false);
    expect(decode({ grid_w: 0 }).gridW).toBe(0);
  });

  it("preserves null — a missing reading is not zero import", () => {
    // A dropped `grid_w` must stay absent rather than becoming a real 0 W observation, which would
    // read as "the generator was off" to anything measuring loaded minutes.
    expect(decode({}).gridW).toBeNull();
    expect(decode({ grid_w: null }).gridW).toBeNull();
  });

  // The battery leg is deliberately NOT flipped: the SP-PRO already signs it canonically. Pinned so
  // nobody "helpfully" makes the whole decoder symmetrical.
  it("does NOT touch battery_w — it is already canonical", () => {
    expect(decode({ battery_w: BATTERY_DISCHARGE_W }).batteryW).toBe(
      BATTERY_DISCHARGE_W,
    );
  });

  it("does NOT touch load_w — it is unidirectional", () => {
    expect(decode({ load_w: 400 }).loadW).toBe(400);
  });

  // `solarW` is a SUM of the two solar inputs, not a passthrough of `solar_w` — so it is asserted
  // through its real inputs. Included because the flip must not leak into the solar legs either.
  it("does NOT touch the solar legs", () => {
    const d = decode({ solarinverter_w: 3000, shunt_w: 1423 });
    expect(d.solarInverterW).toBe(3000);
    expect(d.shuntW).toBe(1423);
    expect(d.solarW).toBe(4423);
  });
});
