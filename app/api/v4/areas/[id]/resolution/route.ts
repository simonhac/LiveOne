import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import { resolveAreaSlots } from "@/lib/areas/resolution";

/** Read-only deterministic producer report for every known semantic information slot. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;
  return NextResponse.json(
    await resolveAreaSlots(r.area.id, r.area.legacySystemId),
  );
}
