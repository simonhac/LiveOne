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
 *   - `assertNotReliedUpon` — the same, then throws `ReliedUponError`. What a writer calls.
 *   - `refuseIfReliedUpon` (`./http.ts`) — the route adapter, which parses `?force` so that no
 *     handler can forget to.
 *
 * `./ledger.ts` is the census that keeps this HONEST: every column in the schema that could hold a
 * reference must be classified there, and a test fails by name when one is not. Without it this
 * file is a list of the references someone happened to remember.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  automations,
  dashboardGrants,
  dashboards,
  derivations,
  derivedIntervals,
  points,
  shareTokens,
  users,
} from "@/lib/db/planetscale/schema";
import { Area, Automation, Dashboard, Derivation, Point } from "@/lib/ids";
import { scanDocRefs } from "@/lib/dashboard/doc-refs";

/** The kinds of row a delete can be refused for. */
export type Subject = "area" | "dashboard" | "automation" | "derivation";

/**
 * What happens to a dependent if the delete goes ahead anyway. This is the field that decides
 * whether `--force` is reasonable, so it describes the CONSEQUENCE, not the mechanism.
 *
 * @knipignore The type of Dependent.effect, which is exported — a consumer cannot name the field's type without it.
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

/** @knipignore Thrown only by assertNotReliedUpon, so it lives or dies with it. */
export class ReliedUponError extends Error {
  constructor(
    message: string,
    readonly dependents: Dependent[],
  ) {
    super(message);
    this.name = "ReliedUponError";
  }
}

/** Dashboards whose doc names `typeId` (`ar_…`), found by the raw-JSON walker so it fails OPEN. */
async function dashboardsReferencing(typeId: string): Promise<Dependent[]> {
  const rows = await requirePlanetscaleDb()
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

async function areaDependents(uuid: string): Promise<Dependent[]> {
  const db = requirePlanetscaleDb();
  const out = await dashboardsReferencing(Area.encode(uuid));

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
      fix: "delete the automation, or move it to another area",
    });

  // 🛑 Until migration 0064 drops the column, at which point this leg must be DELETED, not left to
  // "find nothing": the column will not exist, so an un-migrated deployment gets a 42703 and a
  // migrated one gets a compile error here. It is listed in the block-model increment-1 plan as
  // part of the contract step for exactly that reason.
  for (const d of await db
    .select({ id: derivations.id, name: derivations.name })
    .from(derivations)
    .where(eq(derivations.areaId, uuid)))
    out.push({
      kind: "derivation",
      id: Derivation.encode(d.id),
      name: d.name,
      via: "derivations.area_id",
      effect: "dangles",
      fix: "delete the derivation, or move it to another area",
    });

  return out;
}

async function dashboardDependents(uuid: string): Promise<Dependent[]> {
  const db = requirePlanetscaleDb();
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

async function derivationDependents(uuid: string): Promise<Dependent[]> {
  const db = requirePlanetscaleDb();
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
): Promise<Dependent[]> {
  switch (subject) {
    case "area":
      return areaDependents(uuid);
    case "dashboard":
      return dashboardDependents(uuid);
    case "derivation":
      return derivationDependents(uuid);
    case "automation":
      // Nothing references an automation today. Wired anyway, so that the NEXT thing to reference
      // one has an obviously wrong-looking empty case to fill in rather than a missing file.
      return [];
  }
}

/**
 * `findDependents`, then throw. The writer-side half.
 *
 * @knipignore No caller. Every route goes through refuseIfReliedUpon (integrity/http.ts) instead, yet eight comments and docs/cli.md name THIS as the interlock — resolve which one is the protection before deleting either.
 */
export async function assertNotReliedUpon(
  subject: Subject,
  uuid: string,
): Promise<void> {
  const dependents = await findDependents(subject, uuid);
  if (dependents.length === 0) return;
  throw new ReliedUponError(
    `${dependents.length} thing(s) still rely on this ${subject}`,
    dependents,
  );
}
