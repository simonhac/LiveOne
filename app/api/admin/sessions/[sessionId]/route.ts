import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { sessionManager } from "@/lib/session-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

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
