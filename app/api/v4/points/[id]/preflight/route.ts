import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { loadPointByUuid } from "@/lib/control/point-actions";
import { ControlDispatchError } from "@/lib/control/errors";
import { Point } from "@/lib/ids";
import { VendorRegistry } from "@/lib/vendors/registry";

/**
 * Ask what would happen if this point were commanded RIGHT NOW, without commanding it.
 *
 *   POST /api/v4/points/{pt_…}/preflight  { value? }
 *     → 200 { ok, wouldProceed, verdict, checks[], detail }
 *
 * The read-only sibling of `../action`, and the reason the generator UI can gate its Start button
 * on something better than a 15-second-old pushed reading: for DeepSea this walks the whole chain
 * (Cloudflare Access → passkey → hub supervisor → device mutex → Modbus over WireGuard → the DSE)
 * using FC3 READS ONLY, and returns the verdict `gateStart()` would produce for a real run.
 *
 * 🛑 NOT a command, and deliberately not routed through `dispatchPointAction`:
 *  - it writes nothing, so it takes NO `point_commands` audit row — that trail records dispatched
 *    attempts, and filling it with probes would bury the presses in noise;
 *  - it validates no action against `points.control`, because there is no action to validate.
 * What it DOES share with a command is the authorization: owner-only, exactly like the sibling
 * `../refresh` route, because it spends a round trip to someone's hardware. It stays out of
 * `publicRoutes`/`shareableRoutes` for the same reason.
 *
 * `optional value` lets the caller ask about a SPECIFIC command ("would a 30 minute run start?")
 * rather than the vendor's default, so the answer the UI shows is the answer to the question the
 * button is about to ask.
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

    // A body is optional — an empty POST asks about the vendor's default command.
    let value: number | undefined;
    const raw = await request.text();
    if (raw) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json(
          { error: "Malformed JSON body" },
          { status: 400 },
        );
      }
      const v = (body as { value?: unknown }).value;
      if (v !== undefined) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return NextResponse.json(
            { error: "'value' must be a finite number" },
            { status: 400 },
          );
        }
        value = v;
      }
    }

    const capability = VendorRegistry.getControlCapability(
      auth.device.vendorType,
    );
    if (!capability?.preflight) {
      // The honest answer for a vendor whose hardware cannot be asked without being poked.
      return NextResponse.json(
        {
          error: `Vendor '${auth.device.vendorType}' does not support a control preflight`,
        },
        { status: 501 },
      );
    }

    const result = await capability.preflight({
      device: auth.device,
      point: resolved.point,
      value,
    });
    return NextResponse.json(result);
  } catch (error) {
    // A capability's own "I could not reach it" is returned as `{ok:false, verdict}`, not thrown —
    // so a ControlDispatchError here is a CONFIGURATION problem (wrong point, no owner, no
    // passkey) and keeps its status.
    if (error instanceof ControlDispatchError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.httpStatus },
      );
    }
    console.error("[control] point preflight route failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to run preflight",
      },
      { status: 500 },
    );
  }
}
