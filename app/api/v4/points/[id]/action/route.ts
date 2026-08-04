import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import {
  dispatchPointAction,
  loadPointByUuid,
} from "@/lib/control/point-actions";
import {
  POINT_ACTION_NAMES,
  isPointActionName,
} from "@/lib/control/point-control";
import { scheduleRepoll } from "@/lib/control/repoll";
import { Point } from "@/lib/ids";

/**
 * Actuate a writable point — the generic command plane's one entry point.
 *
 *   POST /api/v4/points/{pt_…}/action  { action, value? }  → 200 { ok, reason }
 *
 * `action` is the closed vocabulary `turn_on | turn_off | set_value | press`; what a given
 * point accepts is declared by its own `points.control` descriptor (switch / number / button),
 * which is written at mint time from vendor metadata rather than being user-editable. The route
 * validates against that descriptor, audits the attempt in `point_commands`, dispatches through
 * the vendor adapter's `ControlCapability` and returns the vendor's answer.
 *
 * ## Statuses
 *
 * 400 bad point id · bad body · not controllable · value out of range
 * 401/403/404 from `requireDeviceAccess` · 404 unknown point
 * 422 the vendor refused as a matter of protocol (`{error, code}`)
 * 501 vendor has no control capability, or the vendor's API isn't configured
 * 503 device unreachable (e.g. a Tesla that won't wake)
 * 500 anything unexpected
 *
 * 🛑 A BENIGN vendor decline is a **200 with `ok:false`** plus a `reason` (Tesla answers
 * `not_charging` when you stop an idle charge). It is not an error and must never 500.
 *
 * 🛑 Auth is `requireDeviceAccess(..., {requireOwner: true})` — `requireOwner` ALONE. It is the
 * CONTROL rule and is strictly narrower than write access, which is why no `requireWrite` rides
 * with it: ownership implies write (`ownsSubject` ⇒ `isOwner` ⇒ `canWrite`), so the write branch
 * could never fire on a request the owner branch admits, and the read/unauthenticated checks above
 * both run unconditionally. `lib/automations/references.ts` passes the same lone flag. It means: **only the device's owner may
 * command it** — a non-owner ADMIN is refused 403, and an ownerless device is commandable by
 * nobody (`ownsSubject` refuses two nulls). Admins keep their config write access everywhere
 * else; this is about actuating hardware, and the vendor command runs on the OWNER's stored
 * credentials. See `lib/control/ownership.ts`.
 *
 * This route is also deliberately absent from BOTH `publicRoutes` and `shareableRoutes`
 * (`lib/route-matchers.ts`), so the Clerk middleware rejects it before the handler runs for
 * anyone holding only a share token: a share token never authorizes a write.
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

    // Resolve the point (and thus its device) BEFORE authorizing: the device is what we
    // authorize against, and a point id names its device.
    const resolved = await loadPointByUuid(Point.toUuid(parsed.id));
    if (!resolved) {
      return NextResponse.json({ error: "Point not found" }, { status: 404 });
    }

    const auth = await requireDeviceAccess(request, resolved.deviceRid, {
      requireOwner: true,
    });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      value?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!isPointActionName(body.action)) {
      return NextResponse.json(
        {
          error: `Invalid action. Expected one of: ${POINT_ACTION_NAMES.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (body.value !== undefined && typeof body.value !== "number") {
      return NextResponse.json(
        { error: "value must be a number" },
        { status: 400 },
      );
    }

    const outcome = await dispatchPointAction({
      point: resolved.point,
      device: auth.device,
      action: body.action,
      value: body.value as number | undefined,
      requestedBy: auth.userId,
    });

    switch (outcome.kind) {
      case "invalid":
        return NextResponse.json({ error: outcome.error }, { status: 400 });
      case "unavailable":
        return NextResponse.json(
          { error: outcome.error },
          { status: outcome.httpStatus },
        );
      case "rejected":
        return NextResponse.json(
          { error: outcome.error, code: outcome.code },
          { status: 422 },
        );
      case "failed":
        return NextResponse.json({ error: outcome.error }, { status: 500 });
      case "completed":
        // Confirm the state via the real ingest path (the engine owns KV, not us). On a benign
        // decline too: "not_charging" back from a Stop proves the caller's view of the car was
        // stale, and the confirmation read is exactly what re-syncs it.
        scheduleRepoll(auth.device);
        return NextResponse.json({ ok: outcome.ok, reason: outcome.reason });
    }
  } catch (error) {
    console.error("[control] point action route failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to issue command",
      },
      { status: 500 },
    );
  }
}
