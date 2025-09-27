import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isUserAdmin } from '@/lib/auth-utils';
import { sessionManager } from '@/lib/session-manager';

export async function GET(request: NextRequest) {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is an admin
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const start = searchParams.get('start');
    const count = searchParams.get('count');
    const last = searchParams.get('last');

    let result;

    if (last) {
      // Get the last N sessions
      const lastCount = Math.min(parseInt(last), 100);
      result = await sessionManager.getLastSessions(lastCount);
    } else if (start && count) {
      // Get sessions starting from a specific ID
      const startId = parseInt(start);
      const sessionCount = Math.min(parseInt(count), 100);
      result = await sessionManager.getSessions(startId, sessionCount);
    } else {
      // Default: get last 20 sessions
      result = await sessionManager.getLastSessions(20);
    }

    // Format dates to ISO strings for JSON response
    const formattedSessions = result.sessions.map(session => ({
      ...session,
      started: session.started.toISOString(),
      createdAt: session.createdAt.toISOString(),
    }));

    return NextResponse.json({
      success: true,
      sessions: formattedSessions,
      count: result.count,
    });
  } catch (error) {
    console.error('[API] Error fetching sessions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}