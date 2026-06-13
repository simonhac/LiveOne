/**
 * Dashboard feature flags. Read once at module load (server-side) and passed to the client as
 * props, mirroring lib/db/routing.ts. Only the exact string "true" (trimmed, case-insensitive) is
 * truthy.
 */

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim().toLowerCase() === "true";
}

/**
 * Render the dashboard from a declarative card descriptor (lib/dashboard) instead of the
 * vendor_type if/else ladder in DashboardClient. Off → identical to the previous behaviour. This is
 * the P1 gate; the descriptor reproduces the ladder, so on/off render the same. See
 * docs/architecture/areas-and-dashboards.md.
 */
export const DECLARATIVE_DASHBOARD = envFlag("DECLARATIVE_DASHBOARD");

/**
 * Persist + customize dashboards (P2): load the user's saved descriptor (else the default) and
 * enable Customize mode (reorder/hide/add cards, Reset to default). Implies the descriptor render
 * path. Off → identical to the previous behaviour. See docs/architecture/areas-and-dashboards.md.
 */
export const DASHBOARD_PERSISTENCE = envFlag("DASHBOARD_PERSISTENCE");

/**
 * Render the live "Local Grid (NEM)" card on dashboards whose Area resolves to a NEM region. Gating
 * is done server-side (resolveGridContextForSystem + the descriptor default); this flag is the
 * top-level on/off. Off → the card is never appended. See docs/architecture/areas-and-dashboards.md.
 */
export const GRID_SIGNALS_CARD = envFlag("GRID_SIGNALS_CARD");
