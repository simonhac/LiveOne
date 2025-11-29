import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getTeslaClient, generatePKCE } from "@/lib/vendors/tesla/tesla-client";

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
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      console.log("TESLA: Unauthorized connect attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userDisplay = await getUserDisplay(userId);
    console.log("TESLA: User initiating connection:", userDisplay);

    // Generate PKCE code verifier and challenge
    const { codeVerifier, codeChallenge } = generatePKCE();

    // Create state with userId, timestamp, and code_verifier
    // Note: code_verifier is included in state (base64 encoded) to be retrieved in callback
    const stateData = Buffer.from(
      JSON.stringify({
        userId,
        timestamp: Date.now(),
        codeVerifier, // Include for retrieval in callback
      }),
    ).toString("base64");

    // Get the Tesla client and generate authorization URL
    const client = getTeslaClient();
    const authUrl = client.getAuthorizationUrl(stateData, codeChallenge);

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
