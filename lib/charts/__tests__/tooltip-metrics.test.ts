/**
 * The run-band tooltip's four panels — and specifically that ENERGY admits "unknown".
 *
 * 🛑 THE REGRESSION THIS FILE EXISTS FOR. `derived_intervals.energy_kwh` is NULL when a detector
 * binds no energy point (the Sigenergy EV charger publishes power only), the run-periods route used
 * to coalesce that to 0, and `provenancePanels` gave energy the only primary with no null branch —
 * its three siblings all had one. Result on prod: hovering a 6-hour EV charge on the stacked chart
 * showed "0.0 kWh / 0.0 kW" while the legend beside it read 6.8 kWh for the same session. A number
 * nobody measured was printed as a measurement, and the "0.0 kW" came from dividing that zero by
 * the run's duration.
 */
import { describe, it, expect } from "@jest/globals";
import { provenancePanels, runProvenancePanels } from "../tooltip-metrics";

/** A run with full provenance — the Kinkora shape, where an energy counter exists. */
const METERED = {
  energyKwh: 41.45,
  avgPowerW: 7031,
  costC: 167,
  emissionsG: 12_000,
  renewableKwh: 20,
  durationSeconds: 21_180,
};

/** The Kutis shape: power-only charger, so no energy and no provenance derived from it. */
const UNMETERED = {
  energyKwh: null,
  avgPowerW: 6765,
  costC: null,
  emissionsG: null,
  renewableKwh: null,
  durationSeconds: 22_680,
};

describe("provenancePanels — energy admits unknown, like its siblings", () => {
  const base = {
    costC: null,
    emissionsG: null,
    pctRenewable: null,
    avgCentsPerKwh: null,
    avgGramsPerKwh: null,
  };

  it('renders null energy as "—", never 0.0', () => {
    const p = provenancePanels({ ...base, energyKwh: null });
    expect(p.energy.primary.value).toBe("—");
    // The unit stays beneath it, exactly as emissions keeps "kg" under its own "—".
    expect(p.energy.primary.unit).toBe("kWh");
    expect(p.emissions.primary.value).toBe("—");
    expect(p.cost.primary.value).toBe("—");
  });

  it("still renders a real zero as a number", () => {
    // 0 kWh MEASURED is a fact (a run that drew nothing), and must stay distinguishable from
    // unknown — which is the whole reason null had to stop being spelled as 0 upstream.
    expect(
      provenancePanels({ ...base, energyKwh: 0 }).energy.primary.value,
    ).not.toBe("—");
  });
});

describe("runProvenancePanels", () => {
  it("shows energy and power for a metered run", () => {
    const p = runProvenancePanels(METERED, 48);
    expect(p.energy.primary.value).not.toBe("—");
    expect(p.energy.secondary?.value).not.toBeUndefined();
    expect(p.cost.primary.value).not.toBe("—");
  });

  it("shows power but NOT a fabricated energy for an unmetered run", () => {
    const p = runProvenancePanels(UNMETERED, null);
    expect(p.energy.primary.value).toBe("—");
    // …and the average power still arrives, because it comes from `avgPowerW` (the server's chosen
    // basis — the signal mean here) rather than from energy ÷ duration. This is the pairing that
    // was wrong: "0.0 kWh" beside "0.0 kW", when the charger was pulling 6.8 kW.
    expect(p.energy.secondary?.value).toBe("6.8");
    expect(p.energy.secondary?.unit).toBe("kW");
  });

  it("omits the power secondary only when there is no avgPowerW at all", () => {
    // An open run: still charging, no average yet.
    const p = runProvenancePanels(
      { ...UNMETERED, avgPowerW: null, durationSeconds: null },
      null,
    );
    expect(p.energy.secondary).toBeUndefined();
  });

  it("does not divide by a null energy when rating cost or emissions", () => {
    const p = runProvenancePanels(
      { ...UNMETERED, costC: 500, emissionsG: 1000 },
      null,
    );
    // The absolutes are known and shown; the per-kWh rates are not derivable without energy.
    expect(p.cost.primary.value).not.toBe("—");
    expect(p.cost.secondary?.value).toBe("—");
    expect(p.emissions.secondary?.value).toBe("—");
  });
});
