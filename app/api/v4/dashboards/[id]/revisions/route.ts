/**
 * GET /api/v4/dashboards/{db_…}/revisions — the dashboard's edit history.
 *
 * Post-image rows: revision N's row IS version N of the doc, written in the same transaction as
 * the write that produced it (`updateDashboardDoc` / the CLI's `writeDoc` / `createDashboard`).
 *
 *   ?limit=N       newest-first list, WITHOUT docs: { revisions: [{revision, savedBy, savedAt}] }
 *   ?revision=N    one revision, WITH its doc:      { revision, savedBy, savedAt, doc } | 404
 *
 * `savedBy` is a provenance string, not always a Clerk id — routes record the caller's userId, the
 * CLI records "cli", scripts "script:<name>", the backfill "backfill".
 *
 * Auth: `loadOwnedDashboard` (owner or admin) — which also keeps the structural invariant in
 * lib/__tests__/cli-token-edge.test.ts satisfied, since this route is under `isCliTokenRoute` and
 * therefore reachable with a CLI token past the edge.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { dashboardRevisions } from "@/lib/db/planetscale/schema";
import { Dashboard } from "@/lib/ids";
import { loadOwnedDashboard } from "@/lib/dashboard/v4-routes";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;
  // The DAO speaks opaque db_… ids; this route needs the raw uuid for the child-table query.
  const uuid = Dashboard.toUuidOrNull(r.dashboard.id);
  if (!uuid) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(request.url);
  const revParam = url.searchParams.get("revision");

  if (revParam !== null) {
    const revision = Number(revParam);
    if (!/^\d+$/.test(revParam) || revision < 1)
      return NextResponse.json(
        { error: "revision must be a positive integer" },
        { status: 400 },
      );
    const [row] = await requirePlanetscaleDb()
      .select({
        revision: dashboardRevisions.revision,
        savedBy: dashboardRevisions.savedBy,
        savedAt: dashboardRevisions.savedAt,
        doc: dashboardRevisions.doc,
      })
      .from(dashboardRevisions)
      .where(
        and(
          eq(dashboardRevisions.dashboardId, uuid),
          eq(dashboardRevisions.revision, revision),
        ),
      )
      .limit(1);
    if (!row)
      return NextResponse.json(
        { error: `no revision ${revision} recorded for this dashboard` },
        { status: 404 },
      );
    return NextResponse.json(row);
  }

  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit !== null && /^\d+$/.test(rawLimit)
      ? Math.min(Number(rawLimit), 500)
      : 50;
  const rows = await requirePlanetscaleDb()
    .select({
      revision: dashboardRevisions.revision,
      savedBy: dashboardRevisions.savedBy,
      savedAt: dashboardRevisions.savedAt,
    })
    .from(dashboardRevisions)
    .where(eq(dashboardRevisions.dashboardId, uuid))
    .orderBy(desc(dashboardRevisions.revision))
    .limit(limit);
  return NextResponse.json({ revisions: rows });
}
