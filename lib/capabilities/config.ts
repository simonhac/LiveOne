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

/** Per-device battery-provenance knobs (currently just the off-grid generator source). */
export interface BatteryProvenanceConfig {
  generatorSource?: GeneratorSourceConfig;
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
