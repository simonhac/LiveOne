/**
 * A derivation's SCOPE — the devices it touches — and the authorization that follows from it.
 *
 * ## The property this file exists to carry
 *
 * The old rule was *"the caller names a scope (`/areas/{ar_}/…`), we authorize that scope, and bind
 * the row to it in the WHERE clause"*. It worked, and `loadDerivationForOwner` existed precisely
 * because forgetting the WHERE would let anyone who owns any area address any derivation by id — a
 * bug class guarded by a helper nobody must forget to call.
 *
 * With the site derived rather than configured (migration 0063) there is no caller-supplied scope
 * left to bind, and the replacement is stronger: **the scope is derived from the row**. Load the
 * derivation, compute its device set from `derivation_sources`, authorize against THAT. There is no
 * WHERE clause to omit, because there is nothing for the caller to name. The bug class is not
 * guarded, it is unspellable.
 *
 * ## Two rules about the device set, both load-bearing
 *
 * 1. **Every device, not one of them.** Access is required on EVERY device in the set, for reads and
 *    for writes. One-of-N would be an escalation primitive: name one of your own points plus one of
 *    mine, and a `runs` card appears on my device — or, worse, a detector you can edit starts
 *    reading my series. `assertMembersReadable` (`lib/areas/create.ts`) makes the same choice on the
 *    members wire, for the same reason.
 * 2. **The output point's device is IN the set.** An `hws-model` WRITES onto its output point
 *    (`derivations.output_point_id`), so a caller who may edit the model may cause writes onto that
 *    device. Sources alone would authorize the reading and miss the writing.
 *
 * The set is recomputed **per request** rather than cached or stored: it is a function of the
 * wiring, and a PATCH that moves a boundary point moves the set with it. A stored copy would be one
 * more thing that can disagree with the rows — which is the whole failure mode 0063 removed.
 *
 * ## 404 vs 403
 *
 * An unknown `dx_` and one the caller may not READ collapse to the same 404. Distinguishing them
 * would make the URL an existence oracle over `dx_` ids, the §8.4 no-escalation rule the v4 surface
 * applies everywhere else. Once read access is PROVED, a write refusal may honestly be a 403 — the
 * caller already knows the row exists — and it names the devices that refused, because "403" with
 * no subject is unactionable when the set has three members.
 */
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  derivations,
  derivationSources,
  devices,
  points,
  type Derivation as DerivationRow,
} from "@/lib/db/planetscale/schema";
import { Derivation, Device, type DeviceId } from "@/lib/ids";

/** One device a derivation touches, with the facts an authorization decision needs. */
export interface ScopeDevice {
  /** Raw `devices.id`. Data-layer only. */
  uuid: string;
  deviceId: DeviceId;
  rid: number;
  name: string;
  ownerUserId: string | null;
}

/** One `derivation_sources` row, as the wire projection and the resolver both want it. */
export interface ScopeSource {
  slot: string;
  pointId: string;
  deviceUuid: string;
}

/**
 * A derivation plus everything derived FROM it: its typed source ports and the devices those (and
 * its output point) sit on. The unit every read on this surface returns — one row shape, so the
 * collection and the item cannot drift on what a derivation looks like.
 */
export interface DerivationRecord {
  row: DerivationRow;
  sources: ScopeSource[];
  devices: ScopeDevice[];
}

/**
 * Load derivations with their sources and device set, in ONE query.
 *
 * 🛑 Every join is LEFT. A derivation with no `derivation_sources` rows at all is not a shape any
 * writer can produce (all three write parent and sources in one transaction) — but slot PRESENCE is
 * the one thing about the wiring the database still does not enforce, so an INNER join would make
 * such a row INVISIBLE rather than visibly broken. It must list, so it can be seen and deleted; the
 * authorization below is what stops the empty device set reading as "no objections".
 */
async function loadRecords(conds: SQL[]): Promise<DerivationRecord[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      d: derivations,
      slot: derivationSources.slot,
      pointId: derivationSources.pointId,
      sourceDeviceId: derivationSources.deviceId,
      outputDeviceId: points.deviceId,
    })
    .from(derivations)
    .leftJoin(
      derivationSources,
      eq(derivationSources.derivationId, derivations.id),
    )
    // `points` is joined ONCE, on the OUTPUT point — the source points' devices arrive on
    // `derivation_sources.device_id`, which the composite FK proves is the point's own device, so
    // there is nothing a second join to `points` would add.
    .leftJoin(points, eq(points.id, derivations.outputPointId))
    .where(conds.length ? and(...conds) : undefined);

  const byId = new Map<
    string,
    { row: DerivationRow; sources: ScopeSource[]; deviceUuids: Set<string> }
  >();
  for (const r of rows) {
    const entry = byId.get(r.d.id) ?? {
      row: r.d,
      sources: [],
      deviceUuids: new Set<string>(),
    };
    if (r.slot && r.pointId && r.sourceDeviceId) {
      // The LEFT join fans out over slots, so the same `output_device_id` arrives on every row —
      // dedupe by slot rather than trusting the row count.
      if (!entry.sources.some((s) => s.slot === r.slot)) {
        entry.sources.push({
          slot: r.slot,
          pointId: r.pointId,
          deviceUuid: r.sourceDeviceId,
        });
      }
      entry.deviceUuids.add(r.sourceDeviceId);
    }
    if (r.outputDeviceId) entry.deviceUuids.add(r.outputDeviceId);
    byId.set(r.d.id, entry);
  }

  const allUuids = [
    ...new Set([...byId.values()].flatMap((e) => [...e.deviceUuids])),
  ];
  const deviceById = new Map<string, ScopeDevice>();
  if (allUuids.length > 0) {
    for (const dv of await requirePlanetscaleDb()
      .select({
        uuid: devices.id,
        rid: devices.rid,
        name: devices.name,
        ownerUserId: devices.ownerUserId,
      })
      .from(devices)
      .where(inArray(devices.id, allUuids)))
      deviceById.set(dv.uuid, {
        uuid: dv.uuid,
        deviceId: Device.encode(dv.uuid),
        rid: dv.rid,
        name: dv.name,
        ownerUserId: dv.ownerUserId,
      });
  }

  return [...byId.values()].map((e) => ({
    row: e.row,
    // Stable order so the wire and the logs read the same way twice.
    sources: e.sources.sort((a, b) => a.slot.localeCompare(b.slot)),
    devices: [...e.deviceUuids]
      .map((u) => deviceById.get(u))
      .filter((d): d is ScopeDevice => d != null)
      .sort((a, b) => a.rid - b.rid),
  }));
}

/**
 * May this caller READ every device in the set? Owner, admin, or an ownerless (public) device —
 * the same three terms `requireDeviceAccess` reads with, so this surface cannot become the laxer
 * door onto the same rows.
 */
function canReadAll(
  scope: ScopeDevice[],
  userId: string,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  // 🛑 An EMPTY set is not "no objections" — it is "nothing to authorize against", which for a
  // non-admin must fail closed. Reachable only for a derivation with no sources and no output
  // point, i.e. one that is already broken; the operator who can fix it is an admin.
  if (scope.length === 0) return false;
  return scope.every((d) => d.ownerUserId === userId || d.ownerUserId === null);
}

/**
 * May this caller WRITE every device in the set? Owner or admin — deliberately WITHOUT the
 * ownerless-is-public term that `canReadAll` has, exactly as `requireDeviceAccess`'s `canWrite`
 * drops it: a public device is readable by everyone and configurable by nobody but an admin.
 */
function unwritable(
  scope: ScopeDevice[],
  userId: string,
  isAdmin: boolean,
): ScopeDevice[] {
  if (isAdmin) return [];
  if (scope.length === 0) return scope;
  return scope.filter((d) => d.ownerUserId !== userId);
}

/** Can this caller see that this device EXISTS — the same term `canReadAll` applies per device. */
function visible(d: ScopeDevice, userId: string, isAdmin: boolean): boolean {
  return isAdmin || d.ownerUserId === userId || d.ownerUserId === null;
}

/**
 * The 403 for "you may not write every device in this set", naming only what the caller may SEE.
 *
 * 🛑 A refusal is not a place to introduce a caller to a device. Naming every refusing device makes
 * the message actionable when they are the caller's own (or public), and an information leak when
 * they are not: "name one of your own points as a signal, read back the id and display name of the
 * private device the rest of the derivation sits on" is a disclosure oracle built out of an error
 * message. So the unreadable ones are COUNTED, not named — enough to explain the refusal, not
 * enough to enumerate someone else's fleet.
 */
function writeRefused(
  refused: ScopeDevice[],
  userId: string,
  isAdmin: boolean,
): NextResponse {
  const named = refused.filter((d) => visible(d, userId, isAdmin));
  const hidden = refused.length - named.length;
  return NextResponse.json(
    {
      error: "Write access required on every device this derivation touches",
      detail: {
        code: "device-write-required",
        devices: named.map((d) => ({ id: d.deviceId, name: d.name })),
        // Present only when there is something withheld, so an operator can tell "I can see the
        // whole problem" from "part of this is not mine to see".
        ...(hidden > 0 ? { hiddenDevices: hidden } : {}),
      },
    },
    { status: 403 },
  );
}

export interface LoadedDerivation {
  userId: string;
  isAdmin: boolean;
  record: DerivationRecord;
}

/** What a route needs from this loader: read access, or read AND write. */
export type ScopeNeed = "read" | "write";

/**
 * The authorization decision for a record that is already in hand — the half of
 * {@link loadDerivation} that has nothing to do with HTTP. Returns the refusal, or null to proceed.
 *
 * 🛑 It exists as its own export because of a real hole the first cut of this PR had: the CREATE
 * path authorizes the PROSPECTIVE device set (the points in the body), and `ensureRunDetector` then
 * answers `exists` with a row whose set may be WIDER — a detector whose signal is on your device and
 * whose energy is on mine. Returning that row's wiring because you could write one of its devices
 * would disclose, through POST, exactly what GET returns 404 for. Every path that hands a caller a
 * `DerivationRecord` goes through this.
 */
export function authorizeRecord(
  record: DerivationRecord,
  userId: string,
  isAdmin: boolean,
  need: ScopeNeed,
): NextResponse | null {
  if (!canReadAll(record.devices, userId, isAdmin))
    // The same 404 an unknown id gets: "unknown" and "not yours" must stay indistinguishable.
    return NextResponse.json(
      { error: "Derivation not found" },
      { status: 404 },
    );
  if (need === "read") return null;
  const refused = unwritable(record.devices, userId, isAdmin);
  // Honest 403 rather than 404: read is already proved, so the row's existence is not news.
  return refused.length > 0 ? writeRefused(refused, userId, isAdmin) : null;
}

/**
 * Authenticate, decode the `dx_`, load the derivation, and authorize against its own device set.
 *
 * 400 malformed id · 401 unauthenticated · 404 unknown OR unreadable (deliberately the same answer)
 * · 403 readable but not writable, naming the devices that refused.
 *
 * See the two rules in this file's header: access is required on EVERY device in the set, and the
 * set includes the OUTPUT point's device because an `hws-model` writes onto it. Both are recomputed
 * per request from the wiring, never read from a stored scope.
 */
export async function loadDerivation(
  request: NextRequest,
  dxid: string,
  need: ScopeNeed,
): Promise<LoadedDerivation | { error: NextResponse }> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };

  const uuid = Derivation.toUuidOrNull(dxid);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid derivation id: ${dxid}` },
        { status: 400 },
      ),
    };

  const [record] = await loadRecords([eq(derivations.id, uuid)]);
  if (!record)
    return {
      error: NextResponse.json(
        { error: "Derivation not found" },
        { status: 404 },
      ),
    };

  const refusal = authorizeRecord(record, auth.userId, auth.isAdmin, need);
  if (refusal) return { error: refusal };

  return { userId: auth.userId, isAdmin: auth.isAdmin, record };
}

/**
 * Authorize a set of devices a derivation is ABOUT to touch — the create-path twin of
 * {@link loadDerivation}, which cannot be used because the row does not exist yet.
 *
 * Same rule, stated once: write on every device, ownerless devices excluded. Returns a 403 response
 * or null.
 */
export async function requireWriteOnDevices(
  deviceUuids: string[],
  userId: string,
  isAdmin: boolean,
): Promise<NextResponse | null> {
  const uuids = [...new Set(deviceUuids)];
  if (uuids.length === 0)
    return NextResponse.json(
      { error: "Cannot authorize a derivation that touches no device" },
      { status: 422 },
    );
  const scope: ScopeDevice[] = (
    await requirePlanetscaleDb()
      .select({
        uuid: devices.id,
        rid: devices.rid,
        name: devices.name,
        ownerUserId: devices.ownerUserId,
      })
      .from(devices)
      .where(inArray(devices.id, uuids))
  ).map((d) => ({ ...d, deviceId: Device.encode(d.uuid) }));
  // A uuid with no `devices` row cannot be authorized, and must not be silently dropped from the
  // set — that would turn "unknown device" into "no objection".
  if (scope.length !== uuids.length)
    return NextResponse.json(
      { error: "A source point names a device that does not exist" },
      { status: 422 },
    );
  const refused = unwritable(scope, userId, isAdmin);
  // Named only where the caller could already see them — see `writeRefused`. This is the sharper
  // case of that rule: here the device was reached by naming a `pt_` in the BODY, so an unredacted
  // message would turn "guess a point id" into "read back its device's id and display name".
  return refused.length === 0 ? null : writeRefused(refused, userId, isAdmin);
}

/** Narrowing filters for the collection read. Every one is optional; all of them AND together. */
export interface DerivationQuery {
  kind?: string;
  role?: string;
  enabled?: boolean;
  /** Raw `devices.id` — the derivation must touch this device. */
  deviceUuid?: string;
  /** Raw `devices.id` set — the derivation must touch at least one of them (the `?area=` leg). */
  anyDeviceUuids?: string[];
}

/**
 * Every derivation this caller may read, narrowed by `query`.
 *
 * Readability is the SAME every-device rule the item loader applies, evaluated in JS rather than in
 * SQL: the set is small (tens of rows fleet-wide) and expressing "every device in the set is
 * readable" as a predicate would be a NOT EXISTS over a correlated subquery that has to agree,
 * exactly, with `canReadAll` — two implementations of one rule is how a listing comes to show what
 * the item refuses.
 *
 * The device filters run BEFORE readability, so narrowing can never widen: a `?device=` naming
 * someone else's device returns nothing rather than 403-ing, because the answer "no derivations you
 * may read touch that device" is true and leaks nothing.
 */
export async function listReadableDerivations(
  userId: string,
  isAdmin: boolean,
  query: DerivationQuery = {},
): Promise<DerivationRecord[]> {
  const conds: SQL[] = [];
  if (query.kind) conds.push(eq(derivations.kind, query.kind));
  if (query.role) conds.push(eq(derivations.role, query.role));
  if (query.enabled !== undefined)
    conds.push(eq(derivations.enabled, query.enabled));

  let records = await loadRecords(conds);
  if (query.deviceUuid) {
    const want = query.deviceUuid;
    records = records.filter((r) => r.devices.some((d) => d.uuid === want));
  }
  if (query.anyDeviceUuids) {
    const want = new Set(query.anyDeviceUuids);
    records = records.filter((r) => r.devices.some((d) => want.has(d.uuid)));
  }
  return records
    .filter((r) => canReadAll(r.devices, userId, isAdmin))
    .sort((a, b) => a.row.id.localeCompare(b.row.id));
}

/** One derivation by uuid with its scope, already authorized elsewhere. */
export async function readRecord(
  uuid: string,
): Promise<DerivationRecord | null> {
  const [record] = await loadRecords([eq(derivations.id, uuid)]);
  return record ?? null;
}
