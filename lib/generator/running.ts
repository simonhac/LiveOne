import type { LatestPointValues } from "@/lib/types/api";
import { runningPathForRole } from "@/lib/run-tracking/running-point";

/**
 * Whether a tracked device is ON right now, read from the generic `/api/data` latest map (the
 * derived `<role stem>/running` point the run-tracking cron publishes — value 1/0). Returns
 * undefined when that point isn't present, so callers can fall back to the run-periods response's
 * open-period flag. Mirrors how every other live card reads the latest map.
 *
 * Role-keyed rather than generator-only because `publishRunningLatest` has always published one
 * point per enabled detector — `source.generator/running` for the genset, `ev/running` for the EV
 * charge detector. The path comes from the ROLE REGISTRY's stem, so a new trackable role needs no
 * change here.
 */
export function runningFromLatest(
  latest: LatestPointValues | null | undefined,
  role: string,
): boolean | undefined {
  const path = runningPathForRole(role);
  if (!path) return undefined;
  const p = latest?.[path];
  if (!p || p.value == null) return undefined;
  return p.value > 0;
}
