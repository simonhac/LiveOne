/**
 * The point identity registry — the ONLY owner of the uuid↔rid↔address mapping.
 *
 * Config-v4 seam (see docs/plans/config-v4-execution-plan.md §3, config-v4-clean-sheet.md §5):
 * above the seam everything speaks the public `pt_…` TypeID (`PointId`); below it the hot
 * time-series tables key on the compact integer `rid`. This module is the runtime bridge across the
 * three `point_info` columns that hold those identities:
 *
 *   point_uid (uuid)   — the stable public identity (→ PointId)
 *   rid       (int)    — the internal recorder key (post-cutover hot-table key)
 *   (system_id, index) — the renameable composite ADDRESS (today's hot-table key)
 *
 * `lib/readings/dao.ts` uses this to expand a `PointId` into whatever key the current SQL needs
 * (composite address pre-cutover; `rid` post-cutover). Nothing else below the seam reads `rid`.
 *
 * ── Why a stale positive cache is SAFE (immutability) ────────────────────────────────────────────
 * Every field of a cached mapping is WRITE-ONCE. `rid` is `nextval('point_rid_seq')` at insert and
 * never updated; the `(system_id, index)` address is assigned once by `ensurePointInfo` (its
 * onConflictDoUpdate touches only display/transform/updatedAt — point-manager.ts:585-617); `point_uid`
 * is deliberately not overwritten on conflict (point-manager.ts:607). So a cached tuple can never
 * become *wrong*, only *absent*. The TTL is therefore a memory bound (and a way to eventually shed
 * post-cutover-deleted rows), NOT a correctness knob.
 *
 * ── Why there is NO negative caching ─────────────────────────────────────────────────────────────
 * A miss ALWAYS hits the DB; genuine absence throws {@link UnknownIdError} and is never cached. The
 * receiver's hot path is a brand-new point's very first reading, and the poller that minted that point
 * runs in a different process — caching absence for the TTL would silently drop/mis-route that point's
 * readings for up to a minute. Miss-always-fills keeps a just-committed point immediately resolvable.
 */
import { inArray, or, and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointInfo } from "@/lib/db/planetscale/schema";
import { Point, type PointId } from "@/lib/ids";

// ── Branded internal keys ────────────────────────────────────────────────────────────────────────
// rids are plain integers at runtime; the brand makes PointRid and DeviceRid nominally distinct at
// compile time (modelled on lib/ids/types.ts TypeId<P>). Passing a DeviceRid where a PointRid is
// expected is a type error.
declare const __ridBrand: unique symbol;
export type Rid<Tag extends string> = number & { readonly [__ridBrand]: Tag };
export type PointRid = Rid<"pt">;
/** == systems.id pre-cutover (there is no device uuid column yet); becomes the minted device rid at cutover. */
export type DeviceRid = Rid<"dv">;

const asPointRid = (n: number): PointRid => n as PointRid;

export type UnknownIdKind = "point" | "point-rid" | "point-addr";

/** Thrown when a public id / rid / address has no `point_info` row. `kind` lets callers map to a domain error. */
export class UnknownIdError extends Error {
  constructor(
    public readonly kind: UnknownIdKind,
    public readonly id: string | number,
    message?: string,
  ) {
    super(message ?? `unknown ${kind}: ${id}`);
    this.name = "UnknownIdError";
  }
}

/** One immutable point identity/address tuple. `index` is the TS field for DB column point_info."id". */
export interface PointAddr {
  pointId: PointId;
  uuid: string;
  rid: PointRid;
  systemId: number;
  index: number;
}

// ── Cache state (memoized on globalThis to survive Next hot-reload, like planetscaleDb) ───────────
const TTL_MS = 60 * 1000; // matches PointManager.CACHE_TTL_MS

interface Entry {
  addr: PointAddr;
  loadedAt: number;
}
interface RegistryState {
  byUuid: Map<string, Entry>;
  byRid: Map<number, string>; // rid → uuid
  byAddr: Map<string, string>; // `${systemId}.${index}` → uuid
}

const g = globalThis as typeof globalThis & {
  __readingsRegistry?: RegistryState;
};
function state(): RegistryState {
  return (g.__readingsRegistry ??= {
    byUuid: new Map(),
    byRid: new Map(),
    byAddr: new Map(),
  });
}

const addrKey = (systemId: number, index: number) => `${systemId}.${index}`;

function writeEntry(addr: PointAddr, now: number): void {
  const st = state();
  st.byUuid.set(addr.uuid, { addr, loadedAt: now });
  st.byRid.set(addr.rid, addr.uuid);
  st.byAddr.set(addrKey(addr.systemId, addr.index), addr.uuid);
}

function toAddr(row: {
  uuid: string;
  rid: number;
  systemId: number;
  index: number;
}): PointAddr {
  return {
    pointId: Point.encode(row.uuid),
    uuid: row.uuid,
    rid: asPointRid(row.rid),
    systemId: row.systemId,
    index: row.index,
  };
}

const SELECT_COLS = {
  uuid: pointInfo.pointUid,
  rid: pointInfo.rid,
  systemId: pointInfo.systemId,
  index: pointInfo.index,
} as const;

// ── DB fills (one query per batch; every filled row is written to all three indexes) ──────────────

async function fillByUuids(uuids: string[]): Promise<Map<string, PointAddr>> {
  const out = new Map<string, PointAddr>();
  if (uuids.length === 0) return out;
  const rows = await requirePlanetscaleDb()
    .select(SELECT_COLS)
    .from(pointInfo)
    .where(inArray(pointInfo.pointUid, uuids));
  const now = Date.now();
  for (const r of rows) {
    const addr = toAddr(r);
    out.set(addr.uuid, addr);
    writeEntry(addr, now);
  }
  return out;
}

async function fillByRids(rids: number[]): Promise<Map<number, PointAddr>> {
  const out = new Map<number, PointAddr>();
  if (rids.length === 0) return out;
  const rows = await requirePlanetscaleDb()
    .select(SELECT_COLS)
    .from(pointInfo)
    .where(inArray(pointInfo.rid, rids));
  const now = Date.now();
  for (const r of rows) {
    const addr = toAddr(r);
    out.set(addr.rid, addr);
    writeEntry(addr, now);
  }
  return out;
}

async function fillByAddrs(
  pairs: { systemId: number; index: number }[],
): Promise<Map<string, PointAddr>> {
  const out = new Map<string, PointAddr>();
  if (pairs.length === 0) return out;
  // OR-of-pairs (the idiom in point-manager.ts) — one query for N (system_id, index) pairs.
  const rows = await requirePlanetscaleDb()
    .select(SELECT_COLS)
    .from(pointInfo)
    .where(
      or(
        ...pairs.map((p) =>
          and(eq(pointInfo.systemId, p.systemId), eq(pointInfo.index, p.index)),
        ),
      ),
    );
  const now = Date.now();
  for (const r of rows) {
    const addr = toAddr(r);
    out.set(addrKey(addr.systemId, addr.index), addr);
    writeEntry(addr, now);
  }
  return out;
}

function fresh(entry: Entry | undefined, now: number): PointAddr | undefined {
  if (entry && now - entry.loadedAt <= TTL_MS) return entry.addr;
  return undefined;
}

// ── Public surface ────────────────────────────────────────────────────────────────────────────────

/** Resolve a batch of PointIds to their full address tuples (cached; one DB round-trip for misses). */
async function addrsForPoints(
  ids: PointId[],
): Promise<Map<PointId, PointAddr>> {
  const st = state();
  const now = Date.now();
  const out = new Map<PointId, PointAddr>();
  const uuidToId = new Map<string, PointId>();
  const missing = new Set<string>();

  for (const id of ids) {
    const uuid = Point.toUuid(id);
    uuidToId.set(uuid, id);
    const hit = fresh(st.byUuid.get(uuid), now);
    if (hit) out.set(id, hit);
    else missing.add(uuid);
  }

  if (missing.size > 0) {
    const filled = await fillByUuids([...missing]);
    for (const uuid of missing) {
      const addr = filled.get(uuid);
      const id = uuidToId.get(uuid)!;
      if (!addr) throw new UnknownIdError("point", id);
      out.set(id, addr);
    }
  }
  return out;
}

async function addrForPoint(id: PointId): Promise<PointAddr> {
  return (await addrsForPoints([id])).get(id)!;
}

async function ridForPoint(id: PointId): Promise<PointRid> {
  return (await addrForPoint(id)).rid;
}

async function ridsForPoints(ids: PointId[]): Promise<Map<PointId, PointRid>> {
  const addrs = await addrsForPoints(ids);
  const out = new Map<PointId, PointRid>();
  for (const [id, addr] of addrs) out.set(id, addr.rid);
  return out;
}

async function addrsForRids(
  rids: PointRid[],
): Promise<Map<PointRid, PointAddr>> {
  const st = state();
  const now = Date.now();
  const out = new Map<PointRid, PointAddr>();
  const missing = new Set<number>();

  for (const rid of rids) {
    const uuid = st.byRid.get(rid);
    const hit = uuid ? fresh(st.byUuid.get(uuid), now) : undefined;
    if (hit) out.set(rid, hit);
    else missing.add(rid);
  }

  if (missing.size > 0) {
    const filled = await fillByRids([...missing]);
    for (const rid of missing) {
      const addr = filled.get(rid);
      if (!addr) throw new UnknownIdError("point-rid", rid);
      out.set(asPointRid(rid), addr);
    }
  }
  return out;
}

async function addrForRid(rid: PointRid): Promise<PointAddr> {
  return (await addrsForRids([rid])).get(rid)!;
}

async function pointForRid(rid: PointRid): Promise<PointId> {
  return (await addrForRid(rid)).pointId;
}

/**
 * Resolve the OLD `{systemId}.{index}` grammar to a PointId. Used by the dual-grammar receiver for
 * buffered/in-flight observations, and (post-cutover) as the retained backlog-drain address map.
 */
async function pointForAddr(systemId: number, index: number): Promise<PointId> {
  const st = state();
  const now = Date.now();
  const uuid = st.byAddr.get(addrKey(systemId, index));
  const hit = uuid ? fresh(st.byUuid.get(uuid), now) : undefined;
  if (hit) return hit.pointId;

  const filled = await fillByAddrs([{ systemId, index }]);
  const addr = filled.get(addrKey(systemId, index));
  if (!addr) throw new UnknownIdError("point-addr", addrKey(systemId, index));
  return addr.pointId;
}

/**
 * Drop cached entries. No arg = clear everything (used by tests). With a PointId, evicts that point
 * from all three indexes. Called by point-manager writers after `ensurePointInfo`/`createPoint`
 * (defense-in-depth — miss-fill already sees new rows; this keeps the reverse indexes clean).
 */
function invalidate(id?: PointId): void {
  const st = state();
  if (id === undefined) {
    st.byUuid.clear();
    st.byRid.clear();
    st.byAddr.clear();
    return;
  }
  const uuid = Point.toUuid(id);
  const entry = st.byUuid.get(uuid);
  if (entry) {
    st.byRid.delete(entry.addr.rid);
    st.byAddr.delete(addrKey(entry.addr.systemId, entry.addr.index));
    st.byUuid.delete(uuid);
  }
}

export const RegistryCache = {
  addrForPoint,
  addrsForPoints,
  ridForPoint,
  ridsForPoints,
  addrForRid,
  addrsForRids,
  pointForRid,
  pointForAddr,
  invalidate,
};
