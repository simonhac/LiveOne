import { NextRequest } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { handleRecompute } from "@/lib/derivations/v4-routes";

// Declared here as well as on the new address: Next reads `maxDuration` off the route module
// itself, so a shim that forgot it would silently run on the 60 s default.
export const maxDuration = 300;

/** SHIM onto `POST /api/v4/derivations/{dx_}/recompute` — see the collection route's note. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handleRecompute(request, dxid);
}
