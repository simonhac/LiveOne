import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { sessionManager } from "@/lib/session-manager";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an admin
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { sessionId: sessionIdStr } = await params;
    const sessionId = parseInt(sessionIdStr);

    if (isNaN(sessionId)) {
      return NextResponse.json(
        { error: "Invalid session ID" },
        { status: 400 },
      );
    }

    const session = await sessionManager.getSessionById(sessionId);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Format dates to ISO strings for JSON response
    const formattedSession = {
      ...session,
      started: session.started.toISOString(),
      createdAt: session.createdAt.toISOString(),
    };

    return NextResponse.json({
      success: true,
      session: formattedSession,
    });
  } catch (error) {
    console.error("[API] Error fetching session:", error);
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 },
    );
  }
}
