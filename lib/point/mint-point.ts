/**
 * config-v4 Phase 12 — the ONE place a point is born.
 *
 * ## The terminal shape
 *
 * `points` is the ONLY point table. Slice M made it primary with `point_info` as a write-behind copy;
 * the terminal window (migration 0051) drops `point_info`, so both the write-behind and the
 * `point_info → points` mirror (`lib/registry/point-mirror.ts`) are gone. Identity is allocated entirely
 * by `points`: `id` is the derived uid, `rid` comes from `points.rid`'s own
 * `DEFAULT nextval('point_rid_seq')`.
 *
 * ## Why the returned shape is still `point_info`-shaped
 *
 * The four callers (`PointManager.ensurePointInfo`, `lib/hws/register`, `lib/battery-provenance/register`,
 * `lib/run-tracking/running-latest`) each consume a handful of named fields. Re-homing the QUERY without
 * re-shaping the RESULT is the same single-seam discipline slice 1b used for the ~20 readers it moved:
 * one mapper here, zero churn (and zero new bug surface) at the call sites. `index` is set to `rid` —
 * the identity every read has served since slice M — and `systemId` is echoed from the argument, since
 * `points` addresses its owner by `device_id`, not by the handle.
 *
 * The `max(index)+1` allocators stay dead. There were FOUR before slice M (point-manager, hws/register,
 * battery-provenance/register, run-tracking/running-latest) and three never mirrored into `points` at
 * all, so each was a live C7 hole (a point row whose first reading fails `FK point_rid → points(rid)`
 * and becomes a QStash poison pill retried forever). Introduce no `max(rid)+1` pattern here: the
 * sequence is the sole allocator.
 *
 * ## Shape (one statement)
 *
 *   resolve device uuid → upsert `points` (allocates id + rid) → project onto the returned row
 *
 * The upsert deliberately does NOT overwrite `name` (the user-customisable display name), `rid`,
 * `device_id` or `id`. It DOES refresh `default_name` + `transform`, exactly as the pre-terminal
 * `point_info` upsert did, so re-minting an existing point still tracks a vendor rename.
 *
 * ## Collision
 *
 * The uid is derived deterministically from (vendor_type, vendor_site_id, physical_path_tail) so
 * re-onboarding the same physical point reproduces the same uid. On the rare duplicate-site collision the
 * mint retries once with a random uid. That collision surfaces on **`points_pkey`**.
 *
 * Server-only.
 */
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { isUniqueViolationOn } from "@/lib/db/pg-error";
import { devices, points } from "@/lib/db/planetscale/schema";
import { derivePointUid } from "@/lib/identifiers/point-uid";
import { DeviceRegistry } from "@/lib/registry/device-registry";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * The point row this module returns — the `point_info`-shaped projection of a `points` row.
 *
 * Named columns, not `typeof points.$inferSelect`, precisely so the mapping is explicit: `index === rid`,
 * and `systemId` is the caller's handle rather than a stored column.
 */
export interface MintedPointRow {
  systemId: number;
  /** `points.rid`. Equal to `rid` — the address every read has served since slice M. */
  index: number;
  rid: number;
  /** `points.id`. */
  pointUid: string;
  physicalPathTail: string;
  logicalPathStem: string | null;
  metricType: string;
  metricUnit: string;
  defaultName: string;
  displayName: string;
  subsystem: string | null;
  transform: string | null;
  active: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** @deprecated `point_info` is gone — use {@link MintedPointRow}. Kept so callers read unchanged. */
export type PointInfoDbRow = MintedPointRow;

/** The descriptive columns a caller supplies; identity (`id`/`rid`) is minted here. */
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

/** Project a `points` row onto the returned shape. The one place the mapping lives. */
function toMintedRow(
  systemId: number,
  row: typeof points.$inferSelect,
): MintedPointRow {
  return {
    systemId,
    index: row.rid,
    rid: row.rid,
    pointUid: row.id,
    physicalPathTail: row.physicalPath,
    logicalPathStem: row.logicalPath,
    metricType: row.metricType,
    metricUnit: row.unit,
    defaultName: row.defaultName,
    displayName: row.name,
    subsystem: row.subsystem,
    transform: row.transform,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A unique violation that means "this derived uid is already taken by a different point".
 *
 * Matches `points_pkey` only — `pi_point_uid_unique` died with `point_info`. A non-uid unique error
 * (e.g. `points_device_logical_metric_unique`) is deliberately NOT matched and is rethrown unchanged.
 *
 * 🛑 config-v4 Phase 14 stage 2b — this is on the LIVE INGEST PATH and it was dead. The predicate read
 * `err.code`, which drizzle ≥0.44 leaves undefined (the `pg` error is on `.cause`), so it returned false
 * on the first line and a derived-uid collision failed the mint hard instead of retrying with a random
 * uuid. The `message.includes("points_pkey")` fallback below it — written precisely because
 * `err.constraint` is unreliable — was therefore UNREACHABLE, which is why nothing caught this: the
 * belt-and-braces line was correct and never ran. Both halves now go through
 * `isUniqueViolationOn` (lib/db/pg-error.ts), which unwraps the cause chain and reads the index name
 * from the `message` when PlanetScale strips `constraint` (always, measured).
 */
export function isPointUidCollision(e: unknown): boolean {
  return isUniqueViolationOn(e, "points_pkey");
}

/** Derive the stable point identity from the device's vendor identity; random uuid if unresolvable. */
async function derivedUidFor(
  systemId: number,
  physicalPathTail: string,
): Promise<string> {
  const sys = await DeviceConfigRegistry.deviceByHandle(systemId);
  return sys
    ? derivePointUid(sys.vendorType, sys.vendorSiteId, physicalPathTail)
    : uuidv7(); // no vendor identity to derive from → random uid (`points.id` is the PK)
}

/**
 * Mint (or return) the point for `(systemId, spec.physicalPathTail)`. Idempotent.
 *
 * @returns the point row, in the shape every existing caller already consumes.
 */
export async function mintPoint(
  systemId: number,
  spec: MintPointSpec,
): Promise<MintedPointRow> {
  const db = requirePlanetscaleDb();
  const displayName = spec.displayName ?? spec.defaultName;
  const subsystem = spec.subsystem ?? null;
  const transform = spec.transform ?? null;
  const active = spec.active ?? true;
  const now = new Date();

  const doMint = async (pointUid: string): Promise<MintedPointRow> => {
    // Slice 1a: resolves the device uuid rather than ensuring it. `devices` is the registry, so minting
    // a point against a handle with no device row is an error — `uuidForRid` throws.
    const deviceId = await DeviceRegistry.uuidForRid(systemId, db);

    // `points` allocates BOTH identities — `id` (the uid) and `rid` (from its own sequence DEFAULT).
    // DO UPDATE rather than DO NOTHING so the existing row is RETURNED on conflict. `rid`, `device_id`,
    // `id` and `name` are never overwritten: the first three are identity, the last is user-owned.
    const [pt] = await db
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
      .returning();

    return toMintedRow(systemId, pt);
  };

  const derived = await derivedUidFor(systemId, spec.physicalPathTail);
  try {
    return await doMint(derived);
  } catch (e) {
    if (!isPointUidCollision(e)) throw e;
    const randomUid = uuidv7();
    console.warn(
      `[mintPoint] uid collision for system ${systemId} "${spec.physicalPathTail}" — using random uid ${randomUid}`,
    );
    return await doMint(randomUid);
  }
}

/**
 * Look up an existing point by `(systemId, logicalPathStem, metricType)` — the address the derived-point
 * writers (HWS, battery-provenance, run-tracking) use to decide whether to mint.
 *
 * Reads `points ⋈ devices`; the `point_info` read died with the table.
 * `points_device_logical_metric_unique` is the direct analogue of the retired
 * `pi_system_stem_metric_unique`, so this stays a single-row lookup.
 */
export async function findPointByStemMetric(
  systemId: number,
  logicalPathStem: string,
  metricType: string,
): Promise<MintedPointRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ points })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, systemId),
        eq(points.logicalPath, logicalPathStem),
        eq(points.metricType, metricType),
      ),
    )
    .limit(1);
  return row ? toMintedRow(systemId, row.points) : null;
}
