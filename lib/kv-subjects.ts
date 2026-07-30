/**
 * Integer handle → {@link KvSubject}, the seam between the still-handle-keyed interior and the
 * TypeID-native KV keyspace (config-v4 Phase 13 PR 3).
 *
 * The KV layer's public functions still take the integer handle, exactly as they did before the
 * keyspace moved — that is deliberate, and it is why this PR touches none of the six
 * `updateLatestPointValue` writers. PR 1's scope boundary stands: **the wire and now the KV keyspace are
 * TypeID-native; the interior is not.** The handle is resolved to a subject *here*, at the KV boundary.
 *
 * ## 🛑 A handle names up to TWO subjects, and the read must visit both
 *
 * `legacy_handles` is a two-column compatibility row: the same integer may name an Area *and* a device.
 * On `liveone-dev`, 18 of 22 handles have BOTH legs (every device gets an area-of-one), and handle 13
 * (Kutis) is a real Sigenergy device AND a 3-member Area with 12 bindings.
 *
 * Before this PR, both legs wrote to the SAME `latest:system:N` hash, so that hash held the union: for
 * handle 13, device 13's own 6 points *plus* the 6 points area 13 binds from device 16 ("Kutis ·
 * derived"). Splitting the keyspace splits that hash. So:
 *
 * - **Writes** address the precise subject: a source device writes `latest:device:{dv_…}`; the
 *   subscription fan-out writes `latest:area:{ar_…}`.
 * - **Reads** by integer handle ({@link kvSubjectsForHandle}) enumerate **every** leg and union them.
 *   That reproduces the pre-PR hash exactly, for every address, and it is why no dashboard loses a
 *   value. Narrowing a read to one leg is a SCOPE change on a live (and, for handle 13, *shared*)
 *   dashboard — it belongs with the move of dashboard sections onto native `ar_` addressing, not with a
 *   keyspace rename. A silently-split cache looks like an empty `latest` map, not an error.
 *
 * ## Caching
 *
 * Modelled on `lib/registry/registry-cache.ts`: positive-only, TTL-bounded, memoized on `globalThis`.
 * A `legacy_handles` row is written with `coalesce(existing, new)` by both writers, so a leg once
 * present is never *changed*; it can only be *added*. A stale entry can therefore never be wrong, only
 * incomplete — a handle that gains its second leg reads one leg for at most `TTL_MS`, and a brand-new
 * handle is never cached as absent, so its first reading resolves immediately.
 */
import { DeviceRegistry } from "@/lib/registry/device-registry";
import { Area } from "@/lib/ids";
import {
  areaSubject,
  deviceSubject,
  type KvAreaSubject,
  type KvDeviceSubject,
  type KvSubject,
} from "./kv-keys";

const TTL_MS = 60 * 1000; // matches registry-cache / PointManager.CACHE_TTL_MS

/** Both legs of one handle. At least one is set; a handle with neither is not cached. */
interface Legs {
  device?: KvDeviceSubject;
  area?: KvAreaSubject;
}

interface Entry {
  legs: Legs;
  loadedAt: number;
}

const g = globalThis as typeof globalThis & {
  __kvSubjectCache?: Map<number, Entry>;
};
function cache(): Map<number, Entry> {
  return (g.__kvSubjectCache ??= new Map());
}

/** Drop the memo — for tests, and for a write path that has just minted a handle's second leg. */
export function invalidateKvSubjectCache(handle?: number): void {
  if (handle == null) cache().clear();
  else cache().delete(handle);
}

async function legsForHandle(handle: number): Promise<Legs> {
  const now = Date.now();
  const hit = cache().get(handle);
  if (hit && now - hit.loadedAt < TTL_MS) return hit.legs;

  const targets = await DeviceRegistry.resolveHandle(handle);
  const legs: Legs = {
    ...(targets?.deviceId ? { device: deviceSubject(targets.deviceId) } : {}),
    ...(targets?.areaId
      ? { area: areaSubject(Area.encode(targets.areaId)) }
      : {}),
  };
  // Positive-only: an unknown handle is re-queried next time rather than cached as absent, so a
  // just-created device's very first reading is never dropped.
  if (legs.device || legs.area) cache().set(handle, { legs, loadedAt: now });
  return legs;
}

/**
 * The subject a WRITE from this handle belongs to.
 *
 * Device-first, and for reads-of-a-source it is effectively device-only: every point belongs to a
 * device (`points.device_id` is `NOT NULL` and FK-backed), so a handle that sources a reading always
 * has a device leg. The area fallback exists so a handle that somehow names only an Area still lands
 * where the pre-PR single hash did, rather than throwing on the ingest path.
 *
 * Null only for a handle in no `legacy_handles` row at all.
 */
export async function kvSourceSubjectForHandle(
  handle: number,
): Promise<KvSubject | null> {
  const legs = await legsForHandle(handle);
  return legs.device ?? legs.area ?? null;
}

/** The DEVICE subject for a handle, or null when the handle names no device. */
export async function kvDeviceSubjectForHandle(
  handle: number,
): Promise<KvDeviceSubject | null> {
  return (await legsForHandle(handle)).device ?? null;
}

/**
 * Every subject an integer handle names, device leg first — the set a READ by handle must union over.
 * See the header for why this is a union and not a choice.
 */
export async function kvSubjectsForHandle(
  handle: number,
): Promise<KvSubject[]> {
  const legs = await legsForHandle(handle);
  const out: KvSubject[] = [];
  if (legs.area) out.push(legs.area);
  // Device LAST so that, where both legs hold the same logicalPath, the device's own direct reading
  // wins over the propagated copy. (They are written from the same value today, so this is a
  // tie-break, not a behaviour change — but it is the tie-break that cannot be stale.)
  if (legs.device) out.push(legs.device);
  return out;
}
