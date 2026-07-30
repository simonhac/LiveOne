import { NextRequest } from "next/server";
import { recomputeAreaProvenance } from "@/lib/areas/recompute-provenance";

// A batch of up to MAX_LIMIT days runs comfortably inside this; the caller loops for longer ranges.
// Must be declared HERE: Next reads `maxDuration` off the route module itself, so re-exporting it from
// the shared implementation would silently give this address the 60s default and time out the
// full-history activation path.
export const maxDuration = 300;

/**
 * POST /api/v4/areas/{id}/recompute-provenance — the config-v4 twin of
 * `POST /api/areas/{areaId}/recompute-provenance`. Ops-only: it materialises one Area's
 * `point_readings_flow_attr_1d` rollup (energy + grid/solar attribution, plus the battery blend when a
 * battery is bound) in bounded batches. Same implementation, same body, same response — see
 * `lib/areas/recompute-provenance.ts`.
 *
 * 🛑 **This route needs its own `lib/route-matchers.ts` `publicRoutes` entry, and it is invisible to a
 * logged-in tester that it does not have one.** It authenticates in-handler (area owner / admin / a
 * `CRON_SECRET` bearer), so Clerk's `auth.protect()` must be bypassed at the edge — but the middleware
 * runs BEFORE `next.config`'s rewrites and matches the ORIGINAL path, so `/api/v4/...` inherits nothing
 * from the legacy entry. Without the entry, a headless `CRON_SECRET` call is rewritten to a **404 at
 * the edge** while a browser session with a Clerk cookie sails through and looks fine. The entry added
 * for it is `"/api/v4/areas/(.*)/recompute-provenance"`, and it is deliberately as narrow as its legacy
 * sibling — the other v4 area routes stay Clerk-gated.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return recomputeAreaProvenance(request, id);
}
