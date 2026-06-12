import { NextRequest, NextResponse } from "next/server";
import { getTeslaClient } from "@/lib/vendors/tesla/tesla-client";
import { storeTeslaTokens } from "@/lib/vendors/tesla/tesla-auth";
import { clerkClient } from "@clerk/nextjs/server";
import { SystemsManager } from "@/lib/systems-manager";
import { kv } from "@/lib/kv";
import {
  teslaOAuthStateKey,
  type TeslaOAuthState,
} from "@/lib/vendors/tesla/tesla-oauth-state";

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

export async function GET(request: NextRequest) {
  console.log("TESLA: OAuth callback received");

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Log all received parameters (mask sensitive data)
  console.log("TESLA: Callback parameters:", {
    code: code ? `${code.substring(0, 10)}...XXXXXX` : null,
    state: state ? `${state.substring(0, 20)}...XXXXXX` : null,
    error: error,
    allParams: Array.from(searchParams.keys()),
  });

  // Handle denial
  if (error) {
    console.log("TESLA: User denied authorization:", error);
    return NextResponse.redirect(
      new URL("/auth/tesla/result?error=access_denied", request.url),
    );
  }

  if (!code || !state) {
    console.error("TESLA: Missing code or state in callback");
    return NextResponse.redirect(
      new URL("/auth/tesla/result?error=invalid_callback", request.url),
    );
  }

  try {
    // Look the PKCE verifier up from KV by the opaque `state` (stored by /connect).
    // The verifier never touches the browser; the KV entry is single-use and TTL-bound,
    // which also enforces the 15-minute window (expired => no entry).
    const stateKey = teslaOAuthStateKey(state);
    const stored = (await kv.get(stateKey)) as TeslaOAuthState | null;

    if (!stored || !stored.userId || !stored.codeVerifier) {
      console.error("TESLA: No/expired OAuth state for callback");
      return NextResponse.redirect(
        new URL("/auth/tesla/result?error=state_expired", request.url),
      );
    }
    await kv.del(stateKey); // single-use

    const { userId, codeVerifier } = stored;

    const userDisplay = await getUserDisplay(userId);
    console.log("TESLA: Processing callback for user:", userDisplay);

    // Exchange code for tokens (default NA host is fine for auth + region lookup).
    const client = getTeslaClient();
    const tokens = await client.exchangeCodeForTokens(code, codeVerifier);

    // Resolve the user's regional Fleet host and use it for all subsequent calls.
    let fleetApiBaseUrl: string | undefined;
    try {
      const region = await client.getUserRegion(tokens.access_token);
      fleetApiBaseUrl = region.fleet_api_base_url;
      console.log("TESLA: Resolved region host:", fleetApiBaseUrl);
    } catch (e) {
      console.warn("TESLA: Region lookup failed, using default host:", e);
    }
    const regionClient = getTeslaClient(fleetApiBaseUrl);

    // Log token response (mask sensitive data)
    console.log("TESLA: Tokens obtained:", {
      access_token: tokens.access_token
        ? `${tokens.access_token.substring(0, 20)}...XXXXXX`
        : null,
      refresh_token: tokens.refresh_token
        ? `${tokens.refresh_token.substring(0, 20)}...XXXXXX`
        : null,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
    });

    console.log("TESLA: Fetching vehicles from Tesla API");

    // Get user's Tesla vehicles
    const teslaVehicles = await regionClient.getVehicles(tokens.access_token);

    if (!teslaVehicles || teslaVehicles.length === 0) {
      console.error("TESLA: No vehicles found for user:", userDisplay);
      return NextResponse.redirect(
        new URL("/auth/tesla/result?error=no_vehicles", request.url),
      );
    }

    // Log all available vehicles
    console.log("TESLA: Found vehicles for user:", userDisplay);
    teslaVehicles.forEach((veh, index) => {
      console.log(`TESLA: Vehicle ${index + 1}:`, JSON.stringify(veh, null, 2));
    });

    // Use the first vehicle (auto-select like Enphase)
    const teslaVehicle = teslaVehicles[0];
    const vehicleId = String(teslaVehicle.id);
    console.log("TESLA: Using vehicle:", vehicleId, teslaVehicle.display_name);

    // Check if system already exists (read via SystemsManager so it honours
    // CONFIG_SERVE_FROM_PG — the same store createSystem/updateSystem write to).
    const systemsManager = SystemsManager.getInstance();
    const existingByVendorSiteId =
      await systemsManager.getSystemByVendorSiteId(vehicleId);
    const existingSystem =
      existingByVendorSiteId && existingByVendorSiteId.vendorType === "tesla"
        ? existingByVendorSiteId
        : null;

    if (!existingSystem) {
      // Create new system in database
      console.log("TESLA: Creating new system in database");

      // Default to Melbourne timezone (can be updated later)
      const timezoneOffsetMin = 600; // UTC+10
      const displayTimezone = "Australia/Melbourne";

      const newSystem = await systemsManager.createSystem({
        ownerClerkUserId: userId,
        vendorType: "tesla",
        vendorSiteId: vehicleId,
        status: "active",
        displayName: teslaVehicle.display_name || "Tesla Vehicle",
        model: teslaVehicle.vin,
        solarSize: null,
        location: null,
        timezoneOffsetMin,
        displayTimezone,
      });

      console.log("TESLA: System created successfully with ID:", newSystem.id);

      // Store tokens with the new system ID
      const storeResult = await storeTeslaTokens(
        userId,
        tokens,
        newSystem.id,
        vehicleId,
        fleetApiBaseUrl,
      );
      if (!storeResult.success) {
        throw new Error(storeResult.error || "Failed to store tokens");
      }
      console.log("TESLA: Tokens stored for new system");
    } else {
      // Update existing system (reactivate if it was removed)
      console.log("TESLA: Updating existing system");

      await systemsManager.updateSystem(existingSystem.id, {
        ownerClerkUserId: userId,
        displayName: teslaVehicle.display_name || existingSystem.displayName,
        status: "active", // Reactivate the system if it was removed
      });

      // Store tokens with the existing system ID
      const storeResult = await storeTeslaTokens(
        userId,
        tokens,
        existingSystem.id,
        vehicleId,
        fleetApiBaseUrl,
      );
      if (!storeResult.success) {
        throw new Error(storeResult.error || "Failed to store tokens");
      }
      console.log("TESLA: Tokens stored for existing system");
    }

    console.log("TESLA: Connection complete for user:", userDisplay);
    console.log("TESLA: Vehicle successfully connected:", vehicleId);

    // Redirect to result page with success message
    const successUrl = new URL("/auth/tesla/result", request.url);
    successUrl.searchParams.set("status", "success");
    successUrl.searchParams.set(
      "message",
      `Successfully connected ${teslaVehicle.display_name || "Tesla Vehicle"}`,
    );

    return NextResponse.redirect(successUrl);
  } catch (error) {
    console.error("TESLA: Error in callback - Full details:", error);
    console.error(
      "TESLA: Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );

    // Determine error message
    let errorMessage = "Connection failed";
    if (error instanceof Error) {
      if (error.message.includes("Invalid state")) {
        errorMessage =
          "Invalid authorization state. Please try connecting again.";
      } else if (error.message.includes("No code")) {
        errorMessage = "Authorization was denied or cancelled.";
      } else if (error.message.includes("token")) {
        errorMessage = "Failed to obtain access token. Please try again.";
      } else if (error.message.includes("vehicle")) {
        errorMessage = "Failed to retrieve Tesla vehicle information.";
      } else {
        errorMessage = error.message;
      }
    }

    const errorUrl = new URL("/auth/tesla/result", request.url);
    errorUrl.searchParams.set("status", "error");
    errorUrl.searchParams.set("message", errorMessage);

    return NextResponse.redirect(errorUrl);
  }
}
