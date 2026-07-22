/**
 * Mint the stable point IDENTITY (point_uid) for a point being created, from its system's vendor
 * identity — the same deterministic uuidv5 derivation ensurePointInfo uses (see
 * lib/identifiers/point-uid.ts), so re-onboarding / re-registering the same physical point reproduces
 * the same uid. Falls back to a random uuidv7 only when the system can't be resolved (no vendor
 * identity to derive from).
 *
 * Shared by every point_info writer so none inserts a NULL point_uid — required once migration 0030
 * makes point_info.point_uid NOT NULL (config-v4 Phase 2). Callers using onConflictDoUpdate must NOT
 * overwrite point_uid on conflict (it is identity), matching ensurePointInfo.
 *
 * Server-only (derivePointUid uses node:crypto; SystemsManager hits the DB) — do not import on the
 * client.
 */
import { derivePointUid } from "@/lib/identifiers/point-uid";
import { SystemsManager } from "@/lib/systems-manager";
import { uuidv7 } from "uuidv7";

export async function mintPointUid(
  systemId: number,
  physicalPathTail: string,
): Promise<string> {
  const sys = await SystemsManager.getInstance().getSystem(systemId);
  return sys
    ? derivePointUid(sys.vendorType, sys.vendorSiteId, physicalPathTail)
    : uuidv7();
}
