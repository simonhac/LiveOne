/**
 * The `oe-grid` tile's availability gate.
 *
 * 🛑 This exists because of a near-miss. The tile reads live market signals out of a device's
 * `latest` map and renders the price as `$N/MWh`. Until 2026-09-14 those serving keys
 * (`grid.price/rate`, `grid.emissionsIntensity/intensity`, `grid.renewables/proportion`) were
 * OpenElectricity's alone, so "this payload has the values" and "this is an OE region device" were
 * the same statement and the tile could trust the first one.
 *
 * Renaming the OE points into `bidi.grid.*` — so they match role `grid` by the ordinary anchor rule
 * — moved two of them onto keys **Amber already publishes**: `bidi.grid.spot/rate` in `cents_kWh`
 * and `bidi.grid.renewables/proportion`. Without a region check an Amber device satisfies the tile,
 * the card picker offers `oe-grid` on every Amber dashboard, and 10 c/kWh renders as "$10/MWh"
 * rather than $100/MWh. Units convert at the sink one day; they do not today.
 */
import { describe, it, expect } from "@jest/globals";
// The selector, NOT the tile: importing the tile pulls in GridSignalsCard -> next/font, which does
// not load under Jest. The gate is pure and lives beside the other grid selectors for that reason.
import { oeGridSelection } from "@/lib/grid/latest";

const lv = (value: number) => ({
  value,
  measurementTime: "2026-09-14T02:00:00.000Z",
});

/** What the public OpenElectricity NSW1 region device serves. */
const OE_PAYLOAD = {
  device: { vendorSiteId: "NSW1" },
  latest: {
    "bidi.grid.spot/rate": lv(92.5), // $/MWh
    "bidi.grid.emissionsIntensity/intensity": lv(0.55), // tCO2e/MWh
    "bidi.grid.renewables/proportion": lv(41.2), // %
    "grid.demand/power": lv(7200), // MW
  },
};

/** An Amber household device: the SAME two serving keys, different units, different meaning. */
const AMBER_PAYLOAD = {
  device: { vendorSiteId: "01ABCDEF" },
  latest: {
    "bidi.grid.spot/rate": lv(10.4), // cents_kWh — NOT $/MWh
    "bidi.grid.renewables/proportion": lv(38.0),
    "bidi.grid.import/rate": lv(31.2),
  },
};

/** Exactly what `oeGridTile.isAvailable` computes. */
const available = (data: unknown) => oeGridSelection(data) !== null;

describe("oe-grid tile availability", () => {
  it("is available on an OpenElectricity region device", () => {
    expect(available(OE_PAYLOAD)).toBe(true);
  });

  it("is NOT available on an Amber device that publishes the same serving keys", () => {
    expect(available(AMBER_PAYLOAD)).toBe(false);
  });

  it("is NOT available when the values are there but the region is missing", () => {
    // An area-bound section, or any payload without a device `vendorSiteId`. The values alone are
    // no longer sufficient evidence of the source.
    expect(available({ ...OE_PAYLOAD, device: undefined })).toBe(false);
    expect(available({ ...OE_PAYLOAD, device: { vendorSiteId: null } })).toBe(
      false,
    );
  });

  it("is NOT available on an OE-shaped payload with no market values", () => {
    expect(available({ device: { vendorSiteId: "NSW1" }, latest: {} })).toBe(
      false,
    );
  });
});
