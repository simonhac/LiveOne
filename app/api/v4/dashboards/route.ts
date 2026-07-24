import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  createDashboard,
  updateDashboardDoc,
  listAccessibleDashboards,
  DashboardAliasTakenError,
} from "@/lib/dashboard/dashboards";
import { emptyDashboardV3 } from "@/lib/dashboard/v3";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { checkDocAreasReadable } from "@/lib/dashboard/v4-routes";

/**
 * config-v4 dashboards collection (§9.2), DARK. Owner-scoped.
 *   GET  → { dashboards: [...] }
 *   POST { name, slug?, doc? } → 201 { id, revision }
 *        · 422 (doc invalid) · 403 (doc refs an unreadable area) · 409 (slug taken)
 * An optional `doc` is validated + written through the same DAO the PUT uses; omit for an empty
 * (v3-shaped) dashboard the owner fills later.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const dashboards = await listAccessibleDashboards(auth.userId);
  return NextResponse.json({ dashboards });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const slug =
    typeof body?.slug === "string" && body.slug.trim()
      ? body.slug.trim()
      : null;

  let normalized = null;
  if (body?.doc !== undefined) {
    const result = validateDocV4(body.doc);
    if (!result.valid || !result.normalized) {
      return NextResponse.json(
        { errors: result.errors, warnings: result.warnings },
        { status: 422 },
      );
    }
    const refErr = await checkDocAreasReadable(result.normalized, auth.userId);
    if (refErr) return refErr;
    normalized = result.normalized;
  }

  let id: number;
  try {
    id = await createDashboard({
      ownerClerkUserId: auth.userId,
      displayName: name,
      alias: slug,
      descriptor: emptyDashboardV3(),
    });
  } catch (err) {
    if (err instanceof DashboardAliasTakenError) {
      return NextResponse.json(
        { error: "That shortname is already in use" },
        { status: 409 },
      );
    }
    throw err;
  }

  let revision = 1;
  if (normalized) {
    const upd = await updateDashboardDoc(id, normalized);
    if (upd.ok) revision = upd.revision;
  }
  return NextResponse.json({ id, revision }, { status: 201 });
}
