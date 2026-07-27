/**
 * Live "running now" state for a device — the binary entity's current value, derived from the
 * open (NULL end_time) interval. O(1) via the derived_intervals_open_unique partial index, which
 * also guarantees at most one open row per derivation so the boolean is unambiguous.
 */
import { and, eq, isNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivedIntervals,
  type DerivedInterval,
} from "@/lib/db/planetscale/schema";

/** The open (currently-running) interval for a derivation, or null if not running. */
export async function getOpenRun(
  derivationId: string,
): Promise<DerivedInterval | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(derivedIntervals)
    .where(
      and(
        eq(derivedIntervals.derivationId, derivationId),
        isNull(derivedIntervals.endTime),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Whether the device is running right now. */
export async function isRunningNow(derivationId: string): Promise<boolean> {
  return (await getOpenRun(derivationId)) !== null;
}
