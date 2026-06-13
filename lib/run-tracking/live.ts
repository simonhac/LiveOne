/**
 * Live "running now" state for a device — the binary entity's current value, derived from the
 * open (NULL end_time) run period. O(1) via the drp_open_unique partial index, which also
 * guarantees at most one open row per (system, role) so the boolean is unambiguous.
 */
import { and, eq, isNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  deviceRunPeriods,
  type DeviceRunPeriod,
} from "@/lib/db/planetscale/schema";

/** The open (currently-running) period for a (system, role), or null if not running. */
export async function getOpenRun(
  systemId: number,
  role: string,
): Promise<DeviceRunPeriod | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(deviceRunPeriods)
    .where(
      and(
        eq(deviceRunPeriods.systemId, systemId),
        eq(deviceRunPeriods.role, role),
        isNull(deviceRunPeriods.endTime),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Whether the device is running right now. */
export async function isRunningNow(
  systemId: number,
  role: string,
): Promise<boolean> {
  return (await getOpenRun(systemId, role)) !== null;
}
