import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { inspectFlows, purgeFlows } from "@/lib/areas/purge-provenance";
import { Area } from "@/lib/ids";

export const maxDuration = 60;

/**
 * `GET|DELETE /api/v4/areas/{ar_…}/flows` — inspect and RETIRE an Area's flow matrix
 * (`point_readings_flow_attr_1d`), for `liveone area purge flows`.
 *
 * 🛑 **This is the Sankey, not merely "provenance".** `point_readings_flow_1d` was retired into this
 * table, so it carries the energy history for every complete area — battery or not — with the
 * attributed emissions/renewable/cost/revenue legs laid over it. A deleted row takes both.
 *
 * 🛑 **And it does not heal.** The nightly reheal reaches only `REHEAL_TRAILING_MS` (96 h) back, and
 * `rehealStaleAttrDays` finds work by SELECTING FROM THIS TABLE — a deleted day is not a stale day
 * it will re-derive, it is a day that no longer exists to be found. Only an explicit
 * `POST …/recompute-provenance` over the same range restores it, and the response says so.
 *
 * 🛑 **`start` and `end` are REQUIRED on DELETE.** There is no "absent means everything": the verb
 * whose dangerous case is the one you get by typing less will eventually be typed less, and the
 * restore is per-day and batched. The fleet-wide twin's trap is exactly this
 * (`/api/cron/daily` reads a missing date as ALL HISTORY).
 *
 * Authorized through `loadAreaForOwner` — owner or admin, `requireAuth` underneath, which is what
 * makes this address admissible to `cliTokenRoutes`. Deliberately NOT in `publicRoutes`: the
 * recompute sibling is, for headless `CRON_SECRET` ops, and a destructive verb does not need that
 * door open.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const window = readWindow(request);
  if ("error" in window) return window.error;

  const report = await inspectFlows(authed.area.id, window.value);
  return NextResponse.json({
    ok: true,
    areaId: Area.encode(authed.area.id),
    range: window.value,
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

  const window = readWindow(request);
  if ("error" in window) return window.error;

  const deleted = await purgeFlows(authed.area.id, window.value);
  return NextResponse.json({
    ok: true,
    areaId: Area.encode(authed.area.id),
    range: window.value,
    deleted,
    // Named in the payload, not merely in the docs: whatever reads this response is the thing that
    // has to know the range will stay empty until someone runs this.
    restoreWith: `POST /api/v4/areas/${Area.encode(authed.area.id)}/recompute-provenance {"start":"${window.value.start}","end":"${window.value.end}"}`,
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function readWindow(
  request: NextRequest,
): { value: { start: string; end: string } } | { error: NextResponse } {
  const q = new URL(request.url).searchParams;
  const start = q.get("start");
  const end = q.get("end");
  if (!start || !end)
    return {
      error: NextResponse.json(
        {
          error:
            "start and end are required (YYYY-MM-DD) — this address has no unscoped form",
        },
        { status: 400 },
      ),
    };
  if (!DAY.test(start) || !DAY.test(end))
    return {
      error: NextResponse.json(
        { error: "start and end must be YYYY-MM-DD" },
        { status: 400 },
      ),
    };
  if (start > end)
    return {
      error: NextResponse.json(
        { error: "start must be on or before end" },
        { status: 400 },
      ),
    };
  return { value: { start, end } };
}
