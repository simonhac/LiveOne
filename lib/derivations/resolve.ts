/**
 * Resolve `derivations` rows into the concrete config each engine needs — the single discovery
 * layer for every kind of derived signal (config-v4 Phase 11).
 *
 * A derivation is config that computes a new signal from existing points (clean-sheet §4.4):
 * `output='intervals'` → run/event periods in `derived_intervals`; `output='point'` → a derived
 * point in the readings pipeline (the HWS model, previously discovered by scanning `point_info` for
 * a `load.hws/temperature` row).
 *
 * Two conventions worth knowing:
 *
 * - **`params` is SPARSE.** A key is present only when it was explicitly configured; anything
 *   absent inherits the per-role code defaults (`lib/run-tracking/defaults.ts`). Thresholds are
 *   always explicit — they have no sensible default.
 * - **The wiring is read from `derivation_sources`, not from `source_points jsonb`** (migration
 *   0063). The jsonb is still WRITTEN — 0064 drops it — but nothing here reads it, because only the
 *   table proves what it holds: the slot is checked, the point exists, and `device_id` is provably
 *   the point's own device.
 *
 * ## A derivation's SITE is derived, never configured
 *
 * `derivations.area_id` used to say where a detector lived, and it could disagree with where its
 * points actually were — nothing checked. It is now a dual-written vestige read by nothing. The site
 * comes from the wiring instead:
 *
 *     owner point → `points.device_id` → `devices.rid`   (the `legacyHandle`)
 *
 * 🛑 **The owner slot is `energy` first, then `signal`** (`power` for the hws-model), and that
 * precedence is load-bearing rather than aesthetic. Daylesford's generator detector reads its signal
 * from device 14 (the DeepSea genset's Engine Speed) and its energy from device 1 (the Selectronic's
 * Import counter), and the handle it has always been addressed by is 1. Signal-first would move its
 * `legacyHandle` to 14 — and with it a live KV key and the `/device/{rid}/run-periods` address of
 * every stored interval. Migration 0063's gate G5 proved the energy-first collapse preserves every
 * handle on prod before anything was written.
 *
 * The integer `legacyHandle` is still carried because the KV latest keyspace stays int-addressed;
 * it is now the OWNER DEVICE's `devices.rid` rather than the area's `legacy_handles.handle`. Those
 * were the same number for every live detector — that is what G5 checked.
 */
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  derivations,
  derivationSources,
  devices,
  points,
} from "@/lib/db/planetscale/schema";
import { Device, Point, type PointId } from "@/lib/ids";
import { DeviceRegistry } from "@/lib/registry/device-registry";
import { TRACKABLE_ROLE_IDS, type RoleId } from "@/lib/roles/registry";
import { deriveDerivationId } from "./ids";
import { HWS_MODEL_KIND, RUN_DETECTOR_KIND } from "./kinds";
import { findDerivationBySource, writeDerivationSources } from "./sources";
import { mergeDetectConfig, type DetectConfig } from "./params";
import {
  DEFAULT_HWS_MODEL_OPTIONS,
  type HwsModelOptions,
} from "@/lib/hws-model";

export { HWS_MODEL_KIND, RUN_DETECTOR_KIND };

// ---------------------------------------------------------------------------
// Persisted jsonb contracts
// ---------------------------------------------------------------------------

/** `derivations.params` for kind='run-detector'. Sparse: absent ⇒ inherit the role default. */
export interface RunDetectorParams {
  signalKind: "power-threshold";
  /** At least one bound is required; both are always explicit (no default exists). */
  lowerW?: number;
  upperW?: number;
  hysteresisW?: number;
  delayOnSeconds?: number;
  delayOffSeconds?: number;
}

/**
 * `derivations.source_points` for kind='run-detector'. Raw `points.id` uuids.
 *
 * 🛑 DUAL-WRITTEN, never read (0063). `derivation_sources` is what the engines resolve from; this
 * shape survives only because it is still the WIRE shape and still the stored column. It goes with
 * the column in 0064.
 */
export interface RunDetectorSourcePoints {
  signal: string;
  energy?: string | null;
  /**
   * Optional CONTROL point whose edges cut runs apart (`DetectConfig.boundaryEventsMs`) — for the
   * generator, the hub's commanded-run point. Absent = detection behaves exactly as before.
   */
  boundary?: string | null;
}

/** `derivations.params` for kind='hws-model'. Sparse overrides on the model constants. */
export type HwsModelParams = Partial<HwsModelOptions>;

// ---------------------------------------------------------------------------
// Resolved shapes
// ---------------------------------------------------------------------------

export interface ResolvedRunDetector {
  /** `derivations.id` — the identity `derived_intervals` rows hang off. */
  id: string;
  /** `devices.id` of the OWNER device (energy point's, else signal point's). The detector's site. */
  ownerDeviceId: string;
  /** The owner device's `devices.rid`: the integer this detector is addressed by. */
  legacyHandle: number;
  role: string;
  name: string;
  signalPoint: PointId;
  /**
   * The RAW `points.unit` of `signalPoint` ('W', 'rpm', …). This is what
   * `derived_intervals.signal_unit` is stamped with, so a stored statistic says what it measures
   * instead of being assumed to be Watts (migration 0055).
   *
   * Since 0063 it comes from the same join that finds the source row, so unlike the jsonb era it can
   * no longer be null-because-the-uuid-dangled: the composite FK makes a dangling source
   * unrepresentable. It stays nullable only because `points.unit` itself is.
   */
  signalUnit: string | null;
  energyPoint: PointId | null;
  /** Control point whose edges force a run boundary (see RunDetectorSourcePoints.boundary). */
  boundaryPoint: PointId | null;
  detect: DetectConfig;
  detectorVersion: number;
  /** From the owner device's primary area — the site's clock, not the detector's own. */
  timezoneOffsetMin: number;
  displayTimezone: string;
}

export interface ResolvedHwsModel {
  id: string;
  /** The output point's own owning-device handle (`devices.rid`) — the KV latest cache key, as before. */
  systemId: number;
  powerPoint: PointId;
  /** The derived output point (`output_point_id`) — the agg_5m write target. */
  tempPoint: PointId;
  tempPath: string;
  tempUnit: string;
  tempDisplayName: string;
  options: HwsModelOptions;
}

// ---------------------------------------------------------------------------
// Handle → area
// ---------------------------------------------------------------------------

/**
 * The old integer handle → owning area uuid. Area-first (a handle naming both an area-of-one and
 * its device must resolve as the area), else the device's `primary_area_id`.
 *
 * 🛑 Since 0063 this feeds ONLY the dual-write of the `derivations.area_id` vestige — no reader
 * resolves a derivation through it. It goes when the column does.
 */
export async function resolveAreaIdForHandle(
  handle: number,
): Promise<string | null> {
  const targets = await DeviceRegistry.resolveHandle(handle);
  if (!targets) return null;
  if (targets.areaId) return targets.areaId;
  if (!targets.deviceId) return null;
  const [row] = await requirePlanetscaleDb()
    .select({ areaId: devices.primaryAreaId })
    .from(devices)
    .where(eq(devices.id, Device.toUuid(targets.deviceId)))
    .limit(1);
  return row?.areaId ?? null;
}

/**
 * The integer handle → the `devices.id` it names, or null.
 *
 * The device-era counterpart of {@link resolveAreaIdForHandle}, and deliberately NOT expanded to an
 * area's members: its one caller is {@link RunDetectorFilter}, which feeds
 * `recomputeRange`/`deleteRange` — both of which delete-and-reinsert. Widening a handle to its
 * members would turn a previously-inert CLI invocation into a destructive pass over detectors the
 * caller never named.
 */
async function resolveDeviceIdForHandle(
  handle: number,
): Promise<string | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.rid, handle))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Run detectors
// ---------------------------------------------------------------------------

/**
 * Narrow a detector listing to ONE detector — by its `derivations.id`, or by the (handle, role) pair
 * that names it.
 *
 * 🛑 This exists so a recompute can be aimed. `recomputeRange`/`deleteRange` delete-and-reinsert every
 * enabled detector's intervals over the window, which makes an unscoped historical backfill
 * DESTRUCTIVE to detectors other than the one being backfilled: a detector whose signal has been
 * re-pointed (Daylesford's generator moved to the DeepSea engine-speed point, whose history starts
 * 2026-07-11) regenerates NOTHING for a window predating its current signal, so its existing rows
 * are deleted and not replaced. Scope every historical pass.
 */
export type RunDetectorFilter =
  | { derivationId: string }
  | { handle: number; role: string };

/** One `derivation_sources` row joined to its point, as the listing query returns it. */
type SourceJoinRow = {
  slot: string;
  pointId: string;
  deviceId: string;
  unit: string | null;
};

/** The owner device's facts: the handle and the clock every resolved detector carries. */
type OwnerFacts = { legacyHandle: number; tzOffset: number; tz: string };

/**
 * The owner point's slot, in precedence order — see the SITE note at the top of this file.
 *
 * `energy` before `signal`, and the reason is a specific live row rather than a preference. Changing
 * the order re-addresses Daylesford's generator from handle 1 to handle 14.
 */
const OWNER_SLOTS = ["energy", "signal"] as const;

/**
 * Every enabled run-detector's rows, with its sources — ONE query.
 *
 * The join replaces both the old `areas`/`legacy_handles` join AND `attachSignalUnits`, the separate
 * batched `points` read that existed only because `source_points.signal` was a jsonb key and joining
 * it needed a hand-written `(source_points ->> 'signal')::uuid` fragment. A real table is joinable,
 * so the unit arrives with the row and raw SQL — the failure mode tsc cannot see — is gone.
 */
async function loadRunDetectorRows(conds: SQL[]) {
  return (
    requirePlanetscaleDb()
      .select({
        d: derivations,
        slot: derivationSources.slot,
        pointId: derivationSources.pointId,
        deviceId: derivationSources.deviceId,
        unit: points.unit,
      })
      .from(derivations)
      .innerJoin(
        derivationSources,
        eq(derivationSources.derivationId, derivations.id),
      )
      // Total by the composite FK `(point_id, device_id) → points(id, device_id)`: a source row cannot
      // name a point that does not exist, so INNER drops nothing.
      .innerJoin(points, eq(points.id, derivationSources.pointId))
      .where(and(...conds))
  );
}

/**
 * The owner devices' handles and clocks, in one read.
 *
 * `devices.primary_area_id` is NOT NULL with an FK into `areas`, so both joins are total — which is
 * why a detector can no longer silently vanish from a listing the way the old
 * "area has no legacy handle — skipping" branch let it.
 */
async function ownerFacts(
  deviceUuids: string[],
): Promise<Map<string, OwnerFacts>> {
  if (deviceUuids.length === 0) return new Map();
  const rows = await requirePlanetscaleDb()
    .select({
      id: devices.id,
      rid: devices.rid,
      tzOffset: areas.timezoneOffsetMin,
      tz: areas.displayTimezone,
    })
    .from(devices)
    .innerJoin(areas, eq(areas.id, devices.primaryAreaId))
    .where(inArray(devices.id, deviceUuids));
  return new Map(
    rows.map((r) => [
      r.id,
      { legacyHandle: r.rid, tzOffset: r.tzOffset, tz: r.tz },
    ]),
  );
}

/** All enabled run-detector derivations, resolved. Unresolvable rows are dropped with a warning. */
export async function listEnabledRunDetectors(
  filter?: RunDetectorFilter,
): Promise<ResolvedRunDetector[]> {
  const conds = [
    eq(derivations.kind, RUN_DETECTOR_KIND),
    eq(derivations.enabled, true),
  ];
  let ownerMustBe: string | null = null;
  if (filter) {
    if ("derivationId" in filter) {
      conds.push(eq(derivations.id, filter.derivationId));
    } else {
      const deviceId = await resolveDeviceIdForHandle(filter.handle);
      // An unresolvable handle must select NOTHING, never everything. The caller asked to be
      // narrowed; silently widening back to the whole fleet is how a scoped backfill becomes a
      // fleet-wide delete-and-reinsert.
      if (!deviceId) return [];
      ownerMustBe = deviceId;
      conds.push(eq(derivations.role, filter.role));
      // Narrowed in SQL on ANY slot (the `derivation_sources_device_idx` hot path), then narrowed
      // again in JS to detectors this device actually OWNS. Two steps because the owner slot is a
      // per-row precedence, not a column — and matching any slot here would otherwise hand a
      // recompute the detector whose signal merely happens to sit on this device.
      conds.push(eq(derivationSources.deviceId, deviceId));
    }
  }

  // When the query is narrowed by device, that predicate also drops the detector's OTHER slots, so
  // re-read its full source set by id rather than resolving a detector from a partial wiring.
  let rows = await loadRunDetectorRows(conds);
  if (ownerMustBe) {
    const ids = [...new Set(rows.map((r) => r.d.id))];
    if (ids.length === 0) return [];
    // The kind/enabled predicates are RE-STATED, not dropped: the two reads are separate snapshots,
    // so a detector disabled between them would otherwise come back as enabled.
    rows = await loadRunDetectorRows([
      inArray(derivations.id, ids),
      eq(derivations.kind, RUN_DETECTOR_KIND),
      eq(derivations.enabled, true),
    ]);
  }

  const byDerivation = new Map<
    string,
    { d: (typeof rows)[number]["d"]; sources: SourceJoinRow[] }
  >();
  for (const r of rows) {
    const entry = byDerivation.get(r.d.id) ?? { d: r.d, sources: [] };
    entry.sources.push({
      slot: r.slot,
      pointId: r.pointId,
      deviceId: r.deviceId,
      unit: r.unit,
    });
    byDerivation.set(r.d.id, entry);
  }

  const staged = [...byDerivation.values()].flatMap((entry) => {
    const slots = new Map(entry.sources.map((s) => [s.slot, s]));
    const signal = slots.get("signal");
    if (!signal) {
      // Unreachable for a well-formed row — `derivation_sources_slot_check` permits it, so slot
      // PRESENCE is the one thing about the wiring the database still does not enforce. Migration
      // 0063's gate G3 proved every live detector has one.
      console.warn(
        `[Derivations] run-detector ${entry.d.id}: no signal source — skipping`,
      );
      return [];
    }
    if (entry.d.role == null) {
      console.warn(
        `[Derivations] run-detector ${entry.d.id}: no role — skipping`,
      );
      return [];
    }
    const energy = slots.get("energy") ?? null;
    const owner = OWNER_SLOTS.map((s) => slots.get(s)).find((s) => s != null)!;
    return [
      {
        entry,
        signal,
        energy,
        boundary: slots.get("boundary") ?? null,
        owner,
        role: entry.d.role,
      },
    ];
  });

  const facts = await ownerFacts([
    ...new Set(staged.map((s) => s.owner.deviceId)),
  ]);

  const resolved: ResolvedRunDetector[] = [];
  for (const s of staged) {
    if (ownerMustBe && s.owner.deviceId !== ownerMustBe) continue;
    const f = facts.get(s.owner.deviceId);
    if (!f) continue; // unreachable: both joins in `ownerFacts` are total.
    const params = s.entry.d.params as RunDetectorParams;
    resolved.push({
      id: s.entry.d.id,
      ownerDeviceId: s.owner.deviceId,
      legacyHandle: f.legacyHandle,
      role: s.role,
      name: s.entry.d.name,
      signalPoint: Point.encode(s.signal.pointId),
      signalUnit: s.signal.unit,
      energyPoint: s.energy ? Point.encode(s.energy.pointId) : null,
      boundaryPoint: s.boundary ? Point.encode(s.boundary.pointId) : null,
      detect: mergeDetectConfig(params, s.role),
      detectorVersion: s.entry.d.detectorVersion,
      timezoneOffsetMin: f.tzOffset,
      displayTimezone: f.tz,
    });
  }
  return resolved;
}

/**
 * The enabled run detector a legacy (handle, role) OWNS, or null.
 *
 * "Owns", not "touches": the handle must be the detector's owner device. See
 * {@link resolveDeviceIdForHandle}.
 */
export async function getRunDetectorForHandleRole(
  handle: number,
  role: string,
): Promise<ResolvedRunDetector | null> {
  const [det] = await listEnabledRunDetectors({ handle, role });
  return det ?? null;
}

/**
 * The enabled run detector for `role` that any of these devices is a SOURCE of, or null.
 *
 * What `/api/device/{rid}/run-periods` asks. The handle it is given is usually the COMPOSITE — the
 * stacked chart is keyed on Kinkora Unified (8) while the EV detector's points sit on Kinkora Mondo
 * (6) — so the caller passes the member set and this asks all of them at once. Before 0063 that was
 * "ask the handle, then walk `memberSystemIds` asking each in turn", one round trip per member.
 *
 * 🛑 **First wins, and the ambiguity is left visible.** A site with two detectors for one role is not
 * a shape that exists here (a role is one physical thing per site), and merging them would be a
 * worse answer than picking one — but neither is a GOOD answer, so the choice is an explicit
 * `ORDER BY` rather than whatever Postgres happened to emit first.
 */
export async function getRunDetectorForDevices(
  deviceUuids: string[],
  role: string,
): Promise<ResolvedRunDetector | null> {
  if (deviceUuids.length === 0) return null;
  const [hit] = await requirePlanetscaleDb()
    .selectDistinct({ id: derivations.id })
    .from(derivationSources)
    .innerJoin(derivations, eq(derivations.id, derivationSources.derivationId))
    .where(
      and(
        inArray(derivationSources.deviceId, deviceUuids),
        eq(derivationSources.kind, RUN_DETECTOR_KIND),
        eq(derivationSources.role, role),
        eq(derivations.enabled, true),
      ),
    )
    .orderBy(derivations.id)
    .limit(1);
  if (!hit) return null;
  const [det] = await listEnabledRunDetectors({ derivationId: hit.id });
  return det ?? null;
}

/**
 * Which trackable roles do these devices have an enabled run detector for?
 *
 * Replaces `hasEnabledRunDetector(handle, role)` — one `DISTINCT role` read served by
 * `derivation_sources_device_idx`, for the whole member set at once. The old shape was
 * `≈ 2·M·R` SEQUENTIAL round trips inside `capabilitiesForDevice` (`await` in a `for`, M members,
 * R trackable roles): ~40 for a 7-member area, mitigated only by a short-circuit that stopped
 * probing a role once any member answered.
 *
 * 🛑 It also answers a slightly DIFFERENT question, deliberately: a device is now credited with a
 * role if it carries ANY of the detector's source points, not only if the detector was filed under
 * its area-of-one. That is the point of the change — Daylesford's generator detector reads its
 * signal from device 14, so `/device/14` gains the generator-runs card it could never have shown
 * while placement was a configured fact. Signed off with the design.
 *
 * `enabled` lives on the PARENT and is deliberately not denormalised onto the child: it is the one
 * mutable lever the PATCH route offers, and copying it would make every toggle a two-table write.
 */
export async function runDetectorRolesForDevices(
  deviceUuids: string[],
): Promise<Set<RoleId>> {
  if (deviceUuids.length === 0) return new Set();
  const rows = await requirePlanetscaleDb()
    .selectDistinct({ role: derivationSources.role })
    .from(derivationSources)
    .innerJoin(derivations, eq(derivations.id, derivationSources.derivationId))
    .where(
      and(
        inArray(derivationSources.deviceId, deviceUuids),
        eq(derivationSources.kind, RUN_DETECTOR_KIND),
        eq(derivations.enabled, true),
      ),
    );
  const out = new Set<RoleId>();
  for (const r of rows) {
    if (r.role && (TRACKABLE_ROLE_IDS as readonly string[]).includes(r.role))
      out.add(r.role as RoleId);
  }
  return out;
}

/**
 * The enabled-or-not run detector for `role` whose OWNER device is `deviceId`, or null.
 *
 * Resolves each candidate's owner with the same energy-then-signal precedence the reader uses,
 * rather than asking "does any source row of a same-role detector sit on this device" — which would
 * also match a detector that merely reads a boundary point here and does not own it.
 *
 * 🛑 Not concurrency-safe, and cannot be: two creates whose signals sit on DIFFERENT devices but
 * whose energy points resolve to the SAME owner both pass this check, and
 * `derivation_sources_signal_role_unique` (keyed on the signal device) cannot catch them either.
 * That is the honest cost of an invariant no index can express; it is a single-operator system and
 * the loser is a duplicate row, not lost data.
 */
async function ownerOfRoleOnDevice(
  db: ReturnType<typeof requirePlanetscaleDb>,
  role: string,
  deviceId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      derivationId: derivationSources.derivationId,
      slot: derivationSources.slot,
      deviceId: derivationSources.deviceId,
    })
    .from(derivationSources)
    .where(
      and(
        eq(derivationSources.kind, RUN_DETECTOR_KIND),
        eq(derivationSources.role, role),
      ),
    );
  const byDerivation = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const slots = byDerivation.get(r.derivationId) ?? new Map();
    slots.set(r.slot, r.deviceId);
    byDerivation.set(r.derivationId, slots);
  }
  for (const [id, slots] of byDerivation) {
    const owner = OWNER_SLOTS.map((sl) => slots.get(sl)).find((d) => d != null);
    if (owner === deviceId) return id;
  }
  return null;
}

export interface EnsureRunDetectorInput {
  /**
   * The area to stamp on the dual-written `derivations.area_id` vestige. 🛑 It no longer decides
   * anything: a detector's site is its owner device, so there is no placement rule left to get
   * wrong and no `area-not-probed` refusal. Optional, and it goes with the column in 0064.
   */
  areaId?: string | null;
  role: RoleId;
  name: string;
  /** `points.id` uuid of the series the detector thresholds. */
  signalPointUid: string;
  /** `points.id` uuid of a cumulative energy counter, or null for a detector with no kWh. */
  energyPointUid?: string | null;
  params: RunDetectorParams;
  /** False = report what would happen without writing. */
  apply: boolean;
}

export type EnsureRunDetectorStatus =
  | "created"
  | "exists"
  | "not-trackable"
  | "no-signal-point"
  | "no-energy-point"
  | "no-bounds"
  | "owner-role-taken"
  | "area-role-vestige-taken";

export interface EnsureRunDetectorResult {
  status: EnsureRunDetectorStatus;
  role: string;
  derivationId?: string;
  areaId?: string | null;
  /** For `owner-role-taken`: the derivation already holding this (owner device, role). */
  conflictingDerivationId?: string;
}

/**
 * Ensure the run-detector derivation wired to `signalPointUid` for `role` exists.
 *
 * Idempotent by NATURAL KEY: it asks `derivation_sources` whether this (signal point, kind, role) is
 * already wired, and only mints an id on the insert path. 🛑 The old shape minted the deterministic
 * id *in order to look it up*, which quietly made `derivations.id` the answer to a question that is
 * really about the wiring — and it meant a caller reasoning about devices could never find a
 * pre-0063 row whose id was anchored on an area. Existing ids are NEVER recomputed; see
 * `lib/derivations/ids.ts`.
 *
 * ⚠️ There is deliberately no rule about where the signal point LIVES relative to anything else. A
 * detector may watch a point on one device and count energy on another, and one does: Daylesford's
 * generator takes its signal from the DeepSea genset's Engine Speed (device 14) and its energy from
 * the Selectronic's Import counter (device 1), because handle 1's Grid-import proxy was measurably
 * unable to tell a running genset from a stopped one. The site falls out of that wiring rather than
 * being asserted alongside it.
 *
 * 🛑 `owner-role-taken` is the ONE invariant carried by code rather than by a constraint, and
 * honestly so: `derivation_sources_signal_role_unique` covers `(device, kind, role)` for the SIGNAL
 * slot, but two detectors whose signals sit on different devices can still resolve to the same OWNER
 * device and fight over one `<stem>/running` point. The index cannot express that; this check can.
 *
 * Every failure mode is a distinct status rather than a throw, because the callers are a dry-run
 * script and an API route, both of which want to report rather than crash. The point existence
 * checks matter even now that the FK would catch a dangling uuid: a 422 naming the slot is a better
 * answer than a constraint violation surfacing as a 500.
 */
export async function ensureRunDetector(
  input: EnsureRunDetectorInput,
): Promise<EnsureRunDetectorResult> {
  const { areaId, role, signalPointUid, energyPointUid, params, apply } = input;
  const base = { role, areaId: areaId ?? null };

  if (!TRACKABLE_ROLE_IDS.includes(role))
    return { ...base, status: "not-trackable" };
  // detectRunPeriods throws without a bound, and it throws deep inside the cron rather than here.
  if (params.lowerW == null && params.upperW == null)
    return { ...base, status: "no-bounds" };

  const db = requirePlanetscaleDb();
  const wanted = [signalPointUid, ...(energyPointUid ? [energyPointUid] : [])];
  const found = new Map(
    (
      await db
        .select({ id: points.id, deviceId: points.deviceId })
        .from(points)
        .where(inArray(points.id, wanted))
    ).map((r) => [r.id, r.deviceId]),
  );
  const signalDeviceId = found.get(signalPointUid);
  if (!signalDeviceId) return { ...base, status: "no-signal-point" };
  const energyDeviceId = energyPointUid ? found.get(energyPointUid) : undefined;
  if (energyPointUid && !energyDeviceId)
    return { ...base, status: "no-energy-point" };

  const existingId = await findDerivationBySource(
    db,
    RUN_DETECTOR_KIND,
    role,
    "signal",
    signalPointUid,
  );
  if (existingId)
    return { ...base, status: "exists", derivationId: existingId };

  // The owner this detector WOULD have — energy first, then signal, exactly as the resolver reads it.
  const ownerDeviceId = energyDeviceId ?? signalDeviceId;
  // 🛑 Compare OWNERS, not "does any existing row touch this device". A detector that merely reads a
  // BOUNDARY point on this device does not own it, and refusing that would forbid a legal second
  // detector — the check has to resolve each candidate's owner the same way the reader does.
  const takenBy = await ownerOfRoleOnDevice(db, role, ownerDeviceId);
  if (takenBy)
    return {
      ...base,
      status: "owner-role-taken",
      conflictingDerivationId: takenBy,
    };

  // 🛑 The `derivations_area_role_unique` VESTIGE. `area_id` decides nothing any more, but the index
  // on `(area_id, role) WHERE role IS NOT NULL` is still there until 0064 drops it — so two
  // detectors for one role stamped with the same area cannot both be stored, however legal their
  // wiring now is. Refused here, by name, rather than surfacing as a 500 on the INSERT.
  if (areaId) {
    const [clash] = await db
      .select({ id: derivations.id })
      .from(derivations)
      .where(and(eq(derivations.areaId, areaId), eq(derivations.role, role)))
      .limit(1);
    if (clash)
      return {
        ...base,
        status: "area-role-vestige-taken",
        conflictingDerivationId: clash.id,
      };
  }

  // Anchored on the SIGNAL POINT uuid, not the area: deterministic AND cross-environment stable
  // (`points.id` is a uuidv5, `devices.id` is not). Minted on the insert path only.
  const id = deriveDerivationId(signalPointUid, RUN_DETECTOR_KIND, role);
  if (!apply) return { ...base, status: "created", derivationId: id };

  // 🛑 BOTH WRITES OR NEITHER. The parent alone is worse than nothing: `findDerivationBySource`
  // above would not see it, so the next call re-mints the SAME deterministic id and dies on the
  // primary key — an unrecoverable create, by hand, with no way to tell what happened.
  await db.transaction(async (tx) => {
    await tx.insert(derivations).values({
      id,
      areaId: areaId ?? null,
      kind: RUN_DETECTOR_KIND,
      role,
      name: input.name,
      enabled: true,
      output: "intervals",
      // Sparse by convention: anything absent inherits `detectorDefaultsForRole` at resolve time.
      params,
      // Dual-written and read by nothing (0063). `derivation_sources` below is the twin the engines
      // resolve from.
      sourcePoints: {
        signal: signalPointUid,
        energy: energyPointUid ?? null,
      } satisfies RunDetectorSourcePoints,
    });
    await writeDerivationSources(tx, {
      derivationId: id,
      kind: RUN_DETECTOR_KIND,
      role,
      slots: { signal: signalPointUid, energy: energyPointUid },
    });
  });

  return { ...base, status: "created", derivationId: id };
}

/**
 * `ensureRunDetector` addressed by the legacy integer handle — what the seed script's `--handle`
 * flag means. The handle now only supplies the `area_id` vestige; the detector's site comes from
 * its signal/energy points either way.
 */
export async function ensureRunDetectorForHandle(
  input: Omit<EnsureRunDetectorInput, "areaId"> & { handle: number },
): Promise<EnsureRunDetectorResult> {
  const areaId = await resolveAreaIdForHandle(input.handle);
  const { handle: _handle, ...rest } = input;
  return ensureRunDetector({ ...rest, areaId });
}

// ---------------------------------------------------------------------------
// HWS models
// ---------------------------------------------------------------------------

/**
 * All enabled hws-model derivations, resolved.
 *
 * One query, where this used to issue a `points ⋈ devices` read PER ROW (an N+1 that existed
 * because the power source lived in jsonb and the output point had to be looked up separately).
 * Both reachable through joins now: `derivation_sources` for the power slot, `output_point_id` for
 * the temperature point.
 */
export async function listEnabledHwsModels(): Promise<ResolvedHwsModel[]> {
  const rows = await requirePlanetscaleDb()
    .select({
      d: derivations,
      powerPointId: derivationSources.pointId,
      systemId: devices.rid,
      stem: points.logicalPath,
      metric: points.metricType,
      unit: points.unit,
      displayName: points.name,
    })
    .from(derivations)
    .innerJoin(
      derivationSources,
      and(
        eq(derivationSources.derivationId, derivations.id),
        eq(derivationSources.slot, "power"),
      ),
    )
    // INNER on the OUTPUT point: an hws-model with no output point has nowhere to write, and
    // `output_point_id` has an FK, so this drops only the (illegal) null case the old code warned
    // about.
    .innerJoin(points, eq(points.id, derivations.outputPointId))
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(eq(derivations.kind, HWS_MODEL_KIND), eq(derivations.enabled, true)),
    );

  return rows.map((r) => ({
    id: r.d.id,
    systemId: r.systemId,
    powerPoint: Point.encode(r.powerPointId),
    tempPoint: Point.encode(r.d.outputPointId!),
    tempPath: `${r.stem}/${r.metric}`,
    tempUnit: r.unit,
    tempDisplayName: r.displayName,
    options: {
      ...DEFAULT_HWS_MODEL_OPTIONS,
      ...(r.d.params as HwsModelParams),
    },
  }));
}
