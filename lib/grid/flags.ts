/**
 * Grid-signals feature flag. Read once at module load. Only the exact string "true" (trimmed,
 * case-insensitive) is truthy — mirrors lib/areas/flags.ts.
 */

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/**
 * Enable the "Local Grid (NEM)" card — live OpenElectricity grid signals (price/emissions/renewables)
 * embedded on a household dashboard, with the region derived from the Area's location. Gated together
 * with AREAS_TABLE (the card needs the identity Area's location). Off → no card; rollback = flag off.
 * See docs/architecture/areas-and-dashboards.md.
 */
export const GRID_SIGNALS_CARD = envFlag("GRID_SIGNALS_CARD");
