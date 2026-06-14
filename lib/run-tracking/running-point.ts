/**
 * The derived "running" state point a device tracker publishes into the generic latest map.
 *
 * The run-tracking cron writes each enabled tracker's live running state (open run period exists?)
 * as a boolean point `<role stem>/running` (e.g. `source.generator/running`) into KV latest, so
 * dashboards read run state from `/api/data` like any other live value — never from a per-device
 * API. The stem comes from the role registry, so this generalises to any trackable role (pump…).
 *
 * Pure module (role registry only) — safe to import from both the engine and the front-end.
 */
import { ROLES } from "@/lib/roles/registry";

export const RUNNING_METRIC = "running";
export const RUNNING_UNIT = "bool";

/** Logical path of the derived running point for a role, or null for a role with no registry stem. */
export function runningPathForRole(role: string): string | null {
  const stem = (ROLES as Record<string, { stem: string }>)[role]?.stem;
  return stem ? `${stem}/${RUNNING_METRIC}` : null;
}
