/**
 * Composition-first dashboard CRUD (Phase 2b-2) — first-class, owner-scoped, id/alias-addressed.
 *
 * Distinct from the legacy per-(user,device) `store.ts` (retired with the old path). A row here has
 * `display_name`, an optional owner-unique `alias`, and a v4 `doc` (the node-tree document, every
 * scope ref on the envelope); `system_id`/`area_id` are left null. Addressed by `id` or `(owner, alias)`.
 *
 * config-v4 Phase 14 stage 15: `dashboards.descriptor` (the retired v3 shape) is no longer READ
 * anywhere and is WRITTEN exactly once — the literal `'{}'::jsonb` in `createDashboard`, which exists
 * only to satisfy the column's NOT NULL until stage 16 drops it. See that insert for why it is raw SQL.
 *
 * config-v4 id boundary: the `dashboards` PK is a uuid, but this module's PUBLIC surface speaks the
 * opaque `db_…` TypeID (the `id` field of every returned object; every id PARAM). The raw uuid is decoded
 * on the way into SQL and encoded on the way out, and NEVER escapes this module — so routes/pages/clients
 * treat the id as an opaque handle and never touch `lib/ids`. A malformed/foreign id decodes to null and
 * reads as "not found".
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { isUniqueViolationOn } from "@/lib/db/pg-error";
import { dashboards } from "@/lib/db/planetscale/schema";
import { Dashboard } from "@/lib/ids";
import {
  countCardNodes,
  emptyDashboardV4,
  isDashboardV4,
  type DashboardV4,
} from "./v4";
import { listGrantsForUser } from "./grants";

export interface CompositionDashboard {
  id: string;
  ownerClerkUserId: string;
  displayName: string | null;
  alias: string | null;
  /** The v4 node-tree document — the ONLY shape a dashboard has (config-v4 Phase 14 stage 15).
   *  `dashboards.doc` is NOT NULL, so this is null only for a jsonb that fails the shape guard. */
  doc: DashboardV4 | null;
  /** Whole-doc revision counter (default 1); the optimistic-concurrency token for the v4 doc PUT. */
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

/** The `uniqueIndex(...)` over `(owner_user_id, slug)` — see `dashboards` in schema.ts. */
const ALIAS_UNIQUE = "dashboards_owner_alias_unique";

/**
 * Is this the SLUG collision, as opposed to any other unique violation on `dashboards`?
 *
 * Two corrections, in order:
 *
 *  - config-v4 Phase 14 STEP 0: this used to read `(err as {code?: string})?.code`, which drizzle ≥0.44
 *    never populates — the SQLSTATE lives on the wrapping `DrizzleQueryError`'s `cause`. The alias 409 on
 *    BOTH write paths below was therefore an unhandled 500 with an empty body (measured on the previously
 *    dark `/api/v4/dashboards` POST + PATCH).
 *  - config-v4 Phase 14 stage 11: STEP 0's replacement was `isPgUniqueViolation`, i.e. "ANY 23505 on this
 *    statement is an alias collision". `dashboards` carries a SECOND unique — `dashboards_legacy_id_unique`
 *    over the frozen pre-cutover int — so a clash there would have been reported to the user as
 *    "That shortname is already in use", with a 409 and a plausible message hiding a real defect. Now the
 *    name is matched, and `lib/db/pg-error.ts` is deliberately strict: a 23505 whose name cannot be
 *    determined does NOT match, and the error propagates as a 500 rather than being mislabelled.
 *
 * On this database the name arrives only in the pg `message` (PlanetScale's proxy strips `constraint`);
 * `violatedUniqueName` handles that. Read `lib/db/pg-error.ts` before touching this.
 */
function isAliasCollision(err: unknown): boolean {
  return isUniqueViolationOn(err, ALIAS_UNIQUE);
}

/**
 * Create a new composition dashboard for `ownerClerkUserId`. Returns its id.
 *
 * The row is created EMPTY — an `emptyDashboardV4()` doc. Content arrives immediately afterwards via
 * `updateDashboardDoc` (`POST /api/v4/dashboards` seeds, then PUTs), which is the document's only author.
 *
 * 🛑 **Why this is raw SQL and not `db.insert(dashboards)` — config-v4 Phase 14 stage 15.**
 * `dashboards.descriptor` is retired but still `NOT NULL` **with no DB default** until stage 16 drops
 * it, so *something* must put a value in it. The column is deliberately NOT declared in `schema.ts`
 * (a projection-less `.select()` must never name a column that is about to disappear — that is what
 * breaks the instant the DROP lands), which also means drizzle cannot write it. Hence one hand-written
 * INSERT supplying the constant `'{}'::jsonb`.
 *
 * The alternative — a DB-level `DEFAULT '{}'::jsonb` — was rejected: it needs its own migration applied
 * to prod AND dev *before* this code deploys, i.e. an extra ordered DDL step, to buy nothing that
 * survives stage 16. This way stage 16 is exactly: `ALTER TABLE dashboards DROP COLUMN descriptor`,
 * plus restoring the drizzle insert below. Values are parameterized (`sql` interpolation binds them),
 * so this is not a string-concatenation hazard.
 *
 * 🧹 STAGE 16: delete the `descriptor` column + value from the statement and put back:
 *
 *     const [row] = await requirePlanetscaleDb()
 *       .insert(dashboards)
 *       .values({
 *         ownerUserId: args.ownerClerkUserId,
 *         name: args.displayName,
 *         slug: args.alias ?? null,
 *         doc: emptyDashboardV4(),
 *       })
 *       .returning({ id: dashboards.id });
 *
 * (No `id` is supplied — the uuid PK carries DEFAULT gen_random_uuid(); defect D-a was it inheriting
 * no default and 23502-ing on the first POST.)
 */
export async function createDashboard(args: {
  ownerClerkUserId: string;
  displayName: string;
  alias?: string | null;
}): Promise<string> {
  try {
    const doc = emptyDashboardV4();
    const res = await requirePlanetscaleDb().execute<{ id: string }>(sql`
      INSERT INTO dashboards (owner_user_id, name, slug, doc, descriptor)
      VALUES (
        ${args.ownerClerkUserId},
        ${args.displayName},
        ${args.alias ?? null},
        ${JSON.stringify(doc)}::jsonb,
        '{}'::jsonb
      )
      RETURNING id
    `);
    const id = res.rows[0]?.id;
    if (!id) throw new Error("createDashboard: INSERT returned no id");
    return Dashboard.encode(id);
  } catch (err) {
    if (isAliasCollision(err)) throw new DashboardAliasTakenError();
    throw err;
  }
}

function rowToDashboard(r: {
  id: string;
  clerkUserId: string;
  displayName: string | null;
  alias: string | null;
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
    doc: unknown;
    updatedAt: Date;
  },
  access: "owner" | "shared",
): DashboardSummary {
  return {
    id: Dashboard.encode(r.id),
    displayName: r.displayName,
    alias: r.alias,
    // config-v4 Phase 14 stage 15: counted off the v4 `doc`, which is where a dashboard's content
    // actually lives. This used to count v3 `descriptor` cards, and stage 13 measured the resulting
    // regression: a dashboard created through the UI reported `cardCount: 0`, because the seed was
    // written to `doc` while `descriptor` stayed empty.
    cardCount: isDashboardV4(r.doc) ? countCardNodes(r.doc) : 0,
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

/**
 * Rename / re-slug a dashboard. **Metadata only** — there is no structural patch here.
 *
 * config-v4 Phase 14 stage 15 deleted this function's `descriptor` branch, and with it the last
 * clobber hazard in the dashboard write path. That branch regenerated `doc` from `descriptor` on
 * every PATCH, which was safe only while `doc` had no independent author; `PUT /api/v4/dashboards/{id}`
 * is that author (and since stage 14 `AddAreaDialog` calls it), so a descriptor PATCH would have
 * silently overwritten v4-authored structure with a rewrite of a shape nothing maintains any more.
 * Stage 13 deleted the last route that could reach it and stage 14 the last client; this deletes the
 * capability. Structure is changed ONLY through `updateDashboardDoc`, under an `If-Match` revision.
 */
export async function updateDashboard(
  id: string,
  patch: {
    displayName?: string;
    alias?: string | null;
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
  const uuid = Dashboard.toUuidOrNull(id);
  if (!uuid) return;
  try {
    await requirePlanetscaleDb()
      .update(dashboards)
      .set(set)
      .where(eq(dashboards.id, uuid));
  } catch (err) {
    if (isAliasCollision(err)) throw new DashboardAliasTakenError();
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
