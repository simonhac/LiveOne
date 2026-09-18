/**
 * "What would break if this went away?" — answered by NAMING the dependents, never by counting them.
 *
 * ## Why this exists
 *
 * Deleting a config row in this system is not a local act. A dashboard doc references areas and
 * devices by TypeID with no FK; an automation's trigger names a derivation inside jsonb with no FK;
 * `users.default_dashboard_id` HAS an FK but it is `ON DELETE SET NULL`, so the failure is a
 * silently emptied field rather than a refusal. Every one of those is invisible at delete time and
 * discovered later, by a human, as "the card is gone".
 *
 * Two prod incidents were exactly this shape. Both would have explained themselves instantly if the
 * refusal had carried the one field a bare count cannot: `via` — the column AND the path inside it.
 * So a `Dependent` always says where the reference physically lives.
 *
 * ## The split, and why it is three files
 *
 * The same split `transferOwnership` has, for the same reason: the CLI's dry run wants the list
 * without the throw.
 *
 *   - `findDependents` — pure read, returns the list. What a dry run and `liveone doctor` call.
 *   - `refuseIfReliedUpon` (`./http.ts`) — the route adapter, which parses `?force` so that no
 *     handler can forget to, and returns the 409 rather than throwing.
 *
 * There was a third, `assertNotReliedUpon`: `findDependents` then throw, "what a writer calls".
 * Nothing ever called it — every delete route reaches for the adapter, which is the better shape
 * (a route that forgets to catch turns a considered refusal into a 500). It is gone, and the
 * references that named it as the interlock now name the adapter.
 *
 * `./ledger.ts` is the census that keeps this HONEST: every column in the schema that could hold a
 * reference must be classified there, and a test fails by name when one is not. Without it this
 * file is a list of the references someone happened to remember.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";

type PgDb = ReturnType<typeof requirePlanetscaleDb>;
type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
/**
 * A connection OR an open transaction — the same seam `DeviceRegistryExec` uses.
 *
 * 🛑 This exists so the destructive caller can run the scan INSIDE its delete transaction, after
 * locking the subject row. Scanning on the pool and then deleting on a different connection is a
 * TOCTOU window: between the two, a concurrent `POST …/calendar-tokens` can commit a live feed
 * credential that the delete then CASCADEs away, having refused nothing. Found in review, not by a
 * test — the window is real but small, which is exactly the kind that survives.
 */
export type ReliedUponExec = PgDb | PgTx;
import {
  areaBindings,
  areaCalendarTokens,
  areas,
  automations,
  batteryProvenanceDaily,
  dashboardGrants,
  dashboards,
  derivationSources,
  derivations,
  derivedIntervalProvenance,
  derivedIntervals,
  deviceEvents,
  devices,
  diagnosticCaptures,
  diagnosticJobs,
  managedPollers,
  pointCommands,
  points,
  pointReadingsFlowAttr1d,
  shareTokens,
  users,
} from "@/lib/db/planetscale/schema";
import {
  Area,
  Automation,
  Dashboard,
  Derivation,
  Device,
  Point,
} from "@/lib/ids";
import { helperSiteId } from "@/lib/areas/helper-site-id";

/**
 * The pre-0053 helper `vendor_site_id` form, kept here rather than imported because
 * `helper-site-id.ts` deliberately exposes only the MINTING direction for the current encoding —
 * nothing should be able to write this form again, only recognise one already stored.
 */
const LEGACY_HELPER_PREFIX = "helper:area:";
import { scanDocRefs } from "@/lib/dashboard/doc-refs";

/** The kinds of row a delete can be refused for. */
export type Subject =
  | "area"
  | "device"
  | "dashboard"
  | "automation"
  | "derivation";

/**
 * What happens to a dependent if the delete goes ahead anyway. This is the field that decides
 * whether `--force` is reasonable, so it describes the CONSEQUENCE, not the mechanism.
 *
 * @knipignore Only used as the type of `Dependent.effect`. A consumer CAN name it without this
 * alias (`Dependent["effect"]`), so exporting it is API style, not necessity — un-export it if
 * the named form is not wanted.
 */
export type Effect =
  /** The reference stays in place and resolves to nothing; the renderer skips it, silently. */
  | "silently-dropped"
  /** An FK sets the column to NULL. The row survives, missing a field it used to have. */
  | "cleared"
  /** The reference stays and now points at nothing, with no FK to have noticed. */
  | "dangles"
  /** An FK deletes the row outright. */
  | "cascade-deleted"
  /** Someone who can read something today cannot afterwards. */
  | "loses-access";

export interface Dependent {
  kind: string;
  /** TypeID where the entity has one, else the natural key that identifies the row. */
  id: string;
  name: string | null;
  /**
   * WHERE the reference physically lives: the column, and the path inside it when the column is
   * jsonb — `"dashboards.doc → node.area"`, `"automations.trigger → source.derivationId"`. This is
   * the field that would have made both prod incidents self-explanatory.
   */
  via: string;
  effect: Effect;
  /** One line, imperative: what the operator should do instead. */
  fix: string;
}

/** Dashboards whose doc names `typeId` (`ar_…`), found by the raw-JSON walker so it fails OPEN. */
async function dashboardsReferencing(
  typeId: string,
  db: ReliedUponExec,
): Promise<Dependent[]> {
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name, doc: dashboards.doc })
    .from(dashboards);
  const hits: Dependent[] = [];
  for (const r of rows) {
    if (!scanDocRefs(r.doc).has(typeId)) continue;
    hits.push({
      kind: "dashboard",
      id: Dashboard.encode(r.id),
      name: r.name,
      via: "dashboards.doc → node.area",
      effect: "silently-dropped",
      fix: "remove or re-point that node before deleting the area",
    });
  }
  return hits;
}

/**
 * Everything that references a Device.
 *
 * ## The line this function draws: OWNED vs REFERENCED
 *
 * A device is not an area. An area's dependents are other objects that happen to point at it — a
 * calendar feed, a dashboard node, a day of Sankey — and every one of them outlives it, which is why
 * `areaDependents` refuses over all of them. A device's POINTS and their READINGS are not like that:
 * they are constitutive. A point cannot exist without its device (`points.device_id` is NOT NULL),
 * so "delete the device but keep its points" is not a state the schema can hold. Refusing over them
 * would make the verb unusable on every device that has ever recorded anything, which is all of them.
 *
 * So the rule is:
 *
 *   - **Owned** — points, their raw and aggregate readings, `device_state`, the `legacy_handles`
 *     device leg, and the device's two archives (`sessions`, `amber_forecast_history`). These are
 *     destroyed WITH the device; see `lib/devices/delete.ts` for why the archives count as owned
 *     here when the ledger files them as rows that outlive what they describe. They are not
 *     listed here as refusals; `hardDeleteDevice` reports their extent (spans, not counts) so the
 *     dry run can say what goes.
 *   - **Referenced** — anything that names the device or one of its points from OUTSIDE and would
 *     survive it. Every one of these is a refusal, named with the column it lives in and the verb
 *     that clears it.
 *
 * Every edge in `./ledger.ts` pointing at `devices.id`, `devices.rid` or `points.id`/`points.rid` is
 * accounted for by one of those two lists. That is the completeness claim, and `ledger.test.ts` is
 * what keeps it true when a column is added.
 *
 * 🛑 The hot reading tables are NOT touched here — `lib/integrity/` is not on the readings-seam
 * allowlist (`scripts/check-readings-boundary.mjs`). Extent comes from `ReadingsDao` in the writer,
 * not from this scan.
 */
async function deviceDependents(
  uuid: string,
  destructive: boolean,
  db: ReliedUponExec,
): Promise<Dependent[]> {
  const out = await dashboardsReferencing(Device.encode(uuid), db);

  // The device's own points, resolved once: several legs below ask "does anything outside name one
  // of these?", and asking the same question five times over is how the list and the delete drift.
  const ownPoints = await db
    .select({ id: points.id, rid: points.rid, name: points.name })
    .from(points)
    .where(eq(points.deviceId, uuid));
  const pointIds = ownPoints.map((p) => p.id);

  // Membership. Named under BOTH scopes and the wording differs, exactly as the area twin does:
  // archiving leaves `devices.area_id` alone and the device simply goes quiet where it stands.
  const [row] = await db
    .select({ areaId: devices.areaId, rid: devices.rid })
    .from(devices)
    .where(eq(devices.id, uuid))
    .limit(1);
  if (row?.areaId) {
    const [a] = await db
      .select({ name: areas.name, status: areas.status })
      .from(areas)
      .where(eq(areas.id, row.areaId))
      .limit(1);

    // 🛑 An ARCHIVED area is not an obstacle, and this is what makes the retirement order work.
    //
    // The warning this leg carries is "the area that holds this device would go quiet". An archived
    // area is already quiet — it serves nothing and appears in no listing — so there is nothing left
    // to lose. Without this carve-out the two lifecycles deadlocked: an area could not be archived
    // while it held its helper, and the helper could not be archived or deleted while it was in an
    // area. The supported order is now archive the AREA, then archive and delete its helper, then
    // delete the area.
    if (a?.status !== "archived")
      out.push({
        kind: "area",
        id: Area.encode(row.areaId),
        name: a?.name ?? null,
        via: "devices.area_id",
        effect: destructive ? "cascade-deleted" : "silently-dropped",
        fix: "take it out of the area first: liveone area devices remove <area> <device> --apply",
      });
  }

  if (!destructive) return out;

  // ---------------------------------------------------------------------------------------------
  // DESTRUCTIVE-ONLY. Everything below is a NO ACTION foreign key: untreated each surfaces as a raw
  // 23503 naming a constraint, which is the error this module exists to turn into a sentence.
  // ---------------------------------------------------------------------------------------------

  // A run detector or HWS model reachable from this device — by the device itself (migration 0063)
  // or by one of its points filling a slot. Not reproducible: a derivation is authored config, and
  // deleting the device would leave it pointed at nothing.
  const sourceRows = await db
    .select({
      derivationId: derivationSources.derivationId,
      name: derivations.name,
    })
    .from(derivationSources)
    .innerJoin(derivations, eq(derivations.id, derivationSources.derivationId))
    .where(
      pointIds.length > 0
        ? or(
            eq(derivationSources.deviceId, uuid),
            inArray(derivationSources.pointId, pointIds),
          )
        : eq(derivationSources.deviceId, uuid),
    );
  for (const d of new Map(sourceRows.map((r) => [r.derivationId, r])).values())
    out.push({
      kind: "derivation",
      id: Derivation.encode(d.derivationId),
      name: d.name,
      via: "derivation_sources.device_id / .point_id (NO ACTION)",
      effect: "cascade-deleted",
      fix: "delete it first: liveone derivation delete <dx_> (disable it first — that verb says so)",
    });

  // A derivation whose OUTPUT lands on one of this device's points — the HWS model's modelled
  // temperature, say. Distinct from the sources leg above: a detector can read elsewhere and write
  // here, so neither leg implies the other.
  if (pointIds.length > 0)
    for (const d of await db
      .select({ id: derivations.id, name: derivations.name })
      .from(derivations)
      .where(inArray(derivations.outputPointId, pointIds)))
      out.push({
        kind: "derivation-output",
        id: Derivation.encode(d.id),
        name: d.name,
        via: "derivations.output_point_id (NO ACTION)",
        effect: "cascade-deleted",
        fix: "delete that derivation first — its output point lives on this device",
      });

  // An area binding SELECTING one of this device's points. Authored configuration, and no recompute
  // rebuilds it — the same argument `areaDependents` makes for its own bindings leg.
  if (pointIds.length > 0)
    for (const b of await db
      .select({ areaId: areaBindings.areaId, pointUid: areaBindings.pointUid })
      .from(areaBindings)
      .where(inArray(areaBindings.pointUid, pointIds)))
      out.push({
        kind: "area-binding",
        id: Point.encode(b.pointUid),
        name: null,
        via: "area_bindings.point_uid (NO ACTION)",
        effect: "cascade-deleted",
        fix: `clear it first: liveone area role clear ${Area.encode(b.areaId)} --apply`,
      });

  // The control plane. A managed poller is what actually fetches this device; a point command is a
  // queued or historical write to it. Both NO ACTION, so both block, and both are operator state
  // rather than anything a rebuild restores.
  const [pollers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(managedPollers)
    .where(eq(managedPollers.deviceId, uuid));
  if (pollers && pollers.n > 0)
    out.push({
      kind: "managed-poller",
      id: `${pollers.n}`,
      name: null,
      via: "managed_pollers.device_id (NO ACTION)",
      effect: "cascade-deleted",
      fix: "retire the poller before the device it polls",
    });

  // 🛑 BOTH FKs, because they are INDEPENDENT. `point_commands.device_id` and `.point_id` are two
  // separate NO ACTION constraints and the schema does not enforce that the command's device owns
  // the point it names. A schema-valid row pointing at another device but at one of THESE points
  // escapes a device_id-only predicate and then blocks the point delete with a raw 23503 — which is
  // the error this module exists to replace with a sentence.
  const [cmds] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pointCommands)
    .where(
      pointIds.length > 0
        ? or(
            eq(pointCommands.deviceId, uuid),
            inArray(pointCommands.pointId, pointIds),
          )
        : eq(pointCommands.deviceId, uuid),
    );
  if (cmds && cmds.n > 0)
    out.push({
      kind: "point-command",
      id: `${cmds.n} record(s)`,
      name: null,
      via: "point_commands.device_id (NO ACTION)",
      effect: "cascade-deleted",
      fix: "the audit trail of every control write to this device — clear it deliberately",
    });

  // The retained fault record. `device_events`, `diagnostic_jobs` and `diagnostic_captures` all
  // carry a NO ACTION FK onto `devices.rid`, deliberately: these rows are EVIDENCE, and unlike
  // `agg_1d` or the flow matrix nothing recomputes them. The inverter's own event ring is a few
  // hundred records deep and the Select.live Events page a few dozen, so what a capture holds is
  // frequently the only surviving account of an outage. A device delete therefore has to name them
  // and be told again, rather than take them quietly.
  const [events] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceEvents)
    .where(eq(deviceEvents.deviceRid, row?.rid ?? -1));
  if (events && events.n > 0)
    out.push({
      kind: "device-event",
      id: `${events.n} record(s)`,
      name: null,
      via: "device_events.device_rid (NO ACTION)",
      effect: "cascade-deleted",
      fix: "the retained fault history — export it first (liveone device diagnostics export), then clear it deliberately",
    });
  const [captures] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(diagnosticCaptures)
    .where(eq(diagnosticCaptures.deviceRid, row?.rid ?? -1));
  if (captures && captures.n > 0)
    out.push({
      kind: "diagnostic-capture",
      id: `${captures.n} capture(s)`,
      name: null,
      via: "diagnostic_captures.device_rid (NO ACTION)",
      effect: "cascade-deleted",
      fix: "the original bytes behind those events; nothing re-reads them once the inverter has overwritten its ring",
    });
  const [jobs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(diagnosticJobs)
    .where(eq(diagnosticJobs.deviceRid, row?.rid ?? -1));
  if (jobs && jobs.n > 0)
    out.push({
      kind: "diagnostic-job",
      id: `${jobs.n} job(s)`,
      name: null,
      via: "diagnostic_jobs.device_rid (NO ACTION)",
      effect: "cascade-deleted",
      fix: "the record of why each acquisition was requested — clear it with the captures",
    });

  // 🛑 AUTOMATIONS, and this leg exists because THIS CHANGE invalidated the reason it did not.
  //
  // `./ledger.ts` classifies `automations.action.pointId` as deliberately-unprotected, and the
  // recorded justification is: *"a point is never deleted by a config path … so there is no delete
  // to refuse."* That was true until `hardDeleteDevice`, which IS a config path that deletes points.
  // Leaving it unscanned would let a device whose points are named only by an automation delete
  // clean, silently breaking an authored rule — the exact class the census exists to prevent. The
  // ledger entry has been corrected to say so.
  //
  // Three jsonb paths, no FK on any of them: `trigger.source.pointId`, `trigger.unless.loadPointId`
  // (the exercise trigger's third reference) and `action.pointId`. Scanned by reading the rows and
  // matching in JS rather than by a jsonb predicate, so a shape change degrades to "no match found"
  // rather than to a SQL error — and DISABLED rules are scanned too, because a disabled automation
  // is configuration that is expected to work when it is re-enabled.
  if (pointIds.length > 0) {
    const owned = new Set(pointIds);
    for (const a of await db
      .select({
        id: automations.id,
        name: automations.name,
        trigger: automations.trigger,
        action: automations.action,
      })
      .from(automations)) {
      // Through `unknown`: the columns are typed as the closed v1 vocabularies, and a structural
      // cast from those would be a compile error. Reading them as plain records is the point — this
      // scan must survive a shape it does not know about.
      const t = (a.trigger ?? {}) as unknown as Record<string, unknown>;
      const src = (t.source ?? {}) as Record<string, unknown>;
      const unless = (t.unless ?? {}) as Record<string, unknown>;
      const act = (a.action ?? {}) as unknown as Record<string, unknown>;
      const named = [src.pointId, unless.loadPointId, act.pointId].filter(
        (v): v is string => typeof v === "string" && owned.has(v),
      );
      if (named.length === 0) continue;
      out.push({
        kind: "automation",
        id: Automation.encode(a.id),
        name: a.name,
        via: "automations.trigger/.action → pointId (jsonb, no FK)",
        effect: "dangles",
        fix: "re-point or delete the automation — nothing would notice this reference breaking",
      });
    }
  }

  return out;
}

/**
 * Everything that references an Area.
 *
 * ## Why this is longer than it was
 *
 * It used to name dashboards and automations only, which was the right list for the one caller that
 * existed: `DELETE /api/v4/areas/{id}` ARCHIVED, and archiving breaks no FK and destroys no row. A
 * genuine delete is a different question, and the difference is not academic — `area_calendar_tokens`
 * is `ON DELETE CASCADE`, so a hard delete would have silently destroyed a live, in-use feed
 * credential with nothing anywhere naming it. That is precisely the failure this module exists to
 * make impossible, and the old list could not see it.
 *
 * So every edge in `./ledger.ts` that points at `areas.id` now has a leg here, and the legs divide
 * by WHY they are named rather than by mechanism:
 *
 *   - `no action` FKs (`point_readings_flow_attr_1d`, `battery_provenance_daily`) — untreated these
 *     surface as a raw Postgres 23503, a five-digit code and a constraint name. Naming them is what
 *     turns that into a sentence with a fix in it.
 *   - `cascade` FKs (calendar tokens, interval provenance) — no error at all, just silent loss.
 *   - `set null` FKs (`devices.area_id`, `users.default_area_id`) — the row survives, missing a
 *     field it used to have, and nothing says why.
 *   - no FK at all (`devices.vendor_site_id` holding `helper:area:ar_…`) — nothing notices, ever.
 */
async function areaDependents(
  uuid: string,
  destructive: boolean,
  db: ReliedUponExec,
): Promise<Dependent[]> {
  const out = await dashboardsReferencing(Area.encode(uuid), db);

  for (const a of await db
    .select({ id: automations.id, name: automations.name })
    .from(automations)
    .where(eq(automations.areaId, uuid)))
    out.push({
      kind: "automation",
      id: Automation.encode(a.id),
      name: a.name,
      via: "automations.area_id",
      effect: "dangles",
      fix: "move it with `liveone automation move`, or delete it",
    });

  // Named under BOTH scopes, but the outcome differs and so does the wording. Archiving leaves the
  // column alone and simply stops serving the area, so the devices go quiet where they stand; the
  // delete's `ON DELETE SET NULL` actually empties the column and they go ambient.
  const memberIds = new Set<string>();
  const ownHelperSiteIds = new Set([
    helperSiteId(uuid),
    `${LEGACY_HELPER_PREFIX}${uuid}`,
  ]);
  for (const d of await db
    .select({
      id: devices.id,
      name: devices.name,
      vendor: devices.vendor,
      vendorSiteId: devices.vendorSiteId,
    })
    .from(devices)
    .where(eq(devices.areaId, uuid))) {
    memberIds.add(d.id);

    // 🛑 THE AREA'S OWN HELPER IS NOT A DEPENDENT OF IT.
    //
    // A helper device exists FOR one area — `vendor_site_id` is literally `helper:area:<this area>`
    // — and it is server-managed: `ensureHelperDevice` re-homes it back the moment anything takes
    // it out, so "re-home it first" is advice that cannot be followed. Reporting it as an obstacle
    // to ARCHIVING therefore made archiving impossible for every area that has ever had battery
    // provenance, which is every area worth retiring. Archiving destroys nothing and the helper
    // simply goes quiet with the area it belongs to, so there is nothing to warn about.
    //
    // A DELETE is different: `devices.area_id` is ON DELETE SET NULL, so the helper would survive as
    // an ambient device whose site id names an area that no longer exists — the `dangles` case. It
    // is named then, and the fix is now a real verb rather than a wish.
    if (d.vendor === "helper" && ownHelperSiteIds.has(d.vendorSiteId)) {
      if (destructive)
        out.push({
          kind: "helper-device",
          id: Device.encode(d.id),
          name: d.name,
          via: "devices.area_id + devices.vendor_site_id → helper:area:ar_…",
          effect: "dangles",
          fix: `delete it first: liveone device archive ${Device.encode(d.id)} --apply, then liveone device delete ${Device.encode(d.id)} --apply`,
        });
      continue;
    }

    out.push({
      kind: "device",
      id: Device.encode(d.id),
      name: d.name,
      via: "devices.area_id",
      effect: destructive ? "cleared" : "silently-dropped",
      fix: "re-home it with `liveone area devices` first",
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Everything below is DESTRUCTIVE-ONLY.
  //
  // 🛑 The distinction is the whole reason this function takes a scope. Archiving destroys nothing:
  // the row stays, every FK stays satisfied, and the history below is exactly as readable the day
  // after as the day before. Reporting it as an obstacle to an ARCHIVE would refuse the one
  // reversible step — and, worse, would make archiving an area with history impossible, which is
  // the state every area you would ever want to retire is already in.
  // ---------------------------------------------------------------------------------------------
  if (!destructive) return out;

  // No FK — `devices.vendor_site_id` holds `helper:area:<area>` as a STRING. Nothing would notice it
  // dangling, and `ensureHelperDevice` dedupes on exactly this predicate, so the orphan would be
  // adopted by nothing and rebuilt by nothing.
  //
  // 🛑 Both halves of the predicate, including `vendor = 'helper'` — that half is the security
  // boundary described at `lib/areas/helper.ts:40`, because `vendor_site_id` is caller-supplied at
  // `POST /api/devices` and matching it alone would let one account name another's area.
  //
  // 🛑 BOTH ENCODINGS. `lib/areas/helper-site-id.ts` mints the `ar_` form and documents that the
  // raw-uuid form (`helper:area:<uuid>`, pre-migration-0053) is still accepted on read and still
  // exists in any environment that has not had 0053 applied. Matching only the minted form is the
  // classic half of a dual-accept seam: the orphan this leg exists to catch is precisely a helper
  // that is NOT also a member (a member is already named above), and a legacy-form helper outside
  // its area escapes both.
  for (const h of await db
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(
      and(
        inArray(devices.vendorSiteId, [
          helperSiteId(uuid),
          `${LEGACY_HELPER_PREFIX}${uuid}`,
        ]),
        eq(devices.vendor, "helper"),
      ),
    )) {
    if (memberIds.has(h.id)) continue; // already named by the membership leg above
    out.push({
      kind: "helper-device",
      id: Device.encode(h.id),
      name: h.name,
      via: "devices.vendor_site_id → helper:area:ar_…",
      effect: "dangles",
      fix: "delete the helper device — its site id would name an area that no longer exists",
    });
  }

  // CASCADE, and it took a review to notice it was missing from this list. A binding is AUTHORED
  // configuration — which point fills each (role, metric) slot, with its priority and transform —
  // not derived output, so it is not reproducible by any recompute. `area purge provenance` does not
  // restore it and nothing else writes it. An area can hold bindings while holding no devices at all
  // (a binding names a point, and that point's device can live elsewhere), so the membership leg
  // above does not imply this one.
  const [bindings] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(areaBindings)
    .where(eq(areaBindings.areaId, uuid));
  if (bindings && bindings.n > 0)
    out.push({
      kind: "bindings",
      id: `${bindings.n}`,
      name: null,
      via: "area_bindings.area_id (ON DELETE CASCADE)",
      effect: "cascade-deleted",
      fix: "record them first (`liveone area show <area>`) — no recompute rebuilds an authored binding",
    });

  // 🛑 THE FLOW FIREWALL. `point_readings_flow_attr_1d` is the Sankey for every complete area, and
  // NOTHING heals it: `rehealStaleAttrDays` finds work by SELECTing from this table, so a deleted
  // day is absent rather than stale and the backlog never looks for it again. The FK is NO ACTION
  // precisely so this cannot happen by accident. Report the window, not just the count.
  const [flow] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<string | null>`min(${pointReadingsFlowAttr1d.day})`,
      last: sql<string | null>`max(${pointReadingsFlowAttr1d.day})`,
    })
    .from(pointReadingsFlowAttr1d)
    .where(eq(pointReadingsFlowAttr1d.areaId, uuid));
  if (flow && flow.n > 0)
    out.push({
      kind: "flow-matrix",
      id: `${flow.n} row(s)`,
      name: flow.first && flow.last ? `${flow.first} … ${flow.last}` : null,
      via: "point_readings_flow_attr_1d.area_id (NO ACTION)",
      effect: "cascade-deleted",
      fix: `clear it deliberately first: liveone area purge flows <area> --start=${flow.first ?? "YYYY-MM-DD"} --end=${flow.last ?? "YYYY-MM-DD"} --apply`,
    });

  const [prov] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<string | null>`min(${batteryProvenanceDaily.day})`,
      last: sql<string | null>`max(${batteryProvenanceDaily.day})`,
    })
    .from(batteryProvenanceDaily)
    .where(eq(batteryProvenanceDaily.areaId, uuid));
  if (prov && prov.n > 0)
    out.push({
      kind: "battery-provenance",
      id: `${prov.n} day(s)`,
      name: prov.first && prov.last ? `${prov.first} … ${prov.last}` : null,
      via: "battery_provenance_daily.area_id (NO ACTION)",
      effect: "cascade-deleted",
      // Unlike the flow matrix this one DOES rebuild itself — the learn re-derives from a fixed
      // anchor whenever its table is empty — so the fix is a command, not a warning.
      fix: "clear it first: liveone area purge provenance <area> --apply (the learn rebuilds it)",
    });

  // CASCADE, and the reason this whole widening happened: a live credential, in use, with no
  // refusal anywhere naming it. Only LIVE tokens count — an expired or revoked one is already dead,
  // and padding a refusal with rows whose loss costs nothing is how a refusal becomes skimmable.
  for (const t of await db
    .select({
      token: areaCalendarTokens.token,
      label: areaCalendarTokens.label,
    })
    .from(areaCalendarTokens)
    .where(
      and(
        eq(areaCalendarTokens.areaId, uuid),
        isNull(areaCalendarTokens.revokedAt),
        sql`(${areaCalendarTokens.expiresAt} IS NULL OR ${areaCalendarTokens.expiresAt} > now() AT TIME ZONE 'UTC')`,
      ),
    ))
    out.push({
      kind: "calendar-feed",
      // Never the token itself — a refusal is not a place to reprint a live credential.
      id: `…${t.token.slice(-6)}`,
      name: t.label,
      via: "area_calendar_tokens.area_id (ON DELETE CASCADE)",
      effect: "cascade-deleted",
      // The URL carries the area id in its PATH and the feed checks path and token agree, so no
      // re-point can save the subscription; the honest fix is to stand the new one up first.
      fix: "mint the replacement feed on the destination area and check it renders, THEN revoke this one",
    });

  const [ip] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<Date | null>`min(${derivedIntervalProvenance.startTime})`,
      last: sql<Date | null>`max(${derivedIntervalProvenance.startTime})`,
    })
    .from(derivedIntervalProvenance)
    .where(eq(derivedIntervalProvenance.areaId, uuid));
  if (ip && ip.n > 0)
    out.push({
      kind: "interval-provenance",
      id: `${ip.n} record(s)`,
      name:
        isoDay(ip.first) && isoDay(ip.last)
          ? `${isoDay(ip.first)} … ${isoDay(ip.last)}`
          : null,
      via: "derived_interval_provenance.area_id (ON DELETE CASCADE)",
      effect: "cascade-deleted",
      fix: "what each run cost through this area's meters; rebuild with `liveone derivation recompute` if it is still wanted",
    });

  // `ON DELETE SET NULL`, and deliberately NOT the same verdict as `users.default_dashboard_id`'s
  // refusal used to imply: a blank default is a state onboarding handles. But it handles it by
  // MINTING A FRESH AREA on the next device connect (`resolveOnboardingArea`), so a cleanup that
  // does not clear this first partly undoes itself. That is worth a sentence, not a silence.
  for (const u of await db
    .select({ id: users.clerkUserId })
    .from(users)
    .where(eq(users.defaultAreaId, uuid)))
    out.push({
      kind: "user",
      id: u.id,
      name: null,
      via: "users.default_area_id",
      effect: "cleared",
      fix: "set that user another default area, or their next device connect mints a replacement",
    });

  // 🛑 There is deliberately NO derivation leg. `derivations.area_id` was the last thing that made
  // deleting an area a fact about a derivation, and 0069 dropped it: a derivation's site is its
  // OWNER DEVICE, computed from `derivation_sources`, so an area going away leaves every detector
  // it happened to sit over running exactly as before. Re-adding a leg here would report a
  // dependency that does not exist. What DOES still protect the wiring is aimed at the points
  // instead — you cannot delete a point a live derivation reads (see `pointDependents`).

  return out;
}

async function dashboardDependents(
  uuid: string,
  db: ReliedUponExec,
): Promise<Dependent[]> {
  const out: Dependent[] = [];

  // FK `ON DELETE SET NULL`. The row survives; the user simply lands somewhere else next login,
  // with nothing anywhere saying why. That silence is the whole reason this is listed.
  for (const u of await db
    .select({ id: users.clerkUserId })
    .from(users)
    .where(eq(users.defaultDashboardId, uuid)))
    out.push({
      kind: "user",
      id: u.id,
      name: null,
      via: "users.default_dashboard_id",
      effect: "cleared",
      fix: "set that user a different default dashboard first",
    });

  for (const g of await db
    .select({ userId: dashboardGrants.userId, role: dashboardGrants.role })
    .from(dashboardGrants)
    .where(eq(dashboardGrants.dashboardId, uuid)))
    out.push({
      kind: "grant",
      id: g.userId,
      name: g.role,
      via: "dashboard_grants.dashboard_id",
      effect: "loses-access",
      fix: "give them another dashboard covering the same devices, then revoke this grant — or ?force=true if the loss is intended",
    });

  for (const t of await db
    .select({ token: shareTokens.token, label: shareTokens.label })
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.dashboardId, uuid),
        isNull(shareTokens.revokedAt),
        // Live means usable NOW. An expired link is already dead, so listing it would pad the
        // refusal with rows whose loss costs nothing — and a refusal you learn to skim is worse
        // than no refusal.
        sql`(${shareTokens.expiresAt} IS NULL OR ${shareTokens.expiresAt} > now() AT TIME ZONE 'UTC')`,
      ),
    ))
    out.push({
      kind: "share-token",
      // Never the token itself — a refusal message is not a place to reprint a live credential.
      id: `…${t.token.slice(-6)}`,
      name: t.label,
      via: "share_tokens.dashboard_id",
      effect: "cascade-deleted",
      fix: "revoke the link first, so the people holding it learn it is gone deliberately",
    });

  return out;
}

/**
 * `YYYY-MM-DD` from whatever the driver hands back for an aggregated `timestamp`.
 *
 * Two hazards, and the second is the one that bites quietly:
 *
 * 🛑 `sql<Date>` is a COMPILE-TIME annotation on a raw fragment — drizzle attaches no runtime
 * decoder to it, so the value is whatever node-postgres produced, which for an aggregate is not
 * reliably a `Date`. Calling `.toISOString()` on it directly throws. `lib/readings/dao.ts` reached
 * the same conclusion for `min/max(interval_end)` and casts through `string | number | Date`.
 *
 * 🛑 But casting is not enough. Every timestamp in this database is NAIVE UTC, and the driver
 * renders one as `"2025-10-04 03:15:00"` — no zone. `new Date()` of that parses it as LOCAL time,
 * so on an AEST machine the day comes back as the 3rd. A refusal that misreports which day a year
 * of run history starts on is worse than one that says nothing, so a string is read as the naive
 * UTC it is: take the date part, construct nothing.
 */
function isoDay(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return day ? day[1] : null;
  }
  const d = value instanceof Date ? value : new Date(value as number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function derivationDependents(
  uuid: string,
  db: ReliedUponExec,
): Promise<Dependent[]> {
  const out: Dependent[] = [];

  // The one that matters. `derived_intervals.derivation_id` is ON DELETE CASCADE, so the run
  // history goes with the row — years of it, and it is only reproducible by recompute for as long
  // as the underlying readings still cover the period. Report the window, not just the count: "1
  // interval" and "1 interval, from 2025-10-04" are different decisions.
  const [span] = await db
    .select({
      n: sql<number>`count(*)::int`,
      first: sql<Date | null>`min(${derivedIntervals.startTime})`,
      last: sql<Date | null>`max(${derivedIntervals.startTime})`,
    })
    .from(derivedIntervals)
    .where(eq(derivedIntervals.derivationId, uuid));
  if (span && span.n > 0)
    out.push({
      kind: "intervals",
      id: `${span.n}`,
      name:
        isoDay(span.first) && isoDay(span.last)
          ? `${isoDay(span.first)} … ${isoDay(span.last)}`
          : null,
      via: "derived_intervals.derivation_id (ON DELETE CASCADE)",
      effect: "cascade-deleted",
      fix: "export them, or accept the loss with ?force=true — recompute only rebuilds what the readings still cover",
    });

  const [row] = await db
    .select({ outputPointId: derivations.outputPointId })
    .from(derivations)
    .where(eq(derivations.id, uuid))
    .limit(1);
  if (row?.outputPointId) {
    const [p] = await db
      .select({ id: points.id, name: points.name })
      .from(points)
      .where(eq(points.id, row.outputPointId))
      .limit(1);
    if (p)
      out.push({
        kind: "point",
        id: Point.encode(p.id),
        name: p.name,
        via: "derivations.output_point_id",
        effect: "dangles",
        // The FK on this column points the OTHER way: it refuses deleting the POINT while the
        // derivation names it, and says nothing about deleting the derivation. So the point row
        // survives, nothing writes to it any more, and it freezes at its last value while still
        // reading as live — which is why it is named here.
        fix: "deactivate the derived point too, or it freezes at its last value and still reads as live",
      });
  }

  // jsonb, no FK: `evaluate.ts` already logs "did not resolve to an enabled run detector" and
  // carries on, so the automation would quietly stop firing rather than fail.
  for (const a of await db
    .select({ id: automations.id, name: automations.name })
    .from(automations)
    .where(
      sql`${automations.trigger} -> 'source' ->> 'derivationId' = ${uuid}`,
    ))
    out.push({
      kind: "automation",
      id: Automation.encode(a.id),
      name: a.name,
      via: "automations.trigger → source.derivationId",
      effect: "silently-dropped",
      fix: "re-point or delete that automation — it stops firing with no error",
    });

  return out;
}

/**
 * Everything that references `uuid`, named.
 *
 * Read-only and safe to call on any path, including a dry run. An empty array means the delete is
 * covered by FKs and nothing else — not that nothing was checked; `./ledger.ts` is what proves the
 * difference.
 */
export async function findDependents(
  subject: Subject,
  uuid: string,
  opts: { destructive?: boolean; exec?: ReliedUponExec } = {},
): Promise<Dependent[]> {
  const db = opts.exec ?? requirePlanetscaleDb();
  switch (subject) {
    case "device":
      // Same scope split as `area`: the ARCHIVE question is config references only, because
      // archiving a device destroys nothing. Only `DELETE /api/v4/devices/{id}` passes `destructive`.
      return deviceDependents(uuid, opts.destructive === true, db);
    case "area":
      // Defaults to the ARCHIVE scope, because that is what every pre-existing caller means. Only
      // `DELETE /api/v4/areas/{id}` passes `destructive`, and it is the only caller that destroys a
      // row rather than hiding one.
      return areaDependents(uuid, opts.destructive === true, db);
    case "dashboard":
      return dashboardDependents(uuid, db);
    case "derivation":
      return derivationDependents(uuid, db);
    case "automation":
      // Nothing references an automation today. Wired anyway, so that the NEXT thing to reference
      // one has an obviously wrong-looking empty case to fill in rather than a missing file.
      return [];
  }
}
