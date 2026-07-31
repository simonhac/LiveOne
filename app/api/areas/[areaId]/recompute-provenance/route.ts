import { NextRequest } from "next/server";
import { recomputeAreaProvenance } from "@/lib/areas/recompute-provenance";

// A batch of up to MAX_LIMIT days runs comfortably inside this; the caller loops for longer ranges.
// 300 (not 60): the first batch's learn REDUCES full history from agg_5m on a rebuild (one bounded
// read, ~380k rows) — incremental runs are far faster, this is headroom for the activation path.
export const maxDuration = 300;

/**
 * POST /api/areas/[areaId]/recompute-provenance — the whole handler now lives in
 * `lib/areas/recompute-provenance.ts`, shared with the config-v4 twin at
 * `/api/v4/areas/{id}/recompute-provenance` (Phase 14 stage 10). Behaviour, auth (owner / admin /
 * `CRON_SECRET` bearer), body and response are byte-identical to what this file used to contain — the
 * only change is that there is now exactly one copy of it. Stage 13 deletes this address; the shared
 * implementation stays.
 *
 * 🛑 This route is in `publicRoutes` (lib/route-matchers.ts) because it authenticates IN-HANDLER; it is
 * not unauthenticated. Its v4 twin needed its own entry for the same reason.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ areaId: string }> },
) {
  const { areaId } = await params;
  return recomputeAreaProvenance(request, areaId);
}
