import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { findReadableArea, loadAreaForAuth } from "@/lib/areas/http";
import { loadGeneratorHealth } from "@/lib/control/generator-health-server";

/**
 * What is wrong with this area's generator — the list behind the generator tile's issues chip.
 *
 *   GET → { hasGenerator: boolean, issues: GeneratorIssue[] }   (worst first)
 *
 * Readable (owner ∪ viewer). A viewer gets the issues derived from the device's own readings
 * (controller offline, battery); the exercise rules and the command log are owner-only, the same
 * line `GET /api/v4/automations` and `GET /api/v4/points/{id}/commands` already draw, so a viewer's
 * list is a subset rather than a different answer.
 *
 * The decision itself is `assessGeneratorHealth` (lib/control/generator-health.ts), which the
 * monitor-observations cron also runs — the tile and Slack cannot disagree about what is broken.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const readable = await findReadableArea(auth.userId, id, {
    isAdmin: auth.actingAsAdmin,
  });
  if (!readable.ok)
    return NextResponse.json(
      { error: readable.message },
      { status: readable.status },
    );

  const row = await loadAreaForAuth(readable.area.id);
  if (!row)
    return NextResponse.json({ error: "Area not found" }, { status: 404 });

  try {
    const health = await loadGeneratorHealth({
      areaUuid: row.id,
      handle: readable.area.legacySystemId,
      timezone: row.displayTimezone,
      includeOwnerData: auth.isAdmin || row.ownerClerkUserId === auth.userId,
    });
    return NextResponse.json(health, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(`[generator-health] ${id} failed:`, err);
    return NextResponse.json(
      { error: "Could not assess the generator" },
      { status: 500 },
    );
  }
}
