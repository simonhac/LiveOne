import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import crypto from "crypto";
import { kv } from "@/lib/kv";
import {
  generatePKCE,
  getOwnerApiAuthorizationUrl,
} from "@/lib/vendors/tesla/tesla-sso-client";
import {
  teslaOAuthStateKey,
  TESLA_OAUTH_STATE_TTL_SECONDS,
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

export async function POST(request: NextRequest) {
  console.log("TESLA: Connect endpoint called");

  try {
    const { userId } = await auth();
    if (!userId) {
      console.log("TESLA: Unauthorized connect attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userDisplay = await getUserDisplay(userId);
    console.log("TESLA: User initiating Owner API connection:", userDisplay);

    // Optional email hint to prefill Tesla's login form.
    let loginHint: string | undefined;
    try {
      const body = await request.json().catch(() => null);
      if (body && typeof body.email === "string") loginHint = body.email;
    } catch {
      // no body — fine
    }

    // PKCE + opaque state. The verifier stays server-side (in KV); only the challenge
    // and state are exposed in the authorization URL.
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString("hex");

    const stateValue: TeslaOAuthState = { userId, codeVerifier };
    await kv.set(teslaOAuthStateKey(state), stateValue, {
      ex: TESLA_OAUTH_STATE_TTL_SECONDS,
    });

    const authUrl = getOwnerApiAuthorizationUrl(
      state,
      codeChallenge,
      loginHint,
    );

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
