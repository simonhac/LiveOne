import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import { buildSeedGroupPreview } from "@/lib/dashboard/v4-seed";

/**
 * config-v4 area default-group (§9.2), DARK — the capability-derived v4 seed GROUP for an area, the v4
 * analogue of `GET /api/areas/{id}/default-section` (returns a v4 `group` node instead of a v3 section).
 * Read-only PREVIEW (never persisted), so it uses the lenient `deviceRef` in `buildSeedGroupPreview` and
 * therefore includes the device-pinned `oe-grid` card. Readable (owner ∪ viewer).
 *   GET → { group: <area-bound GroupNode> }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;

  const group = await buildSeedGroupPreview(r.area.id, r.area.legacySystemId);
  return NextResponse.json({ group });
}
