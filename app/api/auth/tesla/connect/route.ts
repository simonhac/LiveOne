import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import crypto from "crypto";
import { kv } from "@/lib/kv";
import { generatePKCE, getTeslaClient } from "@/lib/vendors/tesla/tesla-client";
import {
  teslaOAuthStateKey,
  TESLA_OAUTH_STATE_TTL_SECONDS,
  type TeslaOAuthState,
} from "@/lib/vendors/tesla/tesla-oauth-state";

// The Fleet API is the only supported path (the Owner API `void/callback` redirect is
// de-registered). Without these env vars there is no working Tesla onboarding.
const hasFleetApiConfig = !!(
  process.env.TESLA_CLIENT_ID &&
  process.env.TESLA_CLIENT_SECRET &&
  process.env.TESLA_REDIRECT_URI
);

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

export async function POST(_request: NextRequest) {
  console.log("TESLA: Connect endpoint called");

  try {
    const { userId } = await auth();
    if (!userId) {
      console.log("TESLA: Unauthorized connect attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasFleetApiConfig) {
      console.error("TESLA: Fleet API not configured; cannot start connect");
      return NextResponse.json(
        {
          error:
            "Tesla integration is not configured (Fleet API credentials missing).",
        },
        { status: 503 },
      );
    }

    const userDisplay = await getUserDisplay(userId);
    console.log("TESLA: User initiating Fleet API connection:", userDisplay);

    // PKCE + opaque state. The verifier stays server-side (in KV); only the challenge
    // and state are exposed in the authorization URL. The `state` round-trips through
    // Tesla and is how the callback looks the verifier back up.
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");

    const stateValue: TeslaOAuthState = { userId, codeVerifier };
    await kv.set(teslaOAuthStateKey(state), stateValue, {
      ex: TESLA_OAUTH_STATE_TTL_SECONDS,
    });

    const authUrl = getTeslaClient().getAuthorizationUrl(state, codeChallenge);

    console.log("TESLA: Authorization URL generated for user:", userDisplay);

    return NextResponse.json({
      authUrl,
      message: "Redirect user to authorization URL",
    });
  } catch (error) {
    console.error("TESLA: Error in connect endpoint:", error);
    return NextResponse.json(
      { error: "Failed to initialize Tesla connection" },
      { status: 500 },
    );
  }
}
