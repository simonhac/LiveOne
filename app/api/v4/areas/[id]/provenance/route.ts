import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  inspectProvenance,
  purgeProvenance,
} from "@/lib/areas/purge-provenance";
import { Area } from "@/lib/ids";

export const maxDuration = 120;

/**
 * `GET|DELETE /api/v4/areas/{ar_…}/provenance` — inspect and RETIRE an Area's battery provenance,
 * for `liveone area provenance` and `liveone area purge provenance`.
 *
 * Three things, deleted together because they are one fact split across three homes:
 *   1. the blend READINGS — the six `bidi.battery/*` series the fold writes onto the Area's helper
 *      device every 5 minutes (`point_readings_agg_5m`, and the `agg_1d` rollup they accrue)
 *   2. the blend BINDINGS — `role='battery'` at those six metrics, ordinal 100–105
 *   3. `battery_provenance_daily` — learn inputs, learned params, and the `fold_state` checkpoints
 *
 * Unlike the flow matrix next door, this IS self-healing: `learnAllForHandle` forces a full rebuild
 * from the fixed anchor whenever its table is empty, with fixed seeds, so deletion is a supported
 * operation rather than damage. Hence no required window — an unscoped form is safe here and is not
 * safe there.
 *
 * 🛑 The helper DEVICE and its POINTS survive. They go inert and are refilled, at the same `pt_` ids,
 * by the next recompute. Dropping them would change identities other rows address by id to save
 * nothing.
 *
 * Authorized through `loadAreaForOwner` (owner or admin), which is what makes this address
 * admissible to `cliTokenRoutes`; deliberately not in `publicRoutes`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const report = await inspectProvenance(authed.area.id);
  return NextResponse.json({
    ok: true,
    areaId: Area.encode(authed.area.id),
    ...report,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const deleted = await purgeProvenance(authed.area.id);
  return NextResponse.json({
    ok: true,
    areaId: Area.encode(authed.area.id),
    deleted,
    restoreWith: `POST /api/v4/areas/${Area.encode(authed.area.id)}/recompute-provenance`,
  });
}
