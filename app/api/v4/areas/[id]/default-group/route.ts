import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import {
  buildSeedGroupPreview,
  MissingDeviceMappingError,
} from "@/lib/dashboard/v4-seed";

/**
 * Area default-group (§9.2) — the capability-derived seed GROUP for an area. Preview and persisted
 * seeds use the same authoritative legacy-handle → `dv_` registry, so every device-pinned card is
 * safe to save.
 *   GET → { group: <area-bound GroupNode> }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;

  try {
    const group = await buildSeedGroupPreview(r.area.id, r.area.legacySystemId);
    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof MissingDeviceMappingError) {
      return NextResponse.json(
        { error: "device-mapping-incomplete" },
        { status: 503 },
      );
    }
    throw error;
  }
}
