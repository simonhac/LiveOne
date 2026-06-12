import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { getValidTeslaToken } from "@/lib/vendors/tesla/tesla-auth";
import { getTeslaClient } from "@/lib/vendors/tesla/tesla-client";
import { TeslaCommandProtocolError } from "@/lib/vendors/tesla/command-signer";
import type {
  TeslaChargeCommand,
  TeslaCommandResult,
  TeslaCredentials,
} from "@/lib/vendors/tesla/types";

// Charge commands are Fleet-API only (the Owner API path can't be relied on).
const hasFleetApiConfig = !!(
  process.env.TESLA_CLIENT_ID &&
  process.env.TESLA_CLIENT_SECRET &&
  process.env.TESLA_REDIRECT_URI
);

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

/**
 * Issue a Tesla charge-control command for a system.
 *
 * Auth: caller must own the system or be an admin (requireWrite). Credentials are
 * always loaded under the system OWNER (admins act on the owner's stored tokens).
 * Wakes the vehicle if asleep, then dispatches through the Fleet client's signer seam
 * (direct/unsigned for signing-exempt cars; a 403 surfaces as a clear error).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params;
    const systemId = parseInt(idStr, 10);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const authResult = await requireSystemAccess(request, systemId, {
      requireWrite: true,
    });
    if (authResult instanceof NextResponse) return authResult;
    const { system } = authResult;

    if (system.vendorType !== "tesla") {
      return NextResponse.json(
        { error: "System is not a Tesla system" },
        { status: 400 },
      );
    }

    if (!hasFleetApiConfig) {
      return NextResponse.json(
        { error: "Tesla charge control requires Fleet API configuration" },
        { status: 501 },
      );
    }

    // Validate body
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

    if (!system.ownerClerkUserId) {
      return NextResponse.json(
        { error: "System has no owner" },
        { status: 400 },
      );
    }

    // Load the owner's token + regional host
    const { accessToken, credentials } = await getValidTeslaToken(
      system.ownerClerkUserId,
      systemId,
    );
    const teslaCredentials = credentials as TeslaCredentials;
    const vehicleId = teslaCredentials.vehicle_id;
    const client = getTeslaClient(teslaCredentials.fleet_api_base_url);

    // Wake if asleep (commands fail on a sleeping vehicle)
    const vehicles = await client.getVehicles(accessToken);
    const vehicle = vehicles.find((v) => String(v.id) === vehicleId);
    if (!vehicle) {
      return NextResponse.json(
        { error: `Vehicle ${vehicleId} not found` },
        { status: 404 },
      );
    }
    if (vehicle.state !== "online") {
      const awoke = await client.wakeUp(accessToken, vehicleId);
      if (!awoke) {
        return NextResponse.json(
          { error: "Vehicle is asleep and did not wake up; try again shortly" },
          { status: 503 },
        );
      }
    }

    // Dispatch
    let result: TeslaCommandResult;
    switch (command) {
      case "charge_start":
        result = await client.chargeStart(accessToken, vehicleId);
        break;
      case "charge_stop":
        result = await client.chargeStop(accessToken, vehicleId);
        break;
      case "set_charge_limit":
        result = await client.setChargeLimit(
          accessToken,
          vehicleId,
          body.percent as number,
        );
        break;
      case "set_charging_amps":
        result = await client.setChargingAmps(
          accessToken,
          vehicleId,
          body.amps as number,
        );
        break;
    }

    // Tesla returns result=false with a reason for benign no-ops
    // (e.g. "not_charging" when stopping an idle charge). Surface it, don't 500.
    return NextResponse.json({
      success: result.result,
      command,
      reason: result.reason || null,
    });
  } catch (error) {
    if (error instanceof TeslaCommandProtocolError) {
      // The car requires signed commands (not exempt) — Phase 2 territory.
      return NextResponse.json(
        {
          error:
            "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
          code: "vehicle_command_protocol_required",
        },
        { status: 422 },
      );
    }
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
