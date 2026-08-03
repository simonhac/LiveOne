import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import {
  dispatchPointAction,
  loadPointByStemMetric,
} from "@/lib/control/point-actions";
import type { PointActionName } from "@/lib/control/point-control";
import { scheduleRepoll } from "@/lib/control/repoll";
import type { TeslaChargeCommand } from "@/lib/vendors/tesla/types";

const VALID_COMMANDS: TeslaChargeCommand[] = [
  "charge_start",
  "charge_stop",
  "set_charge_limit",
  "set_charging_amps",
];

interface CommandBody {
  command?: TeslaChargeCommand;
  percent?: number; // set_charge_limit
  amps?: number; // set_charging_amps
}

/** The point address + action each legacy command names, in the generic plane. */
const COMMAND_MAP: Record<
  TeslaChargeCommand,
  { stem: string; metric: string; action: PointActionName }
> = {
  charge_start: { stem: "ev.charge", metric: "active", action: "turn_on" },
  charge_stop: { stem: "ev.charge", metric: "active", action: "turn_off" },
  set_charge_limit: {
    stem: "ev.charge.limit",
    metric: "soc",
    action: "set_value",
  },
  set_charging_amps: {
    stem: "ev.charge.limit",
    metric: "current",
    action: "set_value",
  },
};

/**
 * Issue a Tesla charge-control command for a system.
 *
 * 🛑 **This is now a SHIM.** The real work lives in the generic command plane
 * (`lib/control/point-actions` → the vendor adapter's `ControlCapability`); this route only
 * translates the legacy vendor-shaped request/response into a point action, so there is exactly
 * ONE code path that talks to a vehicle. Its external contract is unchanged and deliberately
 * frozen — `components/TeslaControlDialog.tsx` still calls it, and a later PR repoints that
 * dialog at `POST /api/v4/points/{pt_}/action`, after which this route can go.
 *
 * Auth: caller must own the device or be an admin (requireWrite). Credentials are always
 * loaded under the device OWNER (admins act on the owner's stored tokens) — that now happens
 * inside the capability, from the device alone, with no session user involved. Waking a
 * sleeping vehicle, the 501-without-Fleet-env check and the 422 signed-command refusal all
 * moved there too, with their messages preserved verbatim.
 *
 * One deliberate narrowing versus the old implementation: `set_charging_amps` above 48 A now
 * 400s here (the point's control descriptor caps at the vehicle's on-board-charger ceiling)
 * instead of being sent and clamped by the car. The only caller's UI already caps at 48.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const { systemId: idStr } = await params;
    const systemId = parseInt(idStr, 10);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const authResult = await requireDeviceAccess(request, systemId, {
      requireWrite: true,
    });
    if (authResult instanceof NextResponse) return authResult;
    const { device } = authResult;

    if (device.vendorType !== "tesla") {
      return NextResponse.json(
        { error: "System is not a Tesla system" },
        { status: 400 },
      );
    }

    // Legacy body validation, message-for-message with the pre-shim route.
    const body = (await request.json().catch(() => ({}))) as CommandBody;
    const { command } = body;
    if (!command || !VALID_COMMANDS.includes(command)) {
      return NextResponse.json(
        {
          error: `Invalid command. Expected one of: ${VALID_COMMANDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (command === "set_charge_limit") {
      if (
        typeof body.percent !== "number" ||
        body.percent < 50 ||
        body.percent > 100
      ) {
        return NextResponse.json(
          { error: "set_charge_limit requires percent (50–100)" },
          { status: 400 },
        );
      }
    }
    if (command === "set_charging_amps") {
      if (typeof body.amps !== "number" || body.amps < 0) {
        return NextResponse.json(
          { error: "set_charging_amps requires amps (>= 0)" },
          { status: 400 },
        );
      }
    }

    const target = COMMAND_MAP[command];
    const value =
      command === "set_charge_limit"
        ? body.percent
        : command === "set_charging_amps"
          ? body.amps
          : undefined;

    const point = await loadPointByStemMetric(
      systemId,
      target.stem,
      target.metric,
    );
    if (!point) {
      // Only reachable on a Tesla device that has never polled since the charge points were
      // introduced — the point is minted by the poll path, not here.
      return NextResponse.json(
        { error: "Charge-control point not found for this system" },
        { status: 404 },
      );
    }

    const outcome = await dispatchPointAction({
      point,
      device,
      action: target.action,
      value,
      requestedBy: authResult.userId,
    });

    switch (outcome.kind) {
      case "completed":
        if (outcome.ok) scheduleRepoll(device);
        // Tesla returns result=false with a reason for benign no-ops (e.g. "not_charging" when
        // stopping an idle charge). Surface it, don't 500.
        return NextResponse.json({
          success: outcome.ok,
          command,
          reason: outcome.reason,
        });
      case "rejected":
        // The car requires signed commands (not exempt) — Phase 2 territory.
        return NextResponse.json(
          { error: outcome.error, code: outcome.code },
          { status: 422 },
        );
      case "invalid":
        return NextResponse.json({ error: outcome.error }, { status: 400 });
      case "unavailable":
        return NextResponse.json(
          { error: outcome.error },
          { status: outcome.httpStatus },
        );
      case "failed":
        return NextResponse.json({ error: outcome.error }, { status: 500 });
    }
  } catch (error) {
    console.error("[Tesla] Error issuing command:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to issue command",
      },
      { status: 500 },
    );
  }
}
