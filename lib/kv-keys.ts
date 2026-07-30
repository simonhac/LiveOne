/**
 * The SINGLE OWNER of every KV key string in the latest-values / subscriptions / system-summaries /
 * OE-scheduler families, and of the {@link KvSubject} the new keyspace is addressed by.
 *
 * ## Why this module exists
 *
 * Before it, there were **four key-builder definitions across three files for two key families**:
 *
 * ```
 * lib/kv-cache-manager.ts     latest:system:${systemId}
 * lib/kv-cache-manager.ts     subscriptions:system:${systemId}
 * lib/latest-values-store.ts  latest:system:${systemId}          ← duplicate
 * lib/system-summary-store.ts subscriptions:system:${systemId}   ← duplicate
 * ```
 *
 * A duplicated key builder is a **silent cache split** waiting to happen: change one and miss the
 * other and writes land under the new key while reads come from the old. Nothing errors — the symptom
 * is an empty `latest` map on a dashboard, which looks like "no data yet". `tsc` cannot see it, because
 * both sides still compile and both still return a `string`.
 *
 * So: no module outside this one may build a KV key for these families by string interpolation. If you
 * need a new shape, add it here.
 *
 * ## config-v4 Phase 13 PR 3 — the keyspace is TypeID-native
 *
 * ```
 * latest:system:{int}         →  latest:device:{dv_…}   |  latest:area:{ar_…}
 * subscriptions:system:{int}  →  subscriptions:device:{dv_…}
 * {env}:system-summaries      →  unchanged KEY; every hash FIELD is now a dv_/ar_ TypeID
 * oe:sched:system:{int}       →  oe:sched:device:{dv_…}
 * ```
 *
 * The subscription registry is keyed by **device** only, never by area: its outer key is the *source*
 * of a reading, and every reading's point belongs to a device (`points.device_id` is `NOT NULL` and
 * FK-backed). An area is only ever a *subscriber*.
 *
 * 🛑 **These keys are NOT versioned and KV is disposable.** Renaming a key orphans every entry written
 * by an older build — the old entries do not migrate, they simply stop being read. The keyspace move is
 * therefore a **deploy step** (`buildSubscriptionRegistry` + a latest-values rebuild), never an
 * in-place migration. See `docs/architecture/kv-store.md`.
 */
import { kvKey } from "./kv";
import type { AreaId, DeviceId } from "@/lib/ids";

/**
 * What a KV entry is *about*: a real device, or an Area in its own right. The same discrimination the
 * serving path makes (`lib/dashboard/subject.ts`'s `ServingSubject`) — deliberately a separate, smaller
 * type, because the KV layer needs only the identity, never the row.
 */
export interface KvDeviceSubject {
  kind: "device";
  id: DeviceId;
}
export interface KvAreaSubject {
  kind: "area";
  id: AreaId;
}
export type KvSubject = KvDeviceSubject | KvAreaSubject;

export function deviceSubject(id: DeviceId): KvDeviceSubject {
  return { kind: "device", id };
}

export function areaSubject(id: AreaId): KvAreaSubject {
  return { kind: "area", id };
}

/** Stable ordering/dedupe token for a subject — the TypeID is globally unique across both kinds. */
export function subjectToken(s: KvSubject): string {
  return s.id;
}

// ── latest values (Redis Hash: logicalPath → LatestValue) ────────────────────────────────────────

/** The per-subject latest-values hash. */
export function latestValuesKey(subject: KvSubject): string {
  return kvKey(`latest:${subject.kind}:${subject.id}`);
}

/** SCAN/KEYS pattern covering every latest-values hash in this environment (both kinds). */
export function latestValuesKeyPattern(): string {
  return kvKey("latest:*");
}

// ── subscription registry (Redis JSON: sourcePointUid → subscriber ar_ TypeIDs) ───────────────────

/**
 * The subscription-registry entry for one SOURCE DEVICE. Device-only by construction — see the module
 * header.
 */
export function subscriptionsKey(deviceId: DeviceId): string {
  return kvKey(`subscriptions:device:${deviceId}`);
}

/** SCAN/KEYS pattern covering every subscription-registry entry in this environment. */
export function subscriptionsKeyPattern(): string {
  return kvKey("subscriptions:device:*");
}

// ── system summaries (ONE Redis Hash for the whole environment, field = subject TypeID) ───────────

/** The single environment-wide summaries hash. Its NAME is unchanged; its field names are not. */
export function summariesKey(): string {
  return kvKey("system-summaries");
}

/** The hash FIELD naming one subject inside {@link summariesKey}. */
export function summariesField(subject: KvSubject): string {
  return subject.id;
}

// ── OpenElectricity poll-scheduler EWMA state (Redis JSON) ───────────────────────────────────────

/**
 * Per-device OE arrival-delay scheduler state. Migrated with the rest of the keyspace rather than left
 * behind: the state is *self-seeding* (a miss re-derives `lastSeenIntervalEndMs` from the newest stored
 * interval and falls back to the default delay), so the rename costs at most one mis-timed poll on each
 * of the two OE devices and leaves no integer-addressed key in the store.
 */
export function oeSchedulerStateKey(deviceId: DeviceId): string {
  return kvKey(`oe:sched:device:${deviceId}`);
}
