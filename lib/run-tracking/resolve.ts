/**
 * Resolve `device_trackers` rows into the concrete config the recompute + API need: which point
 * carries the run signal, which (optional) point carries energy, the effective detector params
 * (per-instance columns merged with per-role code defaults), and the system's timezone.
 *
 * Point refs use a plain {systemId, pointId} shape (NOT the PointReference class, which rejects
 * pointId 0 — point_info indexes start at 0). For a composite the signal point belongs to a CHILD
 * system, so signalSystemId may differ from the tracker's logical systemId.
 */
import { eq, and } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { deviceTrackers } from "@/lib/db/planetscale/schema";
import { SystemsManager } from "@/lib/systems-manager";
import { detectorDefaultsForRole } from "./defaults";

export interface PointRef {
  systemId: number;
  pointId: number;
}

export interface ResolvedTracker {
  id: string;
  systemId: number; // logical system
  role: string;
  displayName: string;
  signalRef: PointRef;
  energyRef: PointRef | null;
  detect: {
    lowerW: number | null;
    upperW: number | null;
    hysteresisW: number;
    delayOnMs: number;
    delayOffMs: number;
    boundaryMode: "edge" | "midpoint";
  };
  detectorVersion: number;
  timezoneOffsetMin: number;
  displayTimezone: string;
}

type TrackerRow = typeof deviceTrackers.$inferSelect;

async function resolve(row: TrackerRow): Promise<ResolvedTracker | null> {
  const system = await SystemsManager.getInstance().getSystem(row.systemId);
  if (!system) {
    console.warn(
      `[RunTracking] tracker ${row.id}: system ${row.systemId} not found — skipping`,
    );
    return null;
  }
  const defaults = detectorDefaultsForRole(row.role);
  return {
    id: row.id,
    systemId: row.systemId,
    role: row.role,
    displayName: row.displayName,
    signalRef: { systemId: row.signalSystemId, pointId: row.signalPointId },
    energyRef:
      row.energySystemId != null && row.energyPointId != null
        ? { systemId: row.energySystemId, pointId: row.energyPointId }
        : null,
    detect: {
      lowerW: row.lowerW,
      upperW: row.upperW,
      hysteresisW: row.hysteresisW ?? defaults.hysteresisW,
      delayOnMs:
        row.delayOnSeconds != null
          ? row.delayOnSeconds * 1000
          : defaults.delayOnMs,
      delayOffMs:
        row.delayOffSeconds != null
          ? row.delayOffSeconds * 1000
          : defaults.delayOffMs,
      boundaryMode: defaults.boundaryMode,
    },
    detectorVersion: row.detectorVersion,
    timezoneOffsetMin: system.timezoneOffsetMin,
    displayTimezone: system.displayTimezone,
  };
}

/** All enabled trackers, resolved. Unresolvable trackers (missing system) are dropped. */
export async function listEnabledTrackers(): Promise<ResolvedTracker[]> {
  const rows = await requirePlanetscaleDb()
    .select()
    .from(deviceTrackers)
    .where(eq(deviceTrackers.enabled, true));
  const resolved = await Promise.all(rows.map(resolve));
  return resolved.filter((t): t is ResolvedTracker => t !== null);
}

/** The enabled tracker for a (system, role), or null. */
export async function getTrackerForSystemRole(
  systemId: number,
  role: string,
): Promise<ResolvedTracker | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(deviceTrackers)
    .where(
      and(
        eq(deviceTrackers.systemId, systemId),
        eq(deviceTrackers.role, role),
        eq(deviceTrackers.enabled, true),
      ),
    )
    .limit(1);
  return row ? resolve(row) : null;
}
