import { NextRequest } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { handleIntervals } from "@/lib/derivations/v4-routes";

/** SHIM onto `GET /api/v4/derivations/{dx_}/intervals` — see the collection route's note. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handleIntervals(request, dxid);
}
