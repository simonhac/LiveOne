/**
 * Composition-first dashboard CRUD (Phase 2b-2) — first-class, owner-scoped, id/alias-addressed.
 *
 * Distinct from the legacy per-(user,system) `store.ts` (retired with the old path). A row here has
 * `display_name`, an optional owner-unique `alias`, and a composition `descriptor` (every card
 * area-bound); `system_id`/`area_id` are left null. Addressed by `id` or `(owner, alias)`.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import {
  allCardsV3,
  normalizeDescriptor,
  isDashboardV3,
  type DashboardV3,
} from "./v3";
import type { DashboardV4 } from "./v4";
import { listGrantsForUser } from "./grants";

export interface CompositionDashboard {
  id: number;
  ownerClerkUserId: string;
  displayName: string | null;
  alias: string | null;
  descriptor: DashboardV3;
  /** config-v4 dark column: the v4 node-tree document, or null for a v3 dashboard. Drives the
   *  dual-shape render window (see app/dashboard/[...slug]/page.tsx). */
  doc: DashboardV4 | null;
  /** config-v4 dark column: whole-doc revision counter (default 1). */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardSummary {
  id: number;
  displayName: string | null;
  alias: string | null;
  cardCount: number;
  updatedAt: Date;
  /** How the caller reaches this dashboard: "owner" = they own it, "shared" = granted via a membership. */
  access: "owner" | "shared";
}

/** Raised when an alias collides with another of the owner's dashboards (SQLSTATE 23505). */
export class DashboardAliasTakenError extends Error {
  constructor() {
    super("alias already in use");
    this.name = "DashboardAliasTakenError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

/** Create a new composition dashboard for `ownerClerkUserId`. Returns its id. */
export async function createDashboard(args: {
  ownerClerkUserId: string;
  displayName: string;
  alias?: string | null;
  descriptor: DashboardV3;
}): Promise<number> {
  try {
    const [row] = await requirePlanetscaleDb()
      .insert(dashboards)
      .values({
        clerkUserId: args.ownerClerkUserId,
        displayName: args.displayName,
        alias: args.alias ?? null,
        descriptor: normalizeDescriptor(args.descriptor),
      })
      .returning({ id: dashboards.id });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DashboardAliasTakenError();
    throw err;
  }
}

function rowToDashboard(r: {
  id: number;
  clerkUserId: string;
  displayName: string | null;
  alias: string | null;
  descriptor: unknown;
  doc: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): CompositionDashboard {
  return {
    id: r.id,
    ownerClerkUserId: r.clerkUserId,
    displayName: r.displayName,
    alias: r.alias,
    descriptor: r.descriptor as DashboardV3,
    doc: (r.doc as DashboardV4 | null) ?? null,
    revision: r.revision,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const DASHBOARD_COLUMNS = {
  id: dashboards.id,
  clerkUserId: dashboards.clerkUserId,
  displayName: dashboards.displayName,
  alias: dashboards.alias,
  descriptor: dashboards.descriptor,
  doc: dashboards.doc,
  revision: dashboards.revision,
  createdAt: dashboards.createdAt,
  updatedAt: dashboards.updatedAt,
} as const;

export async function getDashboard(
  id: number,
): Promise<CompositionDashboard | null> {
  const [row] = await requirePlanetscaleDb()
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .limit(1);
  return row ? rowToDashboard(row) : null;
}

export type DocUpdateResult =
  | { ok: true; revision: number; doc: DashboardV4 }
  | { ok: false; conflict: number };

/**
 * config-v4 whole-doc write (§9.1). One tx: `SELECT … FOR UPDATE`, optimistic-concurrency check
 * against `expectedRevision` (the `If-Match` value), then set `doc` + bump `revision`. Returns the new
 * revision + doc, or a conflict carrying the current revision. `doc` MUST already be validated +
 * normalized by the caller (`validateDocV4`). Revision-history (`dashboard_revisions`) is keyed by the
 * FUTURE uuid dashboard id (bare uuid column, FK deferred to cutover), so it is NOT written for a
 * serial-id dashboard pre-cutover — history starts at cutover.
 */
export async function updateDashboardDoc(
  id: number,
  doc: DashboardV4,
  expectedRevision?: number,
): Promise<DocUpdateResult> {
  return requirePlanetscaleDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ revision: dashboards.revision })
      .from(dashboards)
      .where(eq(dashboards.id, id))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`dashboard ${id} not found`);
    if (expectedRevision != null && row.revision !== expectedRevision) {
      return { ok: false, conflict: row.revision };
    }
    const revision = row.revision + 1;
    await tx
      .update(dashboards)
      .set({ doc, revision, updatedAt: new Date() })
      .where(eq(dashboards.id, id));
    return { ok: true, revision, doc };
  });
}

export async function getDashboardByOwnerAlias(
  ownerClerkUserId: string,
  alias: string,
): Promise<CompositionDashboard | null> {
  const [row] = await requirePlanetscaleDb()
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(
      and(
        eq(dashboards.clerkUserId, ownerClerkUserId),
        eq(dashboards.alias, alias),
      ),
    )
    .limit(1);
  return row ? rowToDashboard(row) : null;
}

/** A user's composition dashboards (those with a display_name), newest first. */
export async function listDashboardsForOwner(
  ownerClerkUserId: string,
): Promise<DashboardSummary[]> {
  const rows = await requirePlanetscaleDb()
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(
      and(
        eq(dashboards.clerkUserId, ownerClerkUserId),
        isNotNull(dashboards.displayName),
      ),
    )
    .orderBy(desc(dashboards.updatedAt));
  return rows.map((r) => rowToSummary(r, "owner"));
}

/** Shape a dashboard row into a DashboardSummary, tagged with how the caller reaches it. */
function rowToSummary(
  r: {
    id: number;
    displayName: string | null;
    alias: string | null;
    descriptor: unknown;
    updatedAt: Date;
  },
  access: "owner" | "shared",
): DashboardSummary {
  return {
    id: r.id,
    displayName: r.displayName,
    alias: r.alias,
    cardCount: isDashboardV3(r.descriptor)
      ? allCardsV3(r.descriptor).length
      : Array.isArray((r.descriptor as { cards?: unknown[] })?.cards)
        ? (r.descriptor as { cards: unknown[] }).cards.length
        : 0,
    updatedAt: r.updatedAt,
    access,
  };
}

/**
 * Every dashboard the user can reach: the ones they OWN ∪ the ones SHARED with them via a grant,
 * deduped by id (ownership wins). Powers the dashboard-first landing and the switcher.
 */
export async function listAccessibleDashboards(
  clerkUserId: string,
): Promise<DashboardSummary[]> {
  const owned = await listDashboardsForOwner(clerkUserId);
  const ownedIds = new Set(owned.map((d) => d.id));

  const grantedIds = (await listGrantsForUser(clerkUserId)).filter(
    (id) => !ownedIds.has(id),
  );
  if (grantedIds.length === 0) return owned;

  const sharedRows = await requirePlanetscaleDb()
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(
      and(
        inArray(dashboards.id, grantedIds),
        isNotNull(dashboards.displayName),
      ),
    );
  const shared = sharedRows.map((r) => rowToSummary(r, "shared"));
  return [...owned, ...shared];
}

export async function updateDashboard(
  id: number,
  patch: {
    displayName?: string;
    alias?: string | null;
    descriptor?: DashboardV3;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.alias !== undefined) set.alias = patch.alias;
  if (patch.descriptor !== undefined)
    set.descriptor = normalizeDescriptor(patch.descriptor);
  try {
    await requirePlanetscaleDb()
      .update(dashboards)
      .set(set)
      .where(eq(dashboards.id, id));
  } catch (err) {
    if (isUniqueViolation(err)) throw new DashboardAliasTakenError();
    throw err;
  }
}

export async function deleteDashboard(id: number): Promise<void> {
  await requirePlanetscaleDb().delete(dashboards).where(eq(dashboards.id, id));
}
