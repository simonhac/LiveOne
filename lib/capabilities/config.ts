/**
 * Per-device CONFIG — the typed, user-editable "all sorts of stuff" blob stored on `systems.config`
 * (jsonb). Distinct from `systems.metadata`, which is the adapter-owned credentials/diagnostics bag
 * (secure-credentials, vendor network, device descriptors). `config` is the clean home for the
 * per-device knobs the capability cleanup is data-driving instead of hardcoding — it grows WITHOUT
 * migrations (the HA `.storage` model), because the column already exists.
 *
 * Today: capability on/off overrides. Forward seams (fold legacy in over time): `nameplateKw` retires
 * the regex that scrapes `systems.solar_size`/`ratings` free text; `updateCadenceSeconds` retires the
 * hardcoded `vendorType === 'enphase' ? 2100 : 300` stale-threshold branch.
 *
 * NOTE (scope): `capabilities` here is a PRESENTATION on/off — force a derived card capability on or off.
 * It is NOT a semantic role remap ("this grid point is really the generator"): that must also flow into
 * the energy-flow matrix + KV paths, so it stays a point/binding-level correction, not a config toggle.
 */
import type { CapabilityId } from "@/lib/capabilities/registry";

/**
 * Off-grid GENERATOR source intensity. For a site whose inverter AC-input (measured as `bidi.grid`) is a
 * generator rather than a mains grid, these constants price that "grid" energy in the battery-provenance
 * model — there is no OpenElectricity/Amber signal off-grid. Read by `loadProvenanceInputs` when the Area
 * has no NEM region. See `docs/architecture/battery-provenance.md` § Off-grid sites + generator. (This is a
 * VALUE knob, not the forbidden role remap — the "bidi.grid is the generator" mapping is a binding-level
 * fact; this only supplies its intensity.)
 */
export interface GeneratorSourceConfig {
  /** Emissions intensity of the generator's electrical output (gCO₂/kWh). */
  emissionsIntensity: number;
  /** Cost of the generator's electrical output (c/kWh). */
  pricePerKwh: number;
  /** Renewable fraction of the output (0..1) — 0 for diesel, > 0 for bio-fuel blends. */
  renewableFraction: number;
}

/**
 * Export (feed-in) tariff — the source of SOLAR OPPORTUNITY COST in the battery-provenance model: charging
 * solar into the battery FORGOES the feed-in revenue you'd have earned exporting it, so opportunity cost =
 * solar charge × feed-in price. The fold consumes only a per-interval export-price series (c/kWh); this
 * config selects where that series comes from. Designed so a future PERSISTED "tariff device" (Option B)
 * drops in with NO fold change — it would merely materialise the same schedule into a `bidi.grid.export/rate`
 * point the loader reads exactly like Amber. See docs/architecture/battery-provenance.md § Opportunity cost.
 */
export type ExportTariffConfig =
  | { mode: "none" } // no opportunity cost (solar valued at 0)
  | { mode: "amber" } // measured Amber feed-in (the bound bidi.grid.export/rate series)
  | { mode: "schedule"; plans: ExportTariffPlan[] }; // retailer schedule, synthesised per interval

/**
 * One retailer tariff VERSION, effective from a local date until the next plan supersedes it. Retailers
 * update feed-in rates periodically; append a new plan (higher `effectiveFrom`) on each change so a
 * historical re-fold prices each interval with the plan that was actually in force. Selection:
 * newest `effectiveFrom` ≤ the interval's local date wins; before the earliest plan → no tariff (null).
 */
export interface ExportTariffPlan {
  /** Local date "YYYY-MM-DD" this plan takes effect; omit for a single always-on plan. */
  effectiveFrom?: string;
  rate: ExportTariffRate;
}

/** Flat (built now) or time-of-use bands (schema reserved; the band evaluator lands with the TOU work). */
export type ExportTariffRate =
  | { kind: "flat"; cPerKwh: number }
  | { kind: "tou"; bands: TouBand[]; defaultCPerKwh: number };

/**
 * A time-of-use band: `cPerKwh` applies within the local clock window [start, end) on the given
 * days/months. RESERVED for the TOU extension (not evaluated yet) — documents the target shape so it drops
 * in without touching the fold. e.g. weekday 17:00–20:00 peak, weekends off-peak, seasonal via `months`.
 */
export interface TouBand {
  cPerKwh: number;
  /** "HH:MM" local (24h). Window is [start, end); wraps past midnight when end ≤ start. */
  start: string;
  end: string;
  /** Days of week the band applies (0=Sun … 6=Sat); omit = all days. */
  days?: number[];
  /** Months the band applies (1 … 12); omit = all months. */
  months?: number[];
}

/** Per-device battery-provenance knobs (off-grid generator source + export tariff for opportunity cost). */
export interface BatteryProvenanceConfig {
  generatorSource?: GeneratorSourceConfig;
  /** Export (feed-in) tariff → solar opportunity cost. Absent ⇒ `{ mode: "none" }` (no opportunity cost). */
  exportTariff?: ExportTariffConfig;
}

export interface DeviceConfig {
  /** Force a derived capability ON (true) or OFF (false); absent ⇒ derive from points as normal. */
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  /** Nameplate size (kW) — forward seam to retire the free-text `solar_size`/`ratings` scraping. */
  nameplateKw?: number;
  /** Expected update cadence (seconds) — forward seam to retire the hardcoded vendor stale threshold. */
  updateCadenceSeconds?: number;
  /** Battery-provenance per-device config (currently the off-grid generator source intensity). */
  batteryProvenance?: BatteryProvenanceConfig;
}

/**
 * Apply a device's capability overrides to a derived set: present+true forces the capability on,
 * present+false forces it off, absent leaves derivation untouched. Returns a new set; a null/empty
 * config is a no-op (so an un-configured device behaves exactly as before — parity preserved).
 */
export function applyCapabilityConfig(
  derived: Set<CapabilityId>,
  config: DeviceConfig | null | undefined,
): Set<CapabilityId> {
  const overrides = config?.capabilities;
  if (!overrides) return derived;
  const out = new Set(derived);
  for (const [cap, enabled] of Object.entries(overrides) as [
    CapabilityId,
    boolean,
  ][]) {
    if (enabled) out.add(cap);
    else out.delete(cap);
  }
  return out;
}
