/**
 * The reference census: EVERY column in the schema that could hold a reference, and what protects it.
 *
 * ## Why a census rather than a list
 *
 * The list this replaces had three entries. It was wrong on one of them (`users.default_dashboard_id`
 * DOES have an FK — the failure is a silently cleared column, not a dangling one) and missing a
 * fourth (`automations.trigger`, which names a derivation inside jsonb with no FK at all). A
 * hand-kept list of soft references is a list of the ones somebody remembered.
 *
 * So the completeness claim is mechanical instead. `referenceCandidates()` derives, from the schema
 * itself, every column that COULD hold a reference — every `uuid`, every `jsonb`, and every column
 * whose name ends `_id` / `_rid` / `_by`, minus the columns that are a row's own identity (part of
 * the primary key with no FK of their own). `ledger.test.ts` then asserts, BY NAME, that each one
 * appears here exactly once and that each here still exists. Adding a column with a reference in it
 * and not saying what protects it is a failing test, not a future incident.
 *
 * This is `cliTokenRoutes`' posture applied to references: "the known ones" becomes "proven complete
 * at the column level".
 *
 * ## 🛑 Why this file is exempted from the readings-seam wall (twice)
 *
 * A census must name EVERY table, including the three hot time-series tables that
 * `scripts/check-readings-boundary.mjs` and the `no-restricted-imports` rule in `.eslintrc.json`
 * wall off. A census that skipped three tables would be precisely the failure it exists to prevent,
 * so both gates carry an entry for this path — the mjs one in `isStructurallyAllowed`, the ESLint
 * one in `overrides`.
 *
 * What makes that safe is not the intent, it is that this module CANNOT READ. It imports table
 * objects to introspect column names and never a database client or a query builder, so there is no
 * access path here to wall off. `__tests__/ledger.test.ts` asserts exactly that — "the census cannot
 * become an access path". **If that assertion is deleted, both exemptions must be deleted with it.**
 *
 * ## The three verdicts
 *
 *   - `fk` — Postgres enforces it. The test PROVES this one against `getTableConfig`, so it cannot
 *     be claimed falsely; `onDelete` is recorded because `set null` and `cascade` and `no action`
 *     are three different user-visible outcomes, not an implementation detail.
 *   - `refuseIfReliedUpon` — no FK, or an FK whose action is itself the hazard. A delete route
 *     names this dependent and 409s (see `./http.ts`, over `findDependents` in `./relied-upon.ts`).
 *   - `deliberately-unprotected` — a reference in the loose sense that is CORRECT to leave loose,
 *     with the reason. Mostly logs, buffers and archives: rows whose whole job is to record what
 *     was true at a moment, and which must survive the disappearance of what they described.
 *
 * ## The jsonb rule
 *
 * No census can see inside jsonb, so every jsonb column must additionally supply either `extract`
 * (pull the raw ids out of a stored value) or `holdsNoRefs` (a reason it holds none). Bounded and
 * enumerable — there are 27 of them.
 */
import { getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig, type AnyPgColumn } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/planetscale/schema";
import {
  amberForecastHistory,
  areaBindings,
  areas,
  areaCalendarTokens,
  automations,
  batteryProvenanceDaily,
  dashboardGrants,
  dashboardRevisions,
  dashboards,
  derivations,
  derivationSources,
  derivedIntervalProvenance,
  derivedIntervals,
  deviceEvents,
  deviceState,
  devices,
  diagnosticCaptures,
  diagnosticJobs,
  legacyHandles,
  managedPollers,
  observationsOutbox,
  pointCommands,
  pointReadings,
  pointReadingsAgg1d,
  pointReadingsAgg5m,
  pointReadingsFlowAttr1d,
  points,
  sessions,
  shareTokens,
  users,
} from "@/lib/db/planetscale/schema";
import { scanDocRefs } from "@/lib/dashboard/doc-refs";
import type { Subject } from "./relied-upon";

type Verdict =
  | { protectedBy: "fk"; onDelete: "cascade" | "set null" | "no action" }
  | { protectedBy: "refuseIfReliedUpon"; subject: Subject; reason: string }
  | { protectedBy: "deliberately-unprotected"; reason: string };

export interface LedgerEntry {
  /**
   * The COLUMN ITSELF, not its name.
   *
   * A drizzle column carries both its SQL name and its table, so one field gives the whole address
   * — and a rename or a drop becomes a compile error here rather than a ledger entry that quietly
   * describes a column nobody has any more. It also means this file contains no raw table strings,
   * which is what keeps it on the right side of the readings-boundary check: the ledger is a
   * statement ABOUT the schema, never an access path into it.
   */
  column: AnyPgColumn;
  verdict: Verdict;
  /** jsonb only: the raw ids a stored value references. Exactly one of this and `holdsNoRefs`. */
  extract?: (value: unknown) => string[];
  /** jsonb only: why this column provably holds no reference. */
  holdsNoRefs?: string;
}

/** `table.column`, the address both the census and the ledger are keyed by. */
export function columnKey(column: AnyPgColumn): string {
  return `${getTableName(column.table)}.${column.name}`;
}

/** A column the schema says could hold a reference. Derived, never hand-listed. */
export interface Candidate {
  table: string;
  column: string;
  /** drizzle's column type, e.g. `PgUUID`, `PgJsonb`, `PgText`. */
  columnType: string;
  /** Present iff Postgres enforces this column as a foreign key. */
  fkOnDelete?: "cascade" | "set null" | "no action";
}

/** `_by` is in here because a person-reference rarely ends `_id` — `requested_by`, `saved_by`. */
const REFERENCE_SHAPED_NAME = /(_id|_rid|_by)$/;

/**
 * Every column that could hold a reference, read out of the schema.
 *
 * Three rules, and the exclusion is the one that needs stating carefully:
 *
 * 1. **Any column with a foreign key is a candidate**, whatever it is named and whatever its type.
 *    A reference Postgres already knows about must never depend on the naming heuristic below to be
 *    seen — the heuristic exists to catch the ones the database does NOT know about.
 * 2. Otherwise, `uuid` / `jsonb` / a name ending `_id`, `_rid` or `_by`.
 * 3. Minus a row's own identity — but ONLY a **single-column** primary key with no FK.
 *
 * 🛑 That last rule used to read "part of the primary key", and it was wrong in the way this whole
 * module exists to prevent: it silently excluded `dashboard_grants.user_id`, a Clerk user reference
 * with no FK sitting inside a composite PK, while every completeness assertion kept passing. In a
 * join table the composite key IS a pair of references — that is what makes it a join table — so
 * only a lone PK column can be identity. `areas.id` and `users.clerk_user_id` stay out;
 * `dashboard_grants.user_id` and `derived_intervals.derivation_id` come in.
 */
export function referenceCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value as never);
    const fks = new Map<string, "cascade" | "set null" | "no action">();
    for (const fk of cfg.foreignKeys) {
      const action = (fk.onDelete ?? "no action") as
        | "cascade"
        | "set null"
        | "no action";
      for (const c of fk.reference().columns) fks.set(c.name, action);
    }
    // The row's own identity can only be a LONE primary-key column. A composite PK is a tuple of
    // references, so none of its members is excluded on identity grounds.
    const pkColumns = [
      ...cfg.columns.filter((c) => c.primary).map((c) => c.name),
      ...cfg.primaryKeys.flatMap((k) => k.columns.map((c) => c.name)),
    ];
    const soleIdentity = pkColumns.length === 1 ? pkColumns[0] : null;
    for (const c of cfg.columns) {
      const shaped =
        fks.has(c.name) ||
        c.columnType === "PgUUID" ||
        c.columnType === "PgJsonb" ||
        REFERENCE_SHAPED_NAME.test(c.name);
      if (!shaped) continue;
      if (c.name === soleIdentity && !fks.has(c.name)) continue;
      out.push({
        table: cfg.name,
        column: c.name,
        columnType: c.columnType,
        ...(fks.has(c.name) ? { fkOnDelete: fks.get(c.name) } : {}),
      });
    }
  }
  return out.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table),
  );
}

// ---------------------------------------------------------------------------
// jsonb extractors. Each walks the SHAPE THE WRITER STORES, not a generic uuid scan: a scan would
// also hit ids embedded in a vendor payload or a saved label, and a reference that isn't followed
// isn't a reference.
// ---------------------------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `{source: {kind:"derivation", derivationId} | {kind:"point", pointId}}`, plus exercise's load point. */
function automationTriggerRefs(value: unknown): string[] {
  const t = asRecord(value);
  if (!t) return [];
  const out: string[] = [];
  const source = asRecord(t.source);
  if (source) {
    const id = str(source.derivationId) ?? str(source.pointId);
    if (id) out.push(id);
  }
  // The `exercise` trigger (PR #446) added a THIRD point reference, on a nested object — which is
  // exactly the drift this census exists to catch.
  const unless = asRecord(t.unless);
  const load = unless ? str(unless.loadPointId) : null;
  if (load) out.push(load);
  return out;
}

export const REFERENCE_LEDGER: LedgerEntry[] = [
  // -- Archives, buffers and logs. Every one of these records what was true at a moment, and must
  //    outlive whatever it described. An FK here would turn a config delete into a data loss.
  {
    column: amberForecastHistory.deviceRid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: observationsOutbox.deviceRid,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "an outbox is a BUFFER — the schema comment says no FK is to be added, because one would turn a device delete into an ingest-path failure and make a stale published row a migration blocker. Reachability into `devices` is advisory, never gating.",
    },
  },
  {
    column: observationsOutbox.sessionId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "same buffer argument, and it is NULL for the no-collector publish path anyway.",
    },
  },
  {
    column: observationsOutbox.payload,
    holdsNoRefs:
      "a verbatim QueueMessage awaiting republication. It carries `systemId` (a device rid), but as the message's own addressing, not as config pointing at config — the relay republishes the bytes unchanged and never resolves them.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "buffer contents, republished verbatim.",
    },
  },
  {
    column: managedPollers.collectorId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: managedPollers.deviceId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: managedPollers.vendorSiteId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Vendor-owned delivery identity copied from the FK-protected device at assignment creation, not a reference to a separate LiveOne row.",
    },
  },
  {
    column: managedPollers.settings,
    holdsNoRefs:
      "Strict collector settings contain network hosts, inverter flags, region/auth enums and timing values; no LiveOne row identifiers are accepted.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Device connection and cadence configuration, with device ownership carried by the separate device_id foreign key.",
    },
  },
  {
    column: managedPollers.status,
    holdsNoRefs:
      "Strict status snapshots contain counters, timestamps, flags and error enums. Their id repeats the owning poller's identity, checked on ingestion; the stored id is never resolved as a dependent reference.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Latest diagnostic snapshot of this poller, retained on deletion for shutdown acknowledgement.",
    },
  },
  {
    column: sessions.deviceRid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: sessions.response,
    holdsNoRefs:
      "the raw vendor API payload, archived exactly as received. Vendor ids inside it are the VENDOR's, and nothing in this system resolves them.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "an archive of foreign bytes.",
    },
  },
  {
    column: pointCommands.pointId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointCommands.deviceId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointCommands.requestedBy,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "an audit column: a Clerk user id, OR the literal form `automation:au_…` for evaluator-issued commands — so it is a soft reference to an automation as well as to a user. Deliberately loose: the log must still say who asked after the asker is gone, and a command's history is the one thing that must not be edited by a later delete.",
    },
  },
  {
    column: pointCommands.vendorResult,
    holdsNoRefs:
      "the raw vendor response envelope, stored so a benign `result:false` is auditable. Vendor ids inside it are the vendor's own and nothing here resolves them.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "an archive of foreign bytes.",
    },
  },
  {
    column: deviceState.deviceId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: deviceState.lastResponse,
    holdsNoRefs:
      "the last raw vendor payload, on the same terms as `sessions.response` — foreign bytes, kept verbatim, resolved by nothing in this system.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "an archive of foreign bytes.",
    },
  },

  // -- The hot time-series tables. rid-keyed, FK'd, and never deleted by a config path.
  {
    column: pointReadings.pointRid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointReadings.sessionId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointReadingsAgg5m.pointRid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointReadingsAgg5m.sessionId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "provenance of the reading that produced the bucket, not a live pointer — unlike `point_readings.session_id` it carries no FK, and an aggregate outlives the session that seeded it.",
    },
  },
  {
    column: pointReadingsAgg1d.pointRid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: pointReadingsFlowAttr1d.areaId,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "area",
      reason:
        "🛑 The FK is NO ACTION and stays that way — but an FK that refuses is not the same as an outcome anyone can read. Untreated, deleting an area with flow rows surfaces as a 23503 and a constraint name. This is the SANKEY for every complete area and NOTHING heals it: `rehealStaleAttrDays` finds work by SELECTing from this table, so a deleted day is absent rather than stale and the backlog never looks for it again. Named (destructive scope only) so the refusal carries the day window and the purge command that clears it.",
    },
  },
  {
    column: batteryProvenanceDaily.areaId,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "area",
      reason:
        "Same NO ACTION firewall as the flow matrix, and named for the same reason — but the consequence is milder and the fix says so: the battery learn rebuilds from a fixed anchor whenever its table is empty, so this is a purge-then-delete, not a loss. Destructive scope only; archiving destroys none of it.",
    },
  },
  {
    column: batteryProvenanceDaily.foldState,
    holdsNoRefs:
      "the fold's checkpoint: learned scalars (efficiency, capacity, idle loss, reserve floor) and nothing addressable.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "numeric checkpoint state.",
    },
  },

  // -- Config: areas, devices, points, bindings, membership.
  {
    column: areas.ownerUserId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Clerk owns the user record; there is no local `users` row to FK against for an owner (the `users` table is a Clerk MIRROR keyed by clerk_user_id, written on demand). Ownership is re-pointed by `transferOwnership`, never by a cascade.",
    },
  },
  {
    column: areas.config,
    holdsNoRefs:
      "`AreaConfig` is `{batteryProvenance?}` — intensities, prices, fractions and tariff modes. Every field is a scalar or a closed enum; nothing addresses another row.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: areas.location,
    holdsNoRefs:
      "latitude, longitude and state — geography, not identity. The NEM region is DERIVED from it at read time rather than stored as a reference.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: areaBindings.areaId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: areaBindings.pointUid,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: devices.ownerUserId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Clerk owns the user record; the local `users` table is a mirror written on demand, so there is nothing to FK an owner against. Ownership is re-pointed by `transferOwnership`, never by a cascade.",
    },
  },
  {
    column: devices.vendorSiteId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "the VENDOR's id for this site. Foreign identity: nothing in this database can enforce it and nothing here resolves it.",
    },
  },
  {
    // The Home-Assistant-shaped edge (migration 0070), and since 0074 the ONLY device→area edge:
    // 0 or 1 area per device. SET NULL rather than NO ACTION because NULL is a first-class state
    // here — deleting an area moves its devices to the unassigned bucket instead of blocking the
    // delete. That is not weaker than the `primary_area_id` NO ACTION it replaced: nothing derived
    // hangs off this column. The area-keyed derived tables key on their OWN `area_id`, and
    // `point_readings_flow_attr_1d`'s NO ACTION firewall is untouched.
    // ⚠️ Also named by `areaDependents` under BOTH scopes — archiving strands the devices in an
    // unserved area, deleting empties the column — because "set null" describes the mechanism and
    // says nothing about the device going quiet.
    column: devices.areaId,
    verdict: { protectedBy: "fk", onDelete: "set null" },
  },
  {
    column: devices.config,
    holdsNoRefs:
      "`DeviceConfig` — capability overrides keyed by capability ID, a structured physical spec, and the battery-provenance scalars. Capability IDs are a code vocabulary, not rows.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: devices.adapterState,
    holdsNoRefs:
      "the vendor adapter's own cursor/token state, opaque to everything above the adapter and meaningful only to the vendor it was minted against.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "opaque adapter state.",
    },
  },
  {
    column: points.deviceId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: points.control,
    holdsNoRefs:
      "`PointControl` is a closed union describing the writable surface (`switch` / `number` / `button`) — bounds and a kind, no ids.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: legacyHandles.deviceId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: legacyHandles.areaId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },

  // -- Dashboards, grants, shares.
  {
    column: dashboards.ownerUserId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "Clerk owns the user record; the local `users` table is a mirror written on demand, so there is nothing to FK an owner against. Ownership is re-pointed by `transferOwnership`, never by a cascade.",
    },
  },
  {
    column: dashboards.doc,
    extract: (v) => [...scanDocRefs(v)],
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "area",
      reason:
        "the doc names areas and devices by TypeID with no FK. A deleted area leaves the node in place, resolving to nothing, and the renderer simply skips it — the silent failure this whole module exists for.",
    },
  },
  {
    column: dashboardRevisions.dashboardId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: dashboardRevisions.doc,
    extract: (v) => [...scanDocRefs(v)],
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "a revision is HISTORY: it records what the doc said then, including refs that have since been deleted. Repairing one would falsify the record, and refusing a delete because an old revision mentions it would make the undo history a lock.",
    },
  },
  {
    column: dashboardRevisions.savedBy,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "provenance, and not always a Clerk id (the schema comment says so) — an audit string, like `point_commands.requested_by`.",
    },
  },
  {
    column: dashboardGrants.dashboardId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    // 🛑 The column that exposed the old identity rule: half of a composite PK, no FK, and a real
    // reference. It is listed as unprotected for the same reason as every other owner/grantee
    // column — Clerk owns the user record and nothing here deletes one — but the point is that the
    // census now MAKES that a decision rather than an omission.
    column: dashboardGrants.userId,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "a Clerk user id. Clerk owns the user record and this system never deletes one, so there is no delete to refuse; the local `users` table is a mirror written on demand and is not an FK target for grantees.",
    },
  },
  {
    column: shareTokens.dashboardId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: areaCalendarTokens.areaId,
    // CASCADE, like a dashboard's share tokens: a feed token grants "the schedule of THIS area"
    // and nothing else, so once the area is gone the token grants nothing. Leaving it behind would
    // be a live credential pointing at a row that cannot be read — revocable by nobody, because
    // every management verb is scoped through the area that no longer exists.
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "area",
      reason:
        "🛑 This entry is why the area dependent list was widened at all. The CASCADE is correct and unchanged, but it is SILENT: a hard delete would destroy a live, in-use feed credential with no refusal, no warning and — per the iCloud behaviour — no symptom at the subscriber beyond 'Last updated: Never'. Named in the destructive scope only (archiving keeps the feed working), and only for tokens that are neither revoked nor expired, since a dead link costs nothing to lose.",
    },
  },
  {
    // Migration 0070. Identical interior to `areas.location`, and identical reasoning: it is the
    // OWNER tier of the placement chain, so it holds geography rather than identity.
    column: users.location,
    holdsNoRefs:
      "latitude, longitude and state — geography, not identity. The NEM region is DERIVED from it at read time rather than stored as a reference.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: users.defaultDashboardId,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "dashboard",
      reason:
        "🛑 It HAS an FK — `ON DELETE SET NULL` — which is precisely why it needs naming anyway. The FK guarantees the column never dangles, and that is the whole problem: the user's default is silently emptied and they land somewhere else at next login with nothing saying why. An enforced constraint is not the same as a visible outcome.",
    },
  },
  {
    // The same shape as `defaultDashboardId` above, and deliberately NOT given the same verdict.
    // Emptying this one is recoverable by design: `resolveOnboardingArea` treats a blank default as
    // "no default recorded" and mints a site for the next connection, so the outcome of deleting
    // the area is an extra area, not a user stranded somewhere they did not choose.
    column: users.defaultAreaId,
    // ⚠️ The reasoning above survives the arrival of a HARD delete, and the verdict is deliberately
    // left as the FK: emptying this column is still recoverable by design. But `areaDependents`
    // names it anyway in the destructive scope, because the recovery works by MINTING A FRESH AREA
    // on the next device connect — so a cleanup that does not clear this first partly undoes itself,
    // which is a thing worth one sentence in a refusal rather than a surprise a fortnight later.
    verdict: { protectedBy: "fk", onDelete: "set null" },
  },

  // -- Derivations and automations.
  // 🛑 `derivations.area_id` is NOT missing from this census — 0069 dropped the column, so it is
  // not a candidate. 0063 had already demoted it to a vestige nothing resolved a derivation
  // through, and the protection it was standing in for MOVED rather than vanished:
  // `derivation_sources.point_id` below refuses to let you delete a point a live derivation reads,
  // which is a better aim than "refuse to delete the area we happened to stamp on it".
  {
    column: derivations.outputPointId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },

  // -- derivation_sources (0063): the typed input ports that replace `derivations.source_points`.
  // Every column here is a reference, and every one is a `fk` — which is the entire point of the
  // table. The jsonb it replaces could name a point on any device, or none at all, and nothing
  // noticed until the detector silently derived nothing forever.
  {
    column: derivationSources.derivationId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: derivationSources.pointId,
    // 🛑 The composite FK (point_id, device_id) → points(id, device_id), ON DELETE NO ACTION. This
    // is where `derivations.area_id`'s protection went, and it is better aimed: "you cannot delete
    // a point a live derivation reads" rather than "you cannot delete the area the detector was
    // filed under". `derivation_sources_point_idx` is what lets a refusal NAME the dependents.
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: derivationSources.kind,
    // 🛑 Not a reference to anything you could dangle — it is a COPY of `derivations.kind`, and the
    // census sees it only because it is a leg of the composite FK (derivation_id, kind, role) that
    // proves the copy. Recorded rather than exempted: an FK leg is exactly the kind of column a
    // hand-kept list drops, and the copy is what the per-kind slot CHECK is written against.
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: derivationSources.role,
    // Same composite FK as `kind`, and the reason FK 1 exists separately: this leg is NULLABLE (the
    // hws-model has no role), the FK is MATCH SIMPLE, and MATCH SIMPLE is not checked AT ALL when
    // any leg is NULL. So for an hws-model source row this constraint proves NOTHING, and the
    // plain `derivation_id` FK is the only thing holding it to a parent.
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: derivationSources.deviceId,
    // Not an independent reference: it is the second leg of the same composite FK as `point_id`,
    // which is what PROVES it equals `points.device_id` rather than merely copying it. Reaching
    // `devices` at all is a consequence of that, not a separate claim — and it is why deriving a
    // detector's site from this column is sound.
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: derivations.params,
    holdsNoRefs:
      "detector knobs (thresholds in W, delays in seconds) and the HWS model's options. Scalars only.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "scalar configuration.",
    },
  },
  {
    column: derivedIntervals.derivationId,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: derivedIntervalProvenance.derivationId,
    // Half of the composite FK onto `derived_intervals(derivation_id, start_time)`, which is what
    // makes a recompute's bounded delete take this table's rows with it.
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    // The OTHER half, and a census candidate only because of it — a timestamp is not otherwise
    // reference-shaped. It is here because rule 1 is "any column with a foreign key", which is
    // exactly right: half a composite reference is still a reference, and leaving it undeclared
    // would leave the pair half-described.
    column: derivedIntervalProvenance.startTime,
    verdict: { protectedBy: "fk", onDelete: "cascade" },
  },
  {
    column: derivedIntervalProvenance.areaId,
    // CASCADE, unlike `automations.area_id`'s no-action, and the difference is what the row MEANS:
    // this is derived output ABOUT an area (what a run cost through its meters), fully reproducible
    // by a recompute, so deleting the area should take its answers with it rather than block on them.
    // An automation, by contrast, is configuration a user authored and would not expect to vanish.
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "area",
      reason:
        "The CASCADE above is still the right mechanism and is unchanged — reproducible derived output should follow its area rather than block on it. What the cascade cannot do is SAY SO. Named in the destructive scope only, so a hard delete reports how many runs were priced through this area and over what window before it takes them; archiving leaves every row in place.",
    },
  },
  {
    column: automations.areaId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: automations.trigger,
    extract: automationTriggerRefs,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "derivation",
      reason:
        "jsonb, no FK, and three separate point/derivation references (`source.derivationId`, `source.pointId`, `unless.loadPointId`). `evaluate.ts` logs 'did not resolve to an enabled run detector' and carries on, so a broken trigger stops firing rather than failing.",
    },
  },
  {
    column: automations.action,
    extract: (v) => {
      const a = asRecord(v);
      const id = a ? str(a.pointId) : null;
      return id ? [id] : [];
    },
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "`action.pointId` has no FK. It used to say a point is never deleted by a config path, so there was no delete to refuse — that stopped being true when `hardDeleteDevice` shipped, which deletes a device's points outright. `deviceDependents` now scans this path (and the two in `trigger`) against the device's owned points and REFUSES, so the protection is real rather than incidental; the verdict stays unprotected because it is the scan, not a constraint, that provides it.",
    },
  },
  {
    column: automations.armedContext,
    holdsNoRefs:
      "per-decision state: a baseline counter reading, or an exercise slot's outcome and evidence. Timestamps and numbers.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "decision log.",
    },
  },
  // The retained fault record (migration 0078). Every `device_rid` here is a REAL FK with NO ACTION,
  // which is the same posture as `sessions` and deliberately NOT the outbox's: these rows are
  // evidence of what the equipment reported, they are not reproducible by any recompute, and the
  // inverter ring they came from overwrites itself. A device delete must be told twice —
  // `deviceDependents` names each of them with a count.
  {
    column: deviceEvents.deviceRid,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "device",
      reason:
        "NO ACTION, and named by `deviceDependents` (destructive scope) with a count so the refusal is a sentence rather than a 23503. the retained fault history — every event this device's portal page and internal logs have reported. Nothing recomputes it: the inverter's event ring is a few hundred records deep and overwrites itself, and the Select.live Events page retains a few dozen rows, so a capture is frequently the only surviving account of an outage.",
    },
  },
  {
    column: deviceEvents.captureId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: deviceEvents.snapshot,
    holdsNoRefs:
      "the decoded electrical/state snapshot the inverter attached to one event — volts, amps, kW, SOC, and coded states with their labels. Vendor measurements; it names nothing in this database.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "vendor measurements recorded at an instant.",
    },
  },
  {
    column: diagnosticJobs.deviceRid,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "device",
      reason:
        "NO ACTION, and named by `deviceDependents` (destructive scope) with a count so the refusal is a sentence rather than a 23503. the record of why each acquisition was requested. Nothing recomputes it: the inverter's event ring is a few hundred records deep and overwrites itself, and the Select.live Events page retains a few dozen rows, so a capture is frequently the only surviving account of an outage.",
    },
  },
  {
    column: diagnosticJobs.requestedBy,
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason:
        "not a person or a row — a closed vocabulary ('trigger' | 'cli' | 'baseline'), CHECK-constrained, saying which PATH asked for the acquisition. It matches the `_by` census rule by name only.",
    },
  },
  {
    column: diagnosticJobs.reasons,
    holdsNoRefs:
      "an append-only array of `{ kind, detail, observedAt }` — the trigger transitions that coalesced onto this job, as free text for a human. No ids.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "a reason log.",
    },
  },
  {
    column: diagnosticCaptures.deviceRid,
    verdict: {
      protectedBy: "refuseIfReliedUpon",
      subject: "device",
      reason:
        "NO ACTION, and named by `deviceDependents` (destructive scope) with a count so the refusal is a sentence rather than a 23503. the original bytes read from the inverter, and the metadata that says how trustworthy they are. Nothing recomputes it: the inverter's event ring is a few hundred records deep and overwrites itself, and the Select.live Events page retains a few dozen rows, so a capture is frequently the only surviving account of an outage.",
    },
  },
  {
    column: diagnosticCaptures.jobId,
    verdict: { protectedBy: "fk", onDelete: "no action" },
  },
  {
    column: diagnosticCaptures.identity,
    holdsNoRefs:
      "what the INVERTER reported about itself: serial, firmware and log-format versions. Vendor identity, not ours.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "vendor self-report.",
    },
  },
  {
    column: diagnosticCaptures.metadata,
    holdsNoRefs:
      "per-log ring descriptors before and after the walk, plus anchor-stability flags. Memory addresses and counts inside the inverter; nothing in this database.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "acquisition bookkeeping.",
    },
  },
  {
    column: diagnosticCaptures.scales,
    holdsNoRefs:
      "the six measurement scaling factors read from the inverter. Integers.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "vendor scaling constants.",
    },
  },
  {
    column: diagnosticCaptures.clock,
    holdsNoRefs:
      "the inverter's clock reading and its measured offset from ours. Timestamps and a number.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "a clock observation.",
    },
  },
  {
    column: diagnosticCaptures.coverage,
    holdsNoRefs:
      "per-log counts, why the walk stopped, and whether the overlap with the previous capture was observed. Also echoes the job's reasons as free text. Counts and enum strings.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "acquisition bookkeeping.",
    },
  },
  {
    column: diagnosticCaptures.raw,
    holdsNoRefs:
      "the immutable record stream, `{ log, address, hex }[]` — bytes as read from the inverter's memory. The `address` is a word address INSIDE the inverter, not a row anywhere here.",
    verdict: {
      protectedBy: "deliberately-unprotected",
      reason: "original bytes.",
    },
  },
];
