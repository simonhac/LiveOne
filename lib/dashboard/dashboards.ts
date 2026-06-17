/**
 * Composition-first dashboard CRUD (Phase 2b-2) — first-class, owner-scoped, id/alias-addressed.
 *
 * Distinct from the legacy per-(user,system) `store.ts` (retired with the old path). A row here has
 * `display_name`, an optional owner-unique `alias`, and a composition `descriptor` (every card
 * area-bound); `system_id`/`area_id` are left null. Addressed by `id` or `(owner, alias)`.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import { allCardsV3, isDashboardV3, type DashboardV3 } from "./v3";

export interface CompositionDashboard {
  id: number;
  ownerClerkUserId: string;
  displayName: string | null;
  alias: string | null;
  descriptor: DashboardV3;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardSummary {
  id: number;
  displayName: string | null;
  alias: string | null;
  cardCount: number;
  updatedAt: Date;
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
        descriptor: args.descriptor,
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
  createdAt: Date;
  updatedAt: Date;
}): CompositionDashboard {
  return {
    id: r.id,
    ownerClerkUserId: r.clerkUserId,
    displayName: r.displayName,
    alias: r.alias,
    descriptor: r.descriptor as DashboardV3,
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
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    alias: r.alias,
    cardCount: isDashboardV3(r.descriptor)
      ? allCardsV3(r.descriptor).length
      : Array.isArray((r.descriptor as { cards?: unknown[] })?.cards)
        ? (r.descriptor as { cards: unknown[] }).cards.length
        : 0,
    updatedAt: r.updatedAt,
  }));
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
  if (patch.descriptor !== undefined) set.descriptor = patch.descriptor;
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
