import { kv } from "./kv";
import {
  areaSubject,
  latestValuesKey,
  subscriptionsKey,
  subscriptionsKeyPattern,
  type KvSubject,
} from "./kv-keys";
import {
  kvDeviceSubjectForHandle,
  kvSourceSubjectForHandle,
} from "./kv-subjects";
import { Area, Device, Point, type AreaId, type DeviceId } from "@/lib/ids";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  getLatestValues,
  getLatestValuesForSubject,
  LatestValue,
  LatestValuesMap,
} from "./latest-values-store";
import { getAreaBindings } from "@/lib/areas/bindings";
import { getAreaMemberPointsForServing } from "@/lib/areas/members";
import { isDisplayDerivedHere } from "@/lib/areas/derived-display-paths";

// Re-export canonical types for backwards compatibility
export type { LatestValue, LatestValuesMap };
// The single reader of the latest-values hash lives in `latest-values-store`; re-exported here so the
// propagation writer and its reader can still be imported from one place.
export { getLatestValues, getLatestValuesForSubject };

/**
 * @deprecated Use LatestValue instead
 */
export type LatestPointValue = LatestValue;

/**
 * @deprecated Use LatestValuesMap instead
 */
export type LatestPointValues = LatestValuesMap;

/**
 * Subscription registry entry - maps source point to subscriber points that subscribe to it
 */
export interface SubscriptionRegistryEntry {
  /**
   * Map of source point uuid to the `ar_` TypeIDs of the Areas that subscribe to it.
   *
   * Key: `points.id` (canonical uuid) — NOT the integer point index. Config-v4 slice E PR 2b re-keyed
   * this map when `area_bindings` lost its `(point_system_id, point_id)` pair.
   *
   * Value: SUBSCRIBER Area TypeIDs. **config-v4 Phase 13 PR 3 retired the `"{areaHandle}.{ordinal}"`
   * ref grammar**: the handle half is now the Area's own `ar_` TypeID (the `latest:area:{ar_…}` key it
   * selects), and the ordinal half is gone because it was already vestigial — nothing ever read it (a
   * subscriber's latest hash is keyed by logicalPath), and both consumers only ever `.split(".")[0]`'d
   * it back off. Dropping it also means the `Set` dedupes per (source point, Area) instead of per
   * binding slot, which is what the fan-out actually wants.
   *
   * Example: { "0199…-…": ["ar_01k9…", "ar_01ka…"] }
   *
   * ⚠️ PERSISTED. An entry written by an older build holds `"13.0"`-shaped refs, which
   * `Area.parse` rejects — so a stale entry degrades to "no subscribers" rather than mis-routing.
   * Re-running {@link buildSubscriptionRegistry} is a REQUIRED deploy step for this keyspace change.
   */
  pointSubscribers: Record<string, string[]>;
  lastUpdatedTimeMs: number; // Unix timestamp in milliseconds when registry was last updated
}

/**
 * Update the latest value for a point in a system's cache
 * Also updates all subscriber systems that subscribe to this specific point
 *
 * @param systemId - Source device handle. Resolved HERE to its `dv_` subject for the
 *                   `latest:device:{dv_…}` hash key (config-v4 Phase 13 PR 3 — the interior stays
 *                   handle-keyed, which is why none of the six writers changed), and stored verbatim
 *                   as `sourceSystemId`
 * @param pointUid - Source point's `point_info.point_uid` — the subscription-map lookup key AND, as a
 *                   `pt_` TypeID, the stored `pointReference`
 * @param pointPath - Point path string (e.g., "source.solar.local/power")
 * @param value - Latest value (numeric or string for text/json types)
 * @param measurementTimeMs - Unix timestamp in milliseconds when value was measured
 * @param receivedTimeMs - Unix timestamp in milliseconds when value was received from vendor
 * @param metricUnit - Unit of measurement (e.g., "W", "kWh", "%", "text", "json")
 * @param displayName - Display name from point_info
 * @param _sourceSystemName - DEPRECATED: no longer stored (`sourceSystemId` identifies the source)
 * @param sessionId - Session ID that wrote this value
 * @param sessionLabel - Session label/name for display
 */
export async function updateLatestPointValue(
  systemId: number,
  pointUid: string,
  pointPath: string,
  value: number | string | null,
  measurementTimeMs: number,
  receivedTimeMs: number,
  metricUnit: string,
  displayName: string,
  _sourceSystemName?: string,
  sessionId?: string,
  sessionLabel?: string,
): Promise<void> {
  const pointValue: LatestValue = {
    value,
    logicalPath: pointPath,
    measurementTimeMs,
    receivedTimeMs,
    metricUnit,
    displayName,
    // config-v4 pre-terminal prep: `pointReference` was `"{systemId}.{pointIndex}"`. Its index half
    // came from `point_info.index`, which `points` has no counterpart to, so the terminal drop would
    // have made the value unreproducible. It is now the point's `pt_` TypeID — the locked public ID
    // scheme, not a second bespoke grammar — and the source DEVICE, the only fact any consumer
    // actually derived from the old string, moves to its own field. The two grammars are mutually
    // unambiguous (`pt_…` vs `"9.7"`), so a stale KV entry written by an older build can never be
    // mis-parsed as the new one; it simply reads as absent.
    pointReference: Point.encode(pointUid),
    sourceSystemId: systemId,
    ...(sessionId && { sessionId }),
    ...(sessionLabel && { sessionLabel }),
  };

  // Update the SOURCE's own hash. A reading's point always belongs to a device (`points.device_id` is
  // NOT NULL and FK-backed), so this is the device leg; the area fallback inside
  // `kvSourceSubjectForHandle` only guards a handle that names no device at all.
  const source = await kvSourceSubjectForHandle(systemId);
  if (!source) {
    // Unknown handle: no `legacy_handles` row, so there is no key to write. Before PR 3 this wrote
    // `latest:system:N` for an id nothing could serve. Log rather than throw — a KV cache failure must
    // never break reading insertion (point-manager catches, but the other five writers do not).
    console.warn(
      `[KV] updateLatestPointValue: handle ${systemId} resolves to no device or area — skipping`,
    );
    return;
  }
  await kv.hset(latestValuesKey(source), { [pointPath]: pointValue });

  // Look up the Areas that subscribe to this specific source point
  const subscriberAreaIds = await getPointSubscribers(systemId, pointUid);

  // Update each subscriber Area's cache (only for subscribed points). One hset per Area; the refs are
  // already deduped per Area by the registry, so no grouping pass is needed any more.
  if (subscriberAreaIds.length > 0) {
    await Promise.all(
      subscriberAreaIds.map((areaId) =>
        kv.hset(latestValuesKey(areaSubject(areaId)), {
          [pointPath]: pointValue,
        }),
      ),
    );
  }
}

/**
 * The Areas subscribing to one source point.
 *
 * @param sourceSystemId - Source device handle (selects the `subscriptions:device:{dv_…}` KV entry)
 * @param sourcePointUid - Source point's `points.id`
 * @returns Subscriber Area TypeIDs. A ref written by a pre-PR-3 build (`"13.0"`) fails `Area.parse`
 *          and is dropped, so a stale entry reads as "no subscribers" rather than mis-routing a value
 *          into another entity's hash.
 */
async function getPointSubscribers(
  sourceSystemId: number,
  sourcePointUid: string,
): Promise<AreaId[]> {
  const device = await kvDeviceSubjectForHandle(sourceSystemId);
  if (!device) return [];
  const entry = await kv.get<SubscriptionRegistryEntry>(
    subscriptionsKey(device.id),
  );

  const refs = entry?.pointSubscribers?.[sourcePointUid];
  if (!refs) return [];

  const out: AreaId[] = [];
  for (const ref of refs) {
    if (Area.is(ref)) out.push(ref);
    else
      console.warn(
        `[KV] subscription ref "${ref}" is not an ar_ TypeID (pre-PR-3 entry) — ignoring; rebuild the registry`,
      );
  }
  return out;
}

/**
 * Build the subscription registry for all subscriber systems
 * This creates a reverse mapping: source point → subscriber points that subscribe to it
 *
 * Is called:
 * - When subscriber area membership / bindings / metadata change (`refreshAreaServing`)
 * - When an ingest batch or a derived-point writer mints a point
 *   (`refreshServingForMintedPoints`)
 * - Daily, as a safety net, from `/api/cron/daily`'s aggregate path
 */
/** What a rebuild derived — returned to callers that want to report it (the admin route does). */
export interface SubscriptionRegistrySummary {
  sourceDevices: number;
  edges: number;
  contested: ContestedServingPath[];
  gcDeletedFields: number;
  /** Unbound member points withheld because the display layer derives their path. */
  suppressed: SuppressedServingPath[];
  servedPathsByArea: Record<string, string[]>;
}

/**
 * Set when a mint-triggered rebuild threw; cleared by the next successful one. Module-level, so it
 * survives across ingest batches within a warm lambda — see `refreshServingForMintedPoints`.
 */
let servingRebuildPending = false;

/**
 * Insert one (source point → subscriber Area) edge into the reverse-subscription map. The map is
 * `sourceDeviceId → sourcePointUid → subscriberAreaIds` — all three uuid/TypeID since config-v4
 * Phase 13 PR 3 (the outer key was the source device's integer handle, because it WAS the KV key).
 */
function addSubscription(
  subscriptions: Map<DeviceId, Map<string, Set<AreaId>>>,
  sourceDeviceId: DeviceId,
  sourcePointUid: string,
  subscriberAreaId: AreaId,
): void {
  if (!subscriptions.has(sourceDeviceId)) {
    subscriptions.set(sourceDeviceId, new Map());
  }
  const sourceDeviceMap = subscriptions.get(sourceDeviceId)!;
  if (!sourceDeviceMap.has(sourcePointUid)) {
    sourceDeviceMap.set(sourcePointUid, new Set());
  }
  sourceDeviceMap.get(sourcePointUid)!.add(subscriberAreaId);
}

/** An unbound member point excluded from serving because another point claims the same path. */
/**
 * An unbound member point withheld because {@link DISPLAY_DERIVED_PATHS} covers its path — the
 * display layer computes that value, so serving a raw one would retire the computation silently.
 * Reported, never merely dropped: a deliberately excluded point is fine, an invisible one is not.
 */
export interface SuppressedServingPath {
  areaId: AreaId;
  /** The latest-hash field name the display layer derives: `stem/metricType`. */
  path: string;
  /** `points.rid` of the point that was withheld. */
  pointRid: number;
}

export interface ContestedServingPath {
  areaId: AreaId;
  /** The latest-hash field name the contenders would have fought over: `stem/metricType`. */
  path: string;
  /** `points.rid` of every contender (bound and unbound), ascending. */
  pointRids: number[];
}

/** What one registry rebuild derived, for logging, the admin route, and the area-hash GC. */
export interface SubscriptionRegistryBuild {
  subscriptions: Map<DeviceId, Map<string, Set<AreaId>>>;
  contested: ContestedServingPath[];
  /** Unbound candidates withheld because the display layer derives the path. */
  suppressed: SuppressedServingPath[];
  /** Per subscriber Area, the latest-hash field names its serving set legitimately covers. */
  servedPathsByArea: Map<AreaId, Set<string>>;
}

/** One candidate point for one Area, from either leg, normalised for classification. */
interface ServingCandidate {
  sourceDeviceId: string;
  pointUid: string;
  pointRid: number;
  /** `null` for a stemless point: it has no latest-hash field, so it claims no path. */
  path: string | null;
  bound: boolean;
}

/**
 * Reverse-subscription map (source point → subscribing Areas), plus the diagnostics a rebuild
 * produces. Two legs, unioned per Area:
 *
 * 1. **bound** — every `area_bindings` row yields an edge, unconditionally and exactly as before.
 *    Bindings are role resolution; their fan-out behaviour is untouched.
 * 2. **member** — every member device's own points, served only when the point's
 *    `logicalPath/metricType` is claimed by nothing else in that Area.
 *
 * Leg 2 used to fire only for Areas with ZERO bindings, which made bindings a *visibility filter*
 * frozen at authoring time: a point minted later on an already-member device joined nothing and never
 * reached the Area's latest map (the 2026-08-04 EV-control incident). Serving the uniquely-pathed
 * remainder fixes that class mechanically.
 *
 * The uniqueness test is not conservatism for its own sake — the latest hash is keyed by
 * `logicalPath/metricType`, so two member points sharing a path would make the Area's value for it
 * flap last-write-wins between two physical devices. That ambiguity is exactly what bindings exist to
 * curate, so a contested path is excluded — but **loudly**: it is returned here and warned by the
 * caller, never dropped in silence.
 */
async function buildSubscriptionsFromBindings(): Promise<SubscriptionRegistryBuild> {
  // Gather both legs per Area first: classification is a whole-Area decision, not a per-row one.
  const byArea = new Map<string, Map<string, ServingCandidate>>();
  const candidatesFor = (areaId: string) => {
    let m = byArea.get(areaId);
    if (!m) byArea.set(areaId, (m = new Map()));
    return m;
  };

  for (const b of await getAreaBindings()) {
    // A bound point wins the dedupe: it is served regardless of contention, so `bound` must not be
    // downgraded if the same point also arrives via the member leg.
    candidatesFor(b.areaId).set(b.pointUid, {
      sourceDeviceId: b.sourceDeviceId,
      pointUid: b.pointUid,
      pointRid: b.pointRid,
      path: b.logicalPath ? `${b.logicalPath}/${b.metricType}` : null,
      bound: true,
    });
  }
  for (const m of await getAreaMemberPointsForServing()) {
    const c = candidatesFor(m.areaId);
    // The same point being BOTH bound and a member is the normal case; it must stay one candidate,
    // or it would look like two claimants of its own path and contest itself out of existence.
    if (c.has(m.pointUid)) continue;
    c.set(m.pointUid, {
      sourceDeviceId: m.sourceDeviceId,
      pointUid: m.pointUid,
      pointRid: m.pointRid,
      path: `${m.logicalPath}/${m.metricType}`,
      bound: false,
    });
  }

  const subscriptions = new Map<DeviceId, Map<string, Set<AreaId>>>();
  const contested: ContestedServingPath[] = [];
  const suppressed: SuppressedServingPath[] = [];
  const servedPathsByArea = new Map<AreaId, Set<string>>();

  for (const [areaUuid, candidates] of byArea) {
    const areaId = Area.encode(areaUuid);
    const served = new Set<string>();
    servedPathsByArea.set(areaId, served);

    // The Area's BOUND paths — the inputs the display layer would derive FROM. A derived path is
    // withheld from the unbound leg only when at least one of its inputs is bound here, i.e. only
    // when the computation is genuinely happening (see isDisplayDerivedHere). A binding-less Area,
    // or one whose bindings are unrelated, derives nothing and keeps its member's own points.
    const boundPaths = new Set<string>();
    for (const c of candidates.values()) {
      if (c.bound && c.path !== null) boundPaths.add(c.path);
    }

    // Claimants per path. A stemless point claims nothing (`path === null`).
    const claimants = new Map<string, ServingCandidate[]>();
    for (const c of candidates.values()) {
      if (c.path === null) continue;
      const list = claimants.get(c.path);
      if (list) list.push(c);
      else claimants.set(c.path, [c]);
    }

    for (const c of candidates.values()) {
      if (!c.bound && c.path !== null && claimants.get(c.path)!.length > 1) {
        continue; // contested — reported below, once per path
      }
      // The display layer computes this path for itself, and prefers a real point over its own
      // fallback — so serving one here would silently RETIRE a computation rather than add a
      // signal. Suppressed for the mechanical leg only: a binding still wins (it never reaches
      // this branch), which is what makes moving a headline onto another device a decision rather
      // than a drift. See lib/areas/derived-display-paths.ts for the measured rationale.
      if (
        !c.bound &&
        c.path !== null &&
        isDisplayDerivedHere(c.path, boundPaths)
      ) {
        suppressed.push({ areaId, path: c.path, pointRid: c.pointRid });
        continue;
      }
      addSubscription(
        subscriptions,
        Device.encode(c.sourceDeviceId),
        c.pointUid,
        areaId,
      );
      if (c.path !== null) served.add(c.path);
    }

    for (const [path, list] of claimants) {
      if (list.length > 1 && list.some((c) => !c.bound)) {
        contested.push({
          areaId,
          path,
          pointRids: list.map((c) => c.pointRid).sort((a, b) => a - b),
        });
      }
    }
  }

  return { subscriptions, contested, suppressed, servedPathsByArea };
}

/**
 * Delete latest-hash fields an Area no longer serves.
 *
 * Without this a value that LEAVES the serving set (a unique path turning contested when a second
 * member device starts posting it; a binding removed) freezes at its last written value forever —
 * the hash is only ever `hset`. That is worse than absence for a control point: `pointReference`
 * stays valid and reads no `measurementTime`, so Start/Stop would keep rendering enabled against
 * arbitrarily stale state. Removing the field makes the exit visible: the tile hides, the control
 * disables.
 *
 * Scope, deliberately narrow: only Areas present in this rebuild are swept (an Area with no
 * candidates at all keeps whatever its hash holds), and a fan-out write racing the rebuild on the old
 * snapshot can re-add a field until the next rebuild — the registry has always been
 * snapshot-consistent rather than transactional.
 */
async function gcAreaLatestFields(
  servedPathsByArea: Map<AreaId, Set<string>>,
): Promise<number> {
  let deleted = 0;
  for (const [areaId, served] of servedPathsByArea) {
    const key = latestValuesKey(areaSubject(areaId));
    const fields: string[] = (await kv.hkeys(key)) ?? [];
    const stale = fields.filter((f) => !served.has(f));
    if (stale.length === 0) continue;
    await kv.hdel(key, ...stale);
    deleted += stale.length;
    console.log(
      `[SubscriptionRegistry] GC ${areaId}: dropped ${stale.length} unserved latest field(s): ${stale.join(", ")}`,
    );
  }
  return deleted;
}

/**
 * Rebuild the whole subscription registry from SQL: source point → the Areas that subscribe to it.
 *
 * 🛑 **This is a REQUIRED DEPLOY STEP for config-v4 Phase 13 PR 3**, on every environment. The keyspace
 * moved (`subscriptions:system:{int}` → `subscriptions:device:{dv_…}`) *and* so did the ref grammar
 * (`"{areaHandle}.{ordinal}"` → `ar_…`). Entries written by an older build are invisible under the new
 * key pattern, so until this runs there are no subscribers at all and every multi-device Area's `latest`
 * map goes stale. (It has been a required step once before, for slice E PR 2b, which re-keyed the map's
 * inner key from the integer point index to the point uuid.)
 *
 * Called automatically by `refreshAreaServing` on every area/binding mutation, by
 * `refreshServingForMintedPoints` whenever an ingest batch mints a point, and by the daily cron as a
 * backstop; run by hand with `npx tsx scripts/build-subscription-registry.ts`, or via
 * `GET /api/devices/subscriptions?action=build`.
 */
export async function buildSubscriptionRegistry(): Promise<SubscriptionRegistrySummary> {
  // Example: { "dv_01k9…": { "0199a1…": ["ar_01ka…", "ar_01kb…"] } }
  const { subscriptions, contested, suppressed, servedPathsByArea } =
    await buildSubscriptionsFromBindings();

  // Write subscriptions to KV with timestamp
  const now = Date.now();
  const validKeys = new Set<string>();
  const updates: Promise<unknown>[] = [];
  let edges = 0;

  for (const [sourceDeviceId, pointMap] of subscriptions.entries()) {
    const key = subscriptionsKey(sourceDeviceId);
    validKeys.add(key);

    // Convert Map<string, Set<AreaId>> to Record<string, string[]>
    const pointSubscribers: Record<string, string[]> = {};
    for (const [pointUid, subscriberAreaIds] of pointMap.entries()) {
      pointSubscribers[pointUid] = Array.from(subscriberAreaIds);
      edges += subscriberAreaIds.size;
    }

    const entry: SubscriptionRegistryEntry = {
      pointSubscribers,
      lastUpdatedTimeMs: now,
    };
    updates.push(kv.set(key, entry));
  }

  // Delete stale entries: any key matching the family pattern that this rebuild did not write. Compared
  // as WHOLE KEY STRINGS — the old code parsed the id back out with `/subscriptions:system:(\d+)$/`,
  // a regex that cannot match a TypeID and would have silently stopped collecting garbage.
  const existingKeys = await kv.keys(subscriptionsKeyPattern());
  const deletions: Promise<unknown>[] = [];
  for (const existingKey of existingKeys) {
    if (validKeys.has(existingKey)) continue;
    console.log(
      `[SubscriptionRegistry] Deleting stale subscription key ${existingKey}`,
    );
    deletions.push(kv.del(existingKey));
  }

  await Promise.all([...updates, ...deletions]);

  // Sweep area hashes AFTER the registry is written, so a value that just left the serving set cannot
  // be re-added by a fan-out still reading the old snapshot in the same instant.
  const gcDeletedFields = await gcAreaLatestFields(servedPathsByArea);

  for (const sp of suppressed) {
    console.warn(
      `[SubscriptionRegistry] area ${sp.areaId}: "${sp.path}" (rid ${sp.pointRid}) is DERIVED by the display layer — not auto-served, so a raw point cannot silently retire the computation; bind it to override`,
    );
  }

  for (const c of contested) {
    console.warn(
      `[SubscriptionRegistry] area ${c.areaId}: "${c.path}" is claimed by ${c.pointRids.length} points (rids ${c.pointRids.join(", ")}) — not auto-served; bind one of them to pick a winner`,
    );
  }

  console.log(
    `Built subscription registry for ${subscriptions.size} source device(s), ${edges} edge(s) (deleted ${deletions.length} stale entries, ${contested.length} contested path(s), ${suppressed.length} display-derived path(s) withheld, GC'd ${gcDeletedFields} area field(s))`,
  );

  return {
    sourceDevices: subscriptions.size,
    edges,
    contested,
    suppressed,
    gcDeletedFields,
    servedPathsByArea: Object.fromEntries(
      Array.from(servedPathsByArea, ([areaId, paths]) => [
        areaId,
        Array.from(paths).sort(),
      ]),
    ),
  };
}

/**
 * Rebuild the serving registry because an ingest batch minted at least one point.
 *
 * Best-effort by construction — the same never-break-ingest stance as `refreshAreaServing`. But a
 * swallowed failure here would re-create exactly the defect this closes (the point stays invisible),
 * so a failure raises a module-level dirty flag: the next batch rebuilds even if it minted nothing.
 * A lambda recycle can still lose that flag, which is what the daily-cron backstop bounds at ≤ 24 h.
 */
export async function refreshServingForMintedPoints(
  context: string,
): Promise<void> {
  try {
    await buildSubscriptionRegistry();
    servingRebuildPending = false;
  } catch (err) {
    servingRebuildPending = true;
    console.warn(
      `[KV] refreshServingForMintedPoints(${context}) failed — newly minted points may be missing from area serving; will retry on the next batch:`,
      err,
    );
  }
}

/** True when a `refreshServingForMintedPoints` call failed and no later one has succeeded. */
export function isServingRebuildPending(): boolean {
  return servingRebuildPending;
}

/** Test-only: reset the retry flag between cases. */
export function __resetServingRebuildPending(): void {
  servingRebuildPending = false;
}

/**
 * Invalidate the subscription registry for a specific system or all systems
 *
 * @param systemId - Optional system ID. If provided, only that system's subscriptions are cleared.
 *                   If omitted, all subscription keys are deleted (requires rebuild).
 */
export async function invalidateSubscriptionRegistry(
  systemId?: number,
): Promise<void> {
  if (systemId) {
    // Delete the specific source device's entry (the registry is device-keyed).
    const device = await kvDeviceSubjectForHandle(systemId);
    if (device) await kv.del(subscriptionsKey(device.id));
  } else {
    // Delete all subscription keys
    // Note: This requires scanning all keys with the family pattern.
    // In practice, it's better to just rebuild the registry
    console.warn(
      "Full subscription registry invalidation requested - rebuilding is recommended",
    );
    await buildSubscriptionRegistry();
  }
}
