/**
 * `point_info` → `points` forward mirror.
 *
 * Relocated VERBATIM from the deleted `lib/registry/v4-mirror.ts` (config-v4 Phase 12 slice 1a), with
 * one substitution: the device uuid now comes from `DeviceRegistry.uuidForRid` — a plain read against
 * `devices` — instead of `ensureDeviceRow`, which resolved it by MIRRORING a `systems` row and so could
 * not outlive that table. `devices` is the registry now, so there is nothing left to ensure: a point
 * whose device has no `devices` row is an error, not something to lazily repair.
 *
 * ## Why it still exists after `devices` became primary
 *
 * `points` is already the primary point table (slice M) and `point_info` is the write-behind copy. The
 * mirror survives only until slice 1b moves every `point_info` READER onto `points`; slice PR 2 then
 * drops the table and this file goes with it. Keeping it means 1a does not have to touch the point
 * path at all — the two conversions stay independently revertible.
 *
 * ## Invariants (unchanged)
 *
 * - `points.id  == point_info.point_uid`  (verbatim)
 * - `points.rid == point_info.rid`        (verbatim — the seam invariant the hot tables depend on)
 *
 * The rid is NEVER re-allocated here: it arrives on the input, read back from the `points` write that
 * owns the `point_rid_seq` default. Allocating a second `nextval` would silently desynchronise them.
 */

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo, points } from "@/lib/db/planetscale/schema";
import { DeviceRegistry, type DeviceRegistryExec } from "./device-registry";

type Exec = DeviceRegistryExec;

/** The `point_info` shape this mirror needs. Matches the row `ensurePointInfo` gets back from its upsert. */
export interface MirrorPointInput {
  systemId: number;
  pointUid: string;
  rid: number;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  displayName: string;
  defaultName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Narrow a `point_info` row to the mirror's input.
 *
 * Shared by BOTH writers — the mint upsert and `updatePoint` — deliberately: when they each built this
 * object inline, only one of them existed, and the edit path silently shipped without a mirror call at
 * all. One mapper means a new mirrored column is a compile error in one place, not a leak in the other.
 */
export function toMirrorPointInput(
  row: typeof pointInfo.$inferSelect,
): MirrorPointInput {
  return {
    systemId: row.systemId,
    pointUid: row.pointUid,
    rid: row.rid,
    physicalPathTail: row.physicalPathTail,
    logicalPathStem: row.logicalPathStem,
    metricType: row.metricType,
    metricUnit: row.metricUnit,
    displayName: row.displayName,
    defaultName: row.defaultName,
    subsystem: row.subsystem,
    transform: row.transform,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mirror one `point_info` row into `points`, preserving `point_uid` as the id and `rid` verbatim.
 *
 * `ON CONFLICT (id) DO UPDATE` on the mutable descriptive columns keeps a renamed/retransformed point in
 * step, but NEVER touches `rid` or `device_id` — those are identity.
 */
export async function mirrorPoint(
  input: MirrorPointInput,
  exec: Exec = requirePlanetscaleDb(),
): Promise<void> {
  const deviceId = await DeviceRegistry.uuidForRid(input.systemId, exec);

  await exec
    .insert(points)
    .values({
      id: input.pointUid,
      rid: input.rid,
      deviceId,
      physicalPath: input.physicalPathTail,
      logicalPath: input.logicalPathStem,
      metricType: input.metricType,
      unit: input.metricUnit,
      name: input.displayName,
      defaultName: input.defaultName,
      subsystem: input.subsystem,
      transform: input.transform,
      active: input.active,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: points.id,
      set: {
        physicalPath: input.physicalPathTail,
        logicalPath: input.logicalPathStem,
        metricType: input.metricType,
        unit: input.metricUnit,
        name: input.displayName,
        defaultName: input.defaultName,
        subsystem: input.subsystem,
        transform: input.transform,
        active: input.active,
        updatedAt: input.updatedAt,
        // rid + device_id are identity — deliberately NOT overwritten.
      },
    });
}
