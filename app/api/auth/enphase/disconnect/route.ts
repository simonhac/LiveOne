import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { getSystemCredentials } from '@/lib/secure-credentials';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { SystemsManager } from '@/lib/systems-manager';

async function getUserDisplay(userId: string): Promise<string> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const identifier = user.username || user.emailAddresses[0]?.emailAddress || 'unknown';
    return `${userId} (${identifier})`;
  } catch {
    return userId;
  }
}

export async function POST(request: NextRequest) {
  console.log('ENPHASE: Disconnect endpoint called');
  
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      console.log('ENPHASE: Unauthorized disconnect attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userDisplay = await getUserDisplay(userId);
    console.log('ENPHASE: User disconnecting Enphase:', userDisplay);

    // Note: We don't clear tokens anymore - systems are just marked as removed
    // and credentials are ignored for removed systems

    // Mark Enphase systems as removed instead of deleting
    const result = await db.update(systems)
      .set({
        ownerClerkUserId: null,
        status: 'removed',
        updatedAt: new Date()
      })
      .where(
        and(
          eq(systems.ownerClerkUserId, userId),
          eq(systems.vendorType, 'enphase')
        )
      );

    console.log('ENPHASE: Disconnected successfully for user:', userDisplay);

    return NextResponse.json({ 
      success: true,
      message: 'Enphase system disconnected'
    });
  } catch (error) {
    console.error('ENPHASE: Error in disconnect endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to disconnect Enphase system' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  console.log('ENPHASE: Status check endpoint called');
  
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ connected: false });
    }

    const searchParams = request.nextUrl.searchParams;
    const systemId = searchParams.get('systemId');

    if (!systemId) {
      return NextResponse.json({ error: 'systemId parameter required' }, { status: 400 });
    }

    // Use SystemsManager to get the system
    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystem(parseInt(systemId));

    if (!system ||
        system.ownerClerkUserId !== userId ||
        system.vendorType !== 'enphase' ||
        system.status !== 'active') {
      return NextResponse.json({ connected: false });
    }

    // Check if credentials exist for this system
    const credentials = await getSystemCredentials(userId, system.id);

    return NextResponse.json({
      connected: credentials !== null,
      systemId: system.id,
      systemName: system.displayName,
      expiresAt: (credentials as any)?.expires_at
    });
  } catch (error) {
    console.error('ENPHASE: Error checking status:', error);
    return NextResponse.json({ connected: false });
  }
}