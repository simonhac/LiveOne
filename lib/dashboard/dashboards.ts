/**
 * Composition-first dashboard CRUD (Phase 2b-2) — first-class, owner-scoped, id/alias-addressed.
 *
 * Distinct from the legacy per-(user,system) `store.ts` (retired with the old path). A row here has
 * `display_name`, an optional owner-unique `alias`, and a composition `descriptor` (every card
 * area-bound); `system_id`/`area_id` are left null. Addressed by `id` or `(owner, alias)`.
 *
 * config-v4 id boundary: the `dashboards` PK is a uuid, but this module's PUBLIC surface speaks the
 * opaque `db_…` TypeID (the `id` field of every returned object; every id PARAM). The raw uuid is decoded
 * on the way into SQL and encoded on the way out, and NEVER escapes this module — so routes/pages/clients
 * treat the id as an opaque handle and never touch `lib/ids`. A malformed/foreign id decodes to null and
 * reads as "not found".
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboards } from "@/lib/db/planetscale/schema";
import { Dashboard } from "@/lib/ids";
import {
  allCardsV3,
  normalizeDescriptor,
  isDashboardV3,
  type DashboardV3,
} from "./v3";
import type { DashboardV4 } from "./v4";
import { listGrantsForUser } from "./grants";

export interface CompositionDashboard {
  id: string;
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
  id: string;
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
}): Promise<string> {
  try {
    const [row] = await requirePlanetscaleDb()
      .insert(dashboards)
      .values({
        // config-v4: KEYS are the renamed columns; the ARGS shape is unchanged (elective → Phase 9).
        // No `id` is supplied — 5d sets DEFAULT gen_random_uuid() precisely so this insert keeps
        // working (defect D-a: the promoted uuid PK inherited no default, 23502 on the first POST).
        ownerUserId: args.ownerClerkUserId,
        name: args.displayName,
        slug: args.alias ?? null,
        descriptor: normalizeDescriptor(args.descriptor),
      })
      .returning({ id: dashboards.id });
    return Dashboard.encode(row.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DashboardAliasTakenError();
    throw err;
  }
}

function rowToDashboard(r: {
  id: string;
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
    id: Dashboard.encode(r.id),
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
  clerkUserId: dashboards.ownerUserId,
  displayName: dashboards.name,
  alias: dashboards.slug,
  descriptor: dashboards.descriptor,
  doc: dashboards.doc,
  revision: dashboards.revision,
  createdAt: dashboards.createdAt,
  updatedAt: dashboards.updatedAt,
} as const;

export async function getDashboard(
  id: string,
): Promise<CompositionDashboard | null> {
  const uuid = Dashboard.toUuidOrNull(id);
  if (!uuid) return null;
  const [row] = await requirePlanetscaleDb()
    .select(DASHBOARD_COLUMNS)
    .from(dashboards)
    .where(eq(dashboards.id, uuid))
    .limit(1);
  return row ? rowToDashboard(row) : null;
}

/**
 * config-v4: the opaque `db_…` id of the dashboard carrying this frozen pre-cutover int (`legacy_id`),
 * or null. Backs the permanent `/dashboard/id/{n}` (int) → `/dashboard/id/{db_…}` redirect.
 */
export async function getDashboardIdByLegacyId(
  legacyId: number,
): Promise<string | null> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(eq(dashboards.legacyId, legacyId))
    .limit(1);
  return row ? Dashboard.encode(row.id) : null;
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
  id: string,
  doc: DashboardV4,
  expectedRevision?: number,
): Promise<DocUpdateResult> {
  const uuid = Dashboard.toUuidOrNull(id);
  if (!uuid) throw new Error(`dashboard ${id} not found`);
  return requirePlanetscaleDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ revision: dashboards.revision })
      .from(dashboards)
      .where(eq(dashboards.id, uuid))
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
      .where(eq(dashboards.id, uuid));
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
        eq(dashboards.ownerUserId, ownerClerkUserId),
        eq(dashboards.slug, alias),
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
        eq(dashboards.ownerUserId, ownerClerkUserId),
        isNotNull(dashboards.name),
      ),
    )
    .orderBy(desc(dashboards.updatedAt));
  return rows.map((r) => rowToSummary(r, "owner"));
}

/** Shape a dashboard row into a DashboardSummary, tagged with how the caller reaches it. */
function rowToSummary(
  r: {
    id: string;
    displayName: string | null;
    alias: string | null;
    descriptor: unknown;
    updatedAt: Date;
  },
  access: "owner" | "shared",
): DashboardSummary {
  return {
    id: Dashboard.encode(r.id),
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
        // grantedIds are opaque `db_…` ids → decode to uuids for the PK IN-list.
        inArray(
          dashboards.id,
          grantedIds
            .map((id) => Dashboard.toUuidOrNull(id))
            .filter((u): u is string => u != null),
        ),
        isNotNull(dashboards.name),
      ),
    );
  const shared = sharedRows.map((r) => rowToSummary(r, "shared"));
  return [...owned, ...shared];
}

export async function updateDashboard(
  id: string,
  patch: {
    displayName?: string;
    alias?: string | null;
    descriptor?: DashboardV3;
  },
): Promise<void> {
  // Typed against the table ON PURPOSE — do not "simplify" this back to Record<string, unknown>.
  // drizzle's `buildUpdateSet` keeps only payload keys that match a declared column and SILENTLY DISCARDS
  // the rest, and an index-signature payload satisfies `PgUpdateSetSource` without ever consulting the
  // table type. So with an untyped record, the config-v4 rename (dashboards display_name→name,
  // alias→slug) would compile clean and then emit `update "dashboards" set "updated_at" = $1 …` — the
  // PATCH returns 200 while the rename is not persisted. Parity's W-series cannot catch it either: it
  // models INSERT-ability (NOT-NULL-without-default columns), never an UPDATE's SET clause.
  // Same defect class as `updateAreaMeta` (lib/areas/create.ts). Typing it here means the schema flip
  // becomes a compile error at these lines rather than a silent no-op in production.
  const set: Partial<typeof dashboards.$inferInsert> = {
    updatedAt: new Date(),
  };
  // config-v4: the columns are renamed (display_name→name, alias→slug); the PATCH arg shape is
  // unchanged (elective → Phase 9), so map the legacy arg keys onto the renamed columns here.
  if (patch.displayName !== undefined) set.name = patch.displayName;
  if (patch.alias !== undefined) set.slug = patch.alias;
  if (patch.descriptor !== undefined)
    set.descriptor = normalizeDescriptor(patch.descriptor);
  const uuid = Dashboard.toUuidOrNull(id);
  if (!uuid) return;
  try {
    await requirePlanetscaleDb()
      .update(dashboards)
      .set(set)
      .where(eq(dashboards.id, uuid));
  } catch (err) {
    if (isUniqueViolation(err)) throw new DashboardAliasTakenError();
    throw err;
  }
}

export async function deleteDashboard(id: string): Promise<void> {
  const uuid = Dashboard.toUuidOrNull(id);
  if (!uuid) return;
  await requirePlanetscaleDb()
    .delete(dashboards)
    .where(eq(dashboards.id, uuid));
}
