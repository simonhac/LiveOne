import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { loadPointByUuid } from "@/lib/control/point-actions";
import { scheduleRepoll } from "@/lib/control/repoll";
import { Point } from "@/lib/ids";

/**
 * Ask for a fresh read of a point's device — the control dialog's "the data I'm looking at is
 * N minutes old" remedy.
 *
 *   POST /api/v4/points/{pt_…}/refresh  → 202 { scheduled: true }
 *
 * Same shape as its sibling action route: a point id names its device, so the resolver and the
 * owner-only gate are identical, and the refresh itself is the action route's confirmation
 * re-poll (`scheduleRepoll` → the real ingest path; the web tier never writes KV). 202 because
 * the poll runs after the response — the caller watches `measurementTime` advance on its normal
 * data query rather than awaiting a body.
 *
 * Owner-only on purpose: it spends a vendor read (~$0.002 on Fleet) and can wake hardware, so
 * it is gated exactly like commanding the device, and stays out of `publicRoutes` /
 * `shareableRoutes` the same way.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = Point.parse(id);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `Invalid point id: ${parsed.message}` },
        { status: 400 },
      );
    }

    const resolved = await loadPointByUuid(Point.toUuid(parsed.id));
    if (!resolved) {
      return NextResponse.json({ error: "Point not found" }, { status: 404 });
    }

    const auth = await requireDeviceAccess(request, resolved.deviceRid, {
      requireOwner: true,
    });
    if (auth instanceof NextResponse) return auth;

    scheduleRepoll(auth.device);
    return NextResponse.json({ scheduled: true }, { status: 202 });
  } catch (error) {
    console.error("[control] point refresh route failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to schedule refresh",
      },
      { status: 500 },
    );
  }
}
