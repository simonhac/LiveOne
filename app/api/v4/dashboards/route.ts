import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import {
  createDashboard,
  updateDashboardDoc,
  listAccessibleDashboards,
  DashboardAliasTakenError,
} from "@/lib/dashboard/dashboards";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { checkDocRefsReadable } from "@/lib/dashboard/v4-routes";
import {
  buildPersistableSeedDoc,
  MissingDeviceMappingError,
} from "@/lib/dashboard/v4-seed";
import { findReadableArea } from "@/lib/areas/http";

/**
 * config-v4 dashboards collection (§9.2). Owner-scoped.
 *   GET  → { dashboards: [{ id, name, slug, cardCount, revision, updatedAt, access }] }
 *        · v4 wire vocabulary (`name`/`slug`), not the DAO's legacy `displayName`/`alias` — the same
 *          keys `GET/PATCH /dashboards/{id}` speak, so a list entry is directly patchable.
 *   POST { name?, slug?, doc? | seedArea? } → 201 { id, revision }
 *        · `seedArea` (an `ar_` id) seeds the doc from that area's capability strategy using stable
 *          pre-minted device refs; mutually exclusive with `doc`. `name` defaults to the area name.
 *        · 400 (no name and no seedArea / both seedArea and doc / malformed seedArea)
 *        · 422 (doc invalid) · 403 (doc/seedArea refs an unreadable area) · 409 (slug taken)
 * An explicit/seeded `doc` is validated + written through the same DAO the PUT uses; omit both for an
 * empty dashboard the owner fills later.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const dashboards = await listAccessibleDashboards(auth.userId);
  return NextResponse.json({
    dashboards: dashboards.map((d) => ({
      id: d.id,
      name: d.displayName,
      slug: d.alias,
      cardCount: d.cardCount,
      revision: d.revision,
      updatedAt: d.updatedAt,
      access: d.access,
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const seedArea =
    typeof body?.seedArea === "string" && body.seedArea.trim()
      ? body.seedArea.trim()
      : null;
  const hasDoc = body?.doc !== undefined;
  if (seedArea && hasDoc) {
    return NextResponse.json(
      { error: "seedArea and doc are mutually exclusive" },
      { status: 400 },
    );
  }

  // Resolve the doc to persist (from a seed area, or an explicit body doc) before touching the DB.
  let normalized: DashboardV4 | null = null;
  let seededName: string | null = null;
  if (seedArea) {
    const found = await findReadableArea(auth.userId, seedArea);
    if (!found.ok) {
      return NextResponse.json(
        { error: found.message },
        { status: found.status },
      );
    }
    let doc: DashboardV4;
    try {
      doc = await buildPersistableSeedDoc(
        found.area.id,
        found.area.legacySystemId,
      );
    } catch (error) {
      if (error instanceof MissingDeviceMappingError) {
        return NextResponse.json(
          { error: "device-mapping-incomplete" },
          { status: 503 },
        );
      }
      throw error;
    }
    // The seed is machine-built from authoritative mappings, so validation should always pass.
    const result = validateDocV4(doc);
    if (!result.valid || !result.normalized) {
      return NextResponse.json(
        { errors: result.errors, warnings: result.warnings },
        { status: 422 },
      );
    }
    const refErr = await checkDocRefsReadable(result.normalized, auth.userId);
    if (refErr) return refErr;
    normalized = result.normalized;
    seededName = found.area.displayName;
  } else if (hasDoc) {
    const result = validateDocV4(body.doc);
    if (!result.valid || !result.normalized) {
      return NextResponse.json(
        { errors: result.errors, warnings: result.warnings },
        { status: 422 },
      );
    }
    const refErr = await checkDocRefsReadable(result.normalized, auth.userId);
    if (refErr) return refErr;
    normalized = result.normalized;
  }

  const name =
    typeof body?.name === "string" && body.name.trim()
      ? body.name.trim()
      : (seededName ?? "");
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const slug =
    typeof body?.slug === "string" && body.slug.trim()
      ? body.slug.trim()
      : null;

  let id: string; // opaque `db_…` dashboard id
  try {
    id = await createDashboard({
      ownerClerkUserId: auth.userId,
      displayName: name,
      alias: slug,
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
    const upd = await updateDashboardDoc(id, normalized, auth.userId);
    if (upd.ok) revision = upd.revision;
  }
  // `id` is already the opaque `db_…` id (the DAO owns the uuid↔TypeID translation).
  return NextResponse.json({ id, revision }, { status: 201 });
}
