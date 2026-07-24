import { NextRequest, NextResponse } from "next/server";
import {
  updateDashboardDoc,
  updateDashboard,
  deleteDashboard,
  DashboardAliasTakenError,
} from "@/lib/dashboard/dashboards";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import {
  loadOwnedDashboard,
  checkDocAreasReadable,
  parseIfMatch,
} from "@/lib/dashboard/v4-routes";

/**
 * config-v4 dashboard doc surface (§9.1), DARK — no dashboard has a `doc` yet; writes go live at
 * cutover. Owner/admin only (Clerk-gated at the edge; ownership enforced here).
 *
 *   GET → 200 { id, name, alias, revision, doc } + ETag: "<revision>"
 *   PUT { doc } [If-Match: "<rev>"] → 200 { revision, doc, warnings } + ETag
 *        · 422 { errors, warnings }        (validation — nothing persisted)
 *        · 403 { error }                   (a ref points at an unreadable area — §8.4)
 *        · 412 { error:"revision-conflict", current }   (If-Match mismatch)
 *
 * Addressed by the current serial id; `db_…` TypeID addressing lands at cutover.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;
  const d = r.dashboard;
  return NextResponse.json(
    {
      id: d.id,
      name: d.displayName,
      alias: d.alias,
      revision: d.revision,
      doc: d.doc,
    },
    { headers: { ETag: `"${d.revision}"` } },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const result = validateDocV4(body?.doc);
  if (!result.valid || !result.normalized) {
    return NextResponse.json(
      { errors: result.errors, warnings: result.warnings },
      { status: 422 },
    );
  }
  const normalized = result.normalized;

  const refErr = await checkDocAreasReadable(
    normalized,
    r.dashboard.ownerClerkUserId,
  );
  if (refErr) return refErr;

  const upd = await updateDashboardDoc(
    r.dashboard.id,
    normalized,
    parseIfMatch(request.headers.get("if-match")),
  );
  if (!upd.ok) {
    return NextResponse.json(
      { error: "revision-conflict", current: upd.conflict },
      { status: 412 },
    );
  }
  return NextResponse.json(
    { revision: upd.revision, doc: upd.doc, warnings: result.warnings },
    { headers: { ETag: `"${upd.revision}"` } },
  );
}

/** PATCH — meta only (name / slug); the doc is written via PUT. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const patch: { displayName?: string; alias?: string | null } = {};
  if (typeof body?.name === "string") {
    const n = body.name.trim();
    if (!n) {
      return NextResponse.json(
        { error: "name cannot be empty" },
        { status: 400 },
      );
    }
    patch.displayName = n;
  }
  if (body?.slug !== undefined) {
    patch.alias =
      typeof body.slug === "string" && body.slug.trim()
        ? body.slug.trim()
        : null;
  }
  try {
    await updateDashboard(r.dashboard.id, patch);
  } catch (err) {
    if (err instanceof DashboardAliasTakenError) {
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    }
    throw err;
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;
  await deleteDashboard(r.dashboard.id);
  return NextResponse.json({ success: true });
}
