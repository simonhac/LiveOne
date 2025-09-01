import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { getEnphaseClient } from '@/lib/enphase/enphase-client';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

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

    // Clear tokens from Clerk metadata
    const client = getEnphaseClient();
    if ('clearTokens' in client) {
      await (client as any).clearTokens(userId);
    }

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

    // Check if user has Enphase credentials
    const client = getEnphaseClient();
    const credentials = await client.getStoredTokens(userId);
    
    if (!credentials) {
      return NextResponse.json({ connected: false });
    }

    // Check if active system exists in database
    const system = await db.select()
      .from(systems)
      .where(
        and(
          eq(systems.ownerClerkUserId, userId),
          eq(systems.vendorType, 'enphase'),
          eq(systems.vendorSiteId, credentials.enphase_system_id),
          eq(systems.status, 'active')
        )
      )
      .limit(1);

    return NextResponse.json({ 
      connected: system.length > 0,
      systemId: credentials.enphase_system_id,
      expiresAt: credentials.expires_at
    });
  } catch (error) {
    console.error('ENPHASE: Error checking status:', error);
    return NextResponse.json({ connected: false });
  }
}