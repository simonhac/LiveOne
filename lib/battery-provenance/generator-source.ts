/**
 * The off-grid GENERATOR source intensity gate — the ONE place `config.batteryProvenance.
 * generatorSource` is turned into usable factors.
 *
 * Extracted from `loadProvenanceInputs` (lib/battery-provenance/load.ts), which was its only
 * implementation, because a second consumer now exists: run-period provenance prices a run with the
 * same constants (lib/run-tracking/intensity.ts). If that resolution were duplicated, the runs table
 * would silently disagree with the Sankey the first time this gating changed.
 *
 * The rule, unchanged: `emissionsIntensity` must be finite for ANY factors to apply (it is the
 * master gate — setting `generatorSource` at all is the statement "this site's AC-input is a
 * generator"); `pricePerKwh` is gated INDEPENDENTLY inside that, so price is never overridden
 * without emissions; `renewableFraction` defaults to 0 (diesel) when absent or non-finite.
 */
import type { GeneratorSourceConfig } from "@/lib/capabilities/config";

/** Resolved generator factors. `priceC` is null when `pricePerKwh` is absent/non-finite. */
export interface GeneratorIntensity {
  /** Emissions intensity of the generator's electrical output (gCO₂/kWh). Always finite. */
  gPerKwh: number;
  /** Cost of the generator's electrical output (c/kWh), or null when not configured. */
  priceC: number | null;
  /** Renewable fraction of the output (0..1); 0 for diesel. Always finite. */
  renewable: number;
}

/**
 * Resolve a device's `generatorSource` config into intensity factors, or null when the config is
 * absent or fails the master gate — in which case the caller must fall back to its normal source
 * (the OE/Amber region signal for the fold; no provenance columns at all for a run period).
 */
export function resolveGeneratorIntensity(
  gen: GeneratorSourceConfig | undefined | null,
): GeneratorIntensity | null {
  if (!gen || !Number.isFinite(gen.emissionsIntensity)) return null;
  return {
    gPerKwh: gen.emissionsIntensity,
    priceC: Number.isFinite(gen.pricePerKwh) ? gen.pricePerKwh : null,
    renewable: Number.isFinite(gen.renewableFraction)
      ? gen.renewableFraction
      : 0,
  };
}
