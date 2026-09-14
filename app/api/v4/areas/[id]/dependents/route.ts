/**
 * `GET /api/v4/areas/{ar_…}/dependents` — what still references this area, named. Read-only.
 *
 * ## Why this endpoint exists
 *
 * So a DRY RUN can tell the truth. `liveone area archive` and `liveone area delete` are dry-run by
 * default, and without this they could only print "would archive" / "would DELETE" and then have
 * `--apply` come back 409 — a preview that promises something the real thing deterministically
 * refuses. That is worse than no preview: it trains an operator to skip the dry run.
 *
 * It is the same `findDependents` the writers use, so the two cannot drift into disagreeing about
 * what counts. The one thing it CANNOT promise is that the answer is still true a moment later —
 * `hardDeleteArea` re-scans under a `FOR UPDATE` lock precisely because this one cannot. A preview
 * is advisory by construction; the refusal is the guarantee.
 *
 * `?destructive=true` asks the DELETE question (adds the data legs: flow matrix, battery
 * provenance, calendar feeds, interval provenance, bindings, helper device, user defaults).
 * Without it, the ARCHIVE question — config references only, because archiving destroys nothing.
 *
 * 400 malformed id · 403 unknown-or-not-yours · 200 with a possibly-empty list.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import { findDependents } from "@/lib/integrity/relied-upon";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Owner-or-admin, like every other verb on this area: the list names other people's dashboards
  // and grants by label, so it is not a public read.
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  const { area } = authed;

  const destructive =
    request.nextUrl.searchParams.get("destructive") === "true";

  const dependents = await findDependents("area", area.id, { destructive });
  return NextResponse.json({
    areaId: id,
    status: area.status,
    destructive,
    dependents,
  });
}
