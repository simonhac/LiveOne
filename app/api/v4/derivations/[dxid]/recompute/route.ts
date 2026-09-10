import { NextRequest } from "next/server";
import { handleRecompute } from "@/lib/derivations/v4-routes";

// A multi-week backfill of ONE detector runs comfortably inside this; `recomputeRange` chunks at 14
// days internally, so the caller loops (`--last=30d` slices) for anything longer. Must be declared
// HERE: Next reads `maxDuration` off the route module itself, so re-exporting it from a shared
// implementation would silently leave this address on the 60 s default — the same trap
// `recompute-provenance/route.ts` documents.
export const maxDuration = 300;

/**
 * POST /api/v4/derivations/{dx_}/recompute — rebuild ONE derivation's intervals over a window.
 * The scope is the path; see `handleRecompute` for why that matters.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ dxid: string }> },
) {
  const { dxid } = await params;
  return handleRecompute(request, dxid);
}
