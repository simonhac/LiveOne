import { NextRequest, NextResponse } from "next/server";
import { getEnphaseClient } from "@/lib/vendors/enphase/enphase-client";
import { storeEnphaseTokens } from "@/lib/vendors/enphase/enphase-auth";
import { clerkClient } from "@clerk/nextjs/server";
import { DeviceWriter } from "@/lib/registry/device-writer";
import type { AreaLocation } from "@/lib/areas/types";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

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
  console.log("ENPHASE: OAuth callback received");

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Log all received parameters (mask sensitive data)
  console.log("ENPHASE: Callback parameters:", {
    code: code ? `${code.substring(0, 10)}...XXXXXX` : null,
    state: state ? `${state.substring(0, 20)}...XXXXXX` : null,
    error: error,
    allParams: Array.from(searchParams.keys()),
  });

  // Handle denial
  if (error) {
    console.log("ENPHASE: User denied authorization:", error);
    return NextResponse.redirect(
      new URL("/auth/enphase/result?error=access_denied", request.url),
    );
  }

  if (!code || !state) {
    console.error("ENPHASE: Missing code or state in callback");
    return NextResponse.redirect(
      new URL("/auth/enphase/result?error=invalid_callback", request.url),
    );
  }

  try {
    // Decode and validate state
    const stateData = JSON.parse(Buffer.from(state, "base64").toString());
    const { userId, timestamp } = stateData;

    console.log("ENPHASE: Decoded state:", {
      userId: userId ? `${userId.substring(0, 10)}...XXXXXX` : null,
      timestamp: timestamp,
      age: Date.now() - timestamp,
      ageMinutes: Math.round((Date.now() - timestamp) / 60000),
    });

    // Check if state is not too old (15 minutes)
    if (Date.now() - timestamp > 15 * 60 * 1000) {
      const userDisplay = await getUserDisplay(userId);
      console.error("ENPHASE: State expired for user:", userDisplay);
      return NextResponse.redirect(
        new URL("/auth/enphase/result?error=state_expired", request.url),
      );
    }

    const userDisplay = await getUserDisplay(userId);
    console.log("ENPHASE: Processing callback for user:", userDisplay);

    // Exchange code for tokens
    const client = getEnphaseClient();
    const tokens = await client.exchangeCodeForTokens(code);

    // Log token response (mask sensitive data)
    console.log("ENPHASE: Tokens obtained:", {
      access_token: tokens.access_token
        ? `${tokens.access_token.substring(0, 20)}...XXXXXX`
        : null,
      refresh_token: tokens.refresh_token
        ? `${tokens.refresh_token.substring(0, 20)}...XXXXXX`
        : null,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      hasEnlUid: !!tokens.enl_uid,
    });

    console.log("ENPHASE: Fetching systems from Enphase API");

    // Get user's Enphase systems
    const enphaseSystems = await client.getSystems(tokens.access_token);

    if (!enphaseSystems || enphaseSystems.length === 0) {
      console.error("ENPHASE: No systems found for user:", userDisplay);
      return NextResponse.redirect(
        new URL("/auth/enphase/result?error=no_systems", request.url),
      );
    }

    // Log all available systems
    console.log("ENPHASE: Found systems for user:", userDisplay);
    enphaseSystems.forEach((sys, index) => {
      console.log(
        `ENPHASE: System ${index + 1}:`,
        JSON.stringify(sys, null, 2),
      );
    });

    // Use the first system (in future, allow user to select)
    const enphaseSystem = enphaseSystems[0];
    const systemId = String(enphaseSystem.system_id);
    console.log("ENPHASE: Using system:", systemId, enphaseSystem.name);

    // Existence check reads the config registry (`devices`); the writers below are still `systems`.

    const existingByVendorSiteId =
      await DeviceConfigRegistry.deviceByVendorSite(systemId);
    const existingSystem =
      existingByVendorSiteId && existingByVendorSiteId.vendorType === "enphase"
        ? existingByVendorSiteId
        : null;

    if (!existingSystem) {
      // Create new system in database
      console.log("ENPHASE: Creating new system in database");

      // Calculate timezone offset from timezone string
      let timezoneOffsetMin = 600; // Default to AEST (UTC+10)
      let displayTimezone = "Australia/Melbourne"; // Default timezone
      if (enphaseSystem.timezone) {
        // This is simplified - in production, use a proper timezone library
        if (
          enphaseSystem.timezone.includes("Melbourne") ||
          enphaseSystem.timezone.includes("Sydney")
        ) {
          timezoneOffsetMin = 600; // UTC+10
          displayTimezone = "Australia/Melbourne";
        }
        // Add more timezone mappings as needed
      }

      const newSystem = await DeviceWriter.createSystem({
        ownerClerkUserId: userId,
        vendorType: "enphase",
        vendorSiteId: systemId,
        status: "active",
        displayName: enphaseSystem.name || "Enphase System",
        model: "Enphase IQ",
        // Slice 1a: goes straight to the structured `config.spec`. Enphase reports `system_size` in
        // WATTS, so pre-1a this formatted it into the free text `"5.4 kW"` purely so the mirror's SQL
        // could parse it back out into `spec.solarSizeKw`. The string round-trip is gone, but the
        // `toFixed(1)` ROUNDING is kept deliberately — dropping it would change the stored value for
        // every Enphase device (5432 W read 5.4, not 5.432), which is a data change dressed as a
        // cleanup. `> 0` reproduces `specNum`'s rejection of non-positive values.
        config:
          enphaseSystem.system_size && enphaseSystem.system_size > 0
            ? {
                spec: {
                  solarSizeKw: Number(
                    (enphaseSystem.system_size / 1000).toFixed(1),
                  ),
                },
              }
            : null,
        // See the cast note on the update path below — same reason, same pre-1a behaviour.
        location: (enphaseSystem.address ?? null) as AreaLocation | null,
        timezoneOffsetMin,
        displayTimezone,
      });

      console.log(
        "ENPHASE: System created successfully with ID:",
        newSystem.id,
      );

      // Now store tokens with the new system ID
      const storeResult = await storeEnphaseTokens(
        userId,
        tokens,
        newSystem.id,
      );
      if (!storeResult.success) {
        throw new Error(storeResult.error || "Failed to store tokens");
      }
      console.log("ENPHASE: Tokens stored for new system");
    } else {
      // Update existing system (reactivate if it was removed)
      console.log("ENPHASE: Updating existing system");

      await DeviceWriter.updateSystem(existingSystem.id, {
        ownerClerkUserId: userId,
        displayName: enphaseSystem.name || existingSystem.displayName,
        // Slice 1a: `location` is now typed `AreaLocation` (it lands on `areas.location`) whereas it
        // used to land in the untyped `systems.location` jsonb. Enphase's address has every field
        // optional, so it does not satisfy `AreaLocation.country: string`. The cast preserves the exact
        // pre-1a behaviour — `ensureAreaOfOne` cast this same value `as AreaLocation | null` when it
        // copied it down — rather than inventing a country here. A partial address still reads fine:
        // `region.ts` infers from `state`/`postcode` and tolerates a missing country.
        location: (enphaseSystem.address ||
          existingSystem.location) as AreaLocation | null,
        status: "active", // Reactivate the system if it was removed
      });

      // Store tokens with the existing system ID
      const storeResult = await storeEnphaseTokens(
        userId,
        tokens,
        existingSystem.id,
      );
      if (!storeResult.success) {
        throw new Error(storeResult.error || "Failed to store tokens");
      }
      console.log("ENPHASE: Tokens stored for existing system");
    }

    console.log("ENPHASE: Connection complete for user:", userDisplay);
    console.log("ENPHASE: System successfully connected:", systemId);

    // Redirect to result page with success message
    const successUrl = new URL("/auth/enphase/result", request.url);
    successUrl.searchParams.set("status", "success");
    successUrl.searchParams.set(
      "message",
      `Successfully connected ${enphaseSystem.name || "Enphase System"}`,
    );

    return NextResponse.redirect(successUrl);
  } catch (error) {
    console.error("ENPHASE: Error in callback - Full details:", error);
    console.error(
      "ENPHASE: Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );

    // Determine error message
    let errorMessage = "Connection failed";
    if (error instanceof Error) {
      if (error.message.includes("Invalid state")) {
        errorMessage =
          "Invalid authorisation state. Please try connecting again.";
      } else if (error.message.includes("No code")) {
        errorMessage = "Authorisation was denied or cancelled.";
      } else if (error.message.includes("token")) {
        errorMessage = "Failed to obtain access token. Please try again.";
      } else if (error.message.includes("system")) {
        errorMessage = "Failed to retrieve Enphase system information.";
      } else {
        errorMessage = error.message;
      }
    }

    const errorUrl = new URL("/auth/enphase/result", request.url);
    errorUrl.searchParams.set("status", "error");
    errorUrl.searchParams.set("message", errorMessage);

    return NextResponse.redirect(errorUrl);
  }
}
