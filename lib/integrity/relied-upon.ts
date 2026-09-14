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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
  derivations,
  derivedIntervalProvenance,
  derivedIntervals,
  devices,
  points,
  pointReadingsFlowAttr1d,
  shareTokens,
  users,
} from "@/lib/db/planetscale/schema";
import { Area, Automation, Dashboard, Device, Point } from "@/lib/ids";
import { helperSiteId } from "@/lib/areas/helper-site-id";

/**
 * The pre-0053 helper `vendor_site_id` form, kept here rather than imported because
 * `helper-site-id.ts` deliberately exposes only the MINTING direction for the current encoding —
 * nothing should be able to write this form again, only recognise one already stored.
 */
const LEGACY_HELPER_PREFIX = "helper:area:";
import { scanDocRefs } from "@/lib/dashboard/doc-refs";

/** The kinds of row a delete can be refused for. */
export type Subject = "area" | "dashboard" | "automation" | "derivation";

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
  for (const d of await db
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(eq(devices.areaId, uuid))) {
    memberIds.add(d.id);
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
