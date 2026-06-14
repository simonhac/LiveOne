import type { LatestPointValues } from "@/lib/types/api";
import { runningPathForRole } from "@/lib/run-tracking/running-point";

/** Latest-map logical path of the generator's derived running state (`source.generator/running`). */
export const GENERATOR_RUNNING_PATH = runningPathForRole("generator") as string;

/**
 * Whether the generator is running right now, read from the generic `/api/data` latest map (the
 * derived `source.generator/running` point the run-tracking cron publishes — value 1/0). Returns
 * undefined when that point isn't present, so callers can fall back to the run-periods open-period
 * flag. Mirrors how every other live card reads the latest map; see [[run-tracking-feature]].
 */
export function generatorRunningFromLatest(
  latest: LatestPointValues | null | undefined,
): boolean | undefined {
  const p = latest?.[GENERATOR_RUNNING_PATH];
  if (!p || p.value == null) return undefined;
  return p.value > 0;
}
