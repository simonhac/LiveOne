import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import crypto from "crypto";
import { kv, kvKey } from "@/lib/kv";
import { SystemsManager } from "@/lib/systems-manager";
import {
  exchangeCodeForOwnerApiTokens,
  parseTeslaCallbackUrl,
} from "@/lib/vendors/tesla/tesla-sso-client";
import { getTeslaOwnerClient } from "@/lib/vendors/tesla/tesla-owner-client";
import { storeTeslaTokens } from "@/lib/vendors/tesla/tesla-auth";
import {
  teslaOAuthStateKey,
  type TeslaOAuthState,
} from "@/lib/vendors/tesla/tesla-oauth-state";
import type { TeslaTokens, TeslaVehicle } from "@/lib/vendors/tesla/types";

// When an account has multiple vehicles we can't re-use the single-use auth code, so we
// stash the exchanged tokens briefly and let the UI pick a vehicle in a second call.
const PENDING_TOKENS_TTL_SECONDS = 10 * 60;

function pendingTokensKey(selectionToken: string): string {
  return kvKey(`tesla:pending:${selectionToken}`);
}

interface PendingTokens {
  userId: string;
  tokens: TeslaTokens;
}

async function getUserDisplay(userId: string): Promise<string> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const identifier =
      user.username || user.emailAddresses[0]?.emailAddress || "unknown";
    return `${userId} (${identifier})`;
  } catch {
    return userId;
  }
}

/**
 * Create or reactivate a Tesla system for the chosen vehicle and store its tokens.
 * Mirrors the create/store logic in the (Fleet) callback route.
 */
async function createTeslaSystem(
  userId: string,
  vehicle: TeslaVehicle,
  tokens: TeslaTokens,
): Promise<number> {
  const vehicleId = String(vehicle.id);
  const systemsManager = SystemsManager.getInstance();

  const existingByVendorSiteId =
    await systemsManager.getSystemByVendorSiteId(vehicleId);
  const existingSystem =
    existingByVendorSiteId && existingByVendorSiteId.vendorType === "tesla"
      ? existingByVendorSiteId
      : null;

  let systemId: number;

  if (!existingSystem) {
    // Default to Melbourne timezone (can be updated later from system settings).
    const newSystem = await systemsManager.createSystem({
      ownerClerkUserId: userId,
      vendorType: "tesla",
      vendorSiteId: vehicleId,
      status: "active",
      displayName: vehicle.display_name || "Tesla Vehicle",
      model: vehicle.vin,
      solarSize: null,
      location: null,
      timezoneOffsetMin: 600, // UTC+10
      displayTimezone: "Australia/Melbourne",
    });
    systemId = newSystem.id;
    console.log("TESLA: Created system", systemId, "for vehicle", vehicleId);
  } else {
    systemId = existingSystem.id;
    await systemsManager.updateSystem(systemId, {
      ownerClerkUserId: userId,
      displayName: vehicle.display_name || existingSystem.displayName,
      status: "active",
    });
    console.log("TESLA: Reactivated existing system", systemId);
  }

  const storeResult = await storeTeslaTokens(
    userId,
    tokens,
    systemId,
    vehicleId,
  );
  if (!storeResult.success) {
    throw new Error(storeResult.error || "Failed to store tokens");
  }

  return systemId;
}

export async function POST(request: NextRequest) {
  console.log("TESLA: Complete endpoint called");

  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { callbackUrl, selectionToken, vehicleId } = body as {
      callbackUrl?: string;
      selectionToken?: string;
      vehicleId?: string;
    };

    const userDisplay = await getUserDisplay(userId);

    // ---- Second step: a vehicle was picked from the multi-vehicle list ----
    if (selectionToken && vehicleId) {
      const pendingKey = pendingTokensKey(selectionToken);
      const pending = (await kv.get(pendingKey)) as PendingTokens | null;
      if (!pending || pending.userId !== userId) {
        return NextResponse.json(
          { error: "Your selection expired. Please connect to Tesla again." },
          { status: 400 },
        );
      }
      await kv.del(pendingKey);

      const client = getTeslaOwnerClient();
      const vehicles = await client.getVehicles(pending.tokens.access_token);
      const vehicle = vehicles.find((v) => String(v.id) === vehicleId);
      if (!vehicle) {
        return NextResponse.json(
          { error: "That vehicle is no longer available on your account." },
          { status: 400 },
        );
      }

      const systemId = await createTeslaSystem(userId, vehicle, pending.tokens);
      return NextResponse.json({ success: true, systemId });
    }

    // ---- First step: exchange the pasted callback URL ----
    if (!callbackUrl) {
      return NextResponse.json(
        { error: "Missing the pasted Tesla URL." },
        { status: 400 },
      );
    }

    // Parse + validate the pasted URL, then look up the PKCE verifier by its state.
    const { code, state } = parseTeslaCallbackUrl(callbackUrl);

    const stateKey = teslaOAuthStateKey(state);
    const stored = (await kv.get(stateKey)) as TeslaOAuthState | null;
    if (!stored || stored.userId !== userId) {
      return NextResponse.json(
        {
          error:
            "This login link has expired or doesn't match your session. Please click Connect with Tesla again.",
        },
        { status: 400 },
      );
    }
    // Single-use: drop the verifier as soon as we've read it.
    await kv.del(stateKey);

    console.log("TESLA: Exchanging code for tokens for user:", userDisplay);
    const tokens = await exchangeCodeForOwnerApiTokens(
      code,
      stored.codeVerifier,
    );

    const client = getTeslaOwnerClient();
    const vehicles = await client.getVehicles(tokens.access_token);

    if (!vehicles || vehicles.length === 0) {
      return NextResponse.json(
        { error: "No Tesla vehicles were found on this account." },
        { status: 400 },
      );
    }

    if (vehicles.length === 1) {
      const systemId = await createTeslaSystem(userId, vehicles[0], tokens);
      return NextResponse.json({ success: true, systemId });
    }

    // Multiple vehicles — stash the tokens and let the UI pick one.
    const newSelectionToken = crypto.randomBytes(16).toString("hex");
    const pending: PendingTokens = { userId, tokens };
    await kv.set(pendingTokensKey(newSelectionToken), pending, {
      ex: PENDING_TOKENS_TTL_SECONDS,
    });

    return NextResponse.json({
      needsSelection: true,
      selectionToken: newSelectionToken,
      vehicles: vehicles.map((v) => ({
        id: String(v.id),
        displayName: v.display_name,
        vin: v.vin,
      })),
    });
  } catch (error) {
    console.error("TESLA: Error in complete endpoint:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to connect Tesla",
      },
      { status: 500 },
    );
  }
}
