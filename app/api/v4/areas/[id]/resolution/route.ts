import { NextRequest, NextResponse } from "next/server";
import { loadReadableArea } from "@/lib/areas/http";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { RegistryCache, UnknownIdError } from "@/lib/registry/registry-cache";
import { Area } from "@/lib/ids";

/**
 * config-v4 area resolution (§9.2), DARK, TypeID-native — the per-role point resolution ("which point,
 * with which energy-flow stem, serves this area" after the binding fold). Points are `pt_` TypeIDs (they
 * carry `point_uid`, resolved through the Phase-3 registry). Readable (owner ∪ viewer).
 *   GET → { areaId: ar_…, isComplete, timezoneOffsetMin,
 *           points:[{ id: pt_…, stem, metricType, metricUnit, transform, displayName }] }
 *
 * `isComplete:false` (an incomplete role set, e.g. a pricing-only area) is a valid 200 with `points`; a
 * 404 means the handle has no resolvable logical system at all (no viewable system / no area).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadReadableArea(request, id);
  if ("error" in r) return r.error;

  const ls = await resolveLogicalSystem(r.area.legacySystemId);
  if (!ls) {
    return NextResponse.json(
      { error: "Area has no resolvable logical system" },
      { status: 404 },
    );
  }

  const points: {
    id: string;
    stem: string;
    metricType: string;
    metricUnit: string | null;
    transform: string | null;
    displayName: string;
  }[] = [];
  for (const p of ls.points) {
    let id;
    try {
      id = await RegistryCache.pointForAddr(p.ref.systemId, p.ref.pointId);
    } catch (e) {
      // A point without a registry row (unbackfilled / just-deleted) is skipped, not fatal.
      if (e instanceof UnknownIdError) continue;
      throw e;
    }
    points.push({
      id,
      stem: p.stem,
      metricType: p.metricType,
      metricUnit: p.metricUnit,
      transform: p.transform,
      displayName: p.displayName,
    });
  }

  return NextResponse.json({
    areaId: Area.encode(r.area.id),
    isComplete: ls.isComplete,
    timezoneOffsetMin: ls.timezoneOffsetMin,
    points,
  });
}
