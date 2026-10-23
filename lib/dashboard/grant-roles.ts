/**
 * The dashboard grant roles — one per (dashboard, user). Dependency-free so routes, the CLI and the
 * UI can share the vocabulary without pulling in the database. Semantics: `lib/dashboard/grants.ts`.
 */
const DASHBOARD_GRANT_ROLES = ["view", "control", "admin"] as const;
export type DashboardGrantRole = (typeof DASHBOARD_GRANT_ROLES)[number];

export function isDashboardGrantRole(v: unknown): v is DashboardGrantRole {
  return (DASHBOARD_GRANT_ROLES as readonly unknown[]).includes(v);
}
