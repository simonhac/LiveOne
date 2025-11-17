import { NextRequest, NextResponse } from "next/server";
import { getEnphaseClient } from "@/lib/vendors/enphase/enphase-client";
import { storeEnphaseTokens } from "@/lib/vendors/enphase/enphase-auth";
import { db } from "@/lib/db";
import { systems } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { SystemsManager } from "@/lib/systems-manager";

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

    // Check if system already exists in database FIRST (before storing tokens)
    const existingSystem = await db
      .select()
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, "enphase"),
          eq(systems.vendorSiteId, systemId),
        ),
      )
      .limit(1);

    if (existingSystem.length === 0) {
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

      const systemsManager = SystemsManager.getInstance();
      const newSystem = await systemsManager.createSystem({
        ownerClerkUserId: userId,
        vendorType: "enphase",
        vendorSiteId: systemId,
        status: "active",
        displayName: enphaseSystem.name || "Enphase System",
        model: "Enphase IQ",
        solarSize: enphaseSystem.system_size
          ? `${(enphaseSystem.system_size / 1000).toFixed(1)} kW`
          : null,
        location: enphaseSystem.address || null, // Store the address object directly
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

      await db
        .update(systems)
        .set({
          ownerClerkUserId: userId,
          displayName: enphaseSystem.name || existingSystem[0].displayName,
          location: enphaseSystem.address || existingSystem[0].location, // Update location if available
          status: "active", // Reactivate the system if it was removed
          updatedAt: new Date(),
        })
        .where(eq(systems.id, existingSystem[0].id));

      // Store tokens with the existing system ID
      const storeResult = await storeEnphaseTokens(
        userId,
        tokens,
        existingSystem[0].id,
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
