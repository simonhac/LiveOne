/**
 * config-v4 Phase 12 slice M — the ONE place a point is born.
 *
 * ## The inversion
 *
 * `points` is now PRIMARY and `point_info` the write-behind copy (until slice N drops it). Identity is
 * allocated by `points.rid`'s own `DEFAULT nextval('point_rid_seq')` — the default migration 0043 created
 * for exactly this moment and which was inert until now. `point_info.rid` draws from the SAME sequence,
 * so the `points.rid == point_info.rid` invariant is structural, not copied.
 *
 * `point_info.index` (column `id`, half the composite PK, NOT NULL) is set to **`rid`**: globally unique,
 * monotonic, satisfies the PK and `pi_rid_unique`, and passes `PointReference.fromIds`' `> 0` check. That
 * kills the `max(index)+1` scan **and its race** outright — there were FOUR such allocators before this
 * (point-manager, hws/register, battery-provenance/register, run-tracking/running-latest) and three of
 * them never mirrored at all, so each was a live C7 hole (a `point_info` row with no `points` row, whose
 * first reading fails `FK point_rid → points(rid)` and becomes a QStash poison pill retried forever).
 *
 * Consequence: new `point_info.index` values are sequence-scale (~1000s), not per-system 1..N. Every
 * consumer treats the index as an opaque positive int.
 *
 * ## Shape (one transaction)
 *
 *   ensureDeviceRow → upsert `points` (allocates id + rid) → upsert `point_info` (index = rid = points.rid,
 *   point_uid = points.id) → `mirrorPoint` to reconcile the descriptive columns.
 *
 * The trailing `mirrorPoint` matters when a `point_info` row already existed with user-customised
 * `display_name`: the `point_info` upsert deliberately does not overwrite it, so `points` is brought back
 * to whatever `point_info` actually holds rather than to what this caller proposed. It is also the single
 * mapper (`toMirrorPointInput`) that makes a future mirrored column a compile error in one place.
 *
 * ## Collision
 *
 * `point_uid` is derived deterministically from (vendor_type, vendor_site_id, physical_path_tail) so
 * re-onboarding the same physical point reproduces the same uid. On the rare duplicate-site collision the
 * mint retries once with a random uid. Inverted, that collision now surfaces on **`points_pkey`** (points
 * is written first), not `pi_point_uid_unique` — {@link isPointUidCollision} matches both.
 *
 * Server-only.
 */
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo, points } from "@/lib/db/planetscale/schema";
import { derivePointUid } from "@/lib/identifiers/point-uid";
import {
  ensureDeviceRow,
  mirrorPoint,
  toMirrorPointInput,
} from "@/lib/registry/point-mirror";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export type PointInfoDbRow = typeof pointInfo.$inferSelect;

/** The descriptive columns a caller supplies; identity (`id`/`rid`/`point_uid`) is minted here. */
export interface MintPointSpec {
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  defaultName: string;
  /** Defaults to `defaultName`. */
  displayName?: string;
  subsystem?: string | null;
  transform?: string | null;
  /** Defaults to true. */
  active?: boolean;
}

/**
 * A unique violation that means "this derived point_uid is already taken by a different point".
 *
 * Matches BOTH constraints: `points_pkey` (the inverted order writes `points` first, so this is the one
 * that fires now) and `pi_point_uid_unique` (the pre-inversion shape, kept so a partially-healed row or a
 * legacy path still retries). A non-uid unique error — e.g. `pi_system_stem_metric_unique` or
 * `points_device_logical_metric_unique` — is deliberately NOT matched and is rethrown unchanged.
 */
export function isPointUidCollision(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; constraint?: unknown; message?: unknown };
  if (err.code !== "23505") return false;
  const names = ["points_pkey", "pi_point_uid_unique"];
  if (typeof err.constraint === "string" && names.includes(err.constraint))
    return true;
  return (
    typeof err.message === "string" &&
    names.some((n) => (err.message as string).includes(n))
  );
}

/** Derive the stable point identity from the system's vendor identity; random uuid if unresolvable. */
async function derivedUidFor(
  systemId: number,
  physicalPathTail: string,
): Promise<string> {
  const sys = await DeviceConfigRegistry.deviceByHandle(systemId);
  return sys
    ? derivePointUid(sys.vendorType, sys.vendorSiteId, physicalPathTail)
    : uuidv7(); // no vendor identity to derive from → random uid (point_uid is NOT NULL)
}

/**
 * Mint (or return) the point for `(systemId, spec.physicalPathTail)`, writing `points` first and
 * `point_info` behind it, in one transaction. Idempotent.
 *
 * @returns the `point_info` row (the shape every existing caller already consumes).
 */
export async function mintPoint(
  systemId: number,
  spec: MintPointSpec,
): Promise<PointInfoDbRow> {
  const db = requirePlanetscaleDb();
  const displayName = spec.displayName ?? spec.defaultName;
  const subsystem = spec.subsystem ?? null;
  const transform = spec.transform ?? null;
  const active = spec.active ?? true;
  const now = new Date();

  const doMint = async (pointUid: string): Promise<PointInfoDbRow> =>
    db.transaction(async (tx) => {
      const deviceId = await ensureDeviceRow(systemId, tx);

      // PRIMARY write: `points` allocates BOTH identities — `id` (the uid) and `rid` (from its own
      // sequence DEFAULT). DO UPDATE rather than DO NOTHING so the existing row is RETURNED on conflict.
      // `rid`, `device_id` and `id` are identity and are never overwritten here.
      const [pt] = await tx
        .insert(points)
        .values({
          id: pointUid,
          deviceId,
          physicalPath: spec.physicalPathTail,
          logicalPath: spec.logicalPathStem,
          metricType: spec.metricType,
          unit: spec.metricUnit,
          name: displayName,
          defaultName: spec.defaultName,
          subsystem,
          transform,
          active,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [points.deviceId, points.physicalPath],
          set: { defaultName: spec.defaultName, transform, updatedAt: now },
        })
        .returning({ id: points.id, rid: points.rid });

      // WRITE-BEHIND: `point_info` takes its identity verbatim from `points`. index == rid, so there is
      // no allocator and no read-then-write race. Identity columns are never touched on conflict.
      const [pi] = await tx
        .insert(pointInfo)
        .values({
          systemId,
          index: pt.rid,
          rid: pt.rid,
          pointUid: pt.id,
          physicalPathTail: spec.physicalPathTail,
          logicalPathStem: spec.logicalPathStem,
          metricType: spec.metricType,
          metricUnit: spec.metricUnit,
          defaultName: spec.defaultName,
          displayName,
          subsystem,
          transform,
          active,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [pointInfo.systemId, pointInfo.physicalPathTail],
          set: {
            defaultName: spec.defaultName,
            transform,
            updatedAt: now,
            // id/rid/point_uid are identity — deliberately NOT overwritten.
          },
        })
        .returning();

      // Reconcile `points`' descriptive columns to what `point_info` actually holds (a pre-existing row
      // may carry a user-customised display_name the upsert above deliberately preserved).
      await mirrorPoint(toMirrorPointInput(pi), tx);

      return pi;
    });

  const derived = await derivedUidFor(systemId, spec.physicalPathTail);
  try {
    return await doMint(derived);
  } catch (e) {
    if (!isPointUidCollision(e)) throw e;
    const randomUid = uuidv7();
    console.warn(
      `[mintPoint] point_uid collision for system ${systemId} "${spec.physicalPathTail}" — using random uid ${randomUid}`,
    );
    return await doMint(randomUid);
  }
}

/**
 * Look up an existing point by `(systemId, logicalPathStem, metricType)` — the address the derived-point
 * writers (HWS, battery-provenance, run-tracking) use to decide whether to mint.
 */
export async function findPointByStemMetric(
  systemId: number,
  logicalPathStem: string,
  metricType: string,
): Promise<PointInfoDbRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(pointInfo)
    .where(
      and(
        eq(pointInfo.systemId, systemId),
        eq(pointInfo.logicalPathStem, logicalPathStem),
        eq(pointInfo.metricType, metricType),
      ),
    )
    .limit(1);
  return row ?? null;
}
