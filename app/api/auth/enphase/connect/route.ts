import { NextRequest, NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { getEnphaseClient } from '@/lib/vendors/enphase/enphase-client';
import crypto from 'crypto';

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
  console.log('ENPHASE: Connect endpoint called');
  
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      console.log('ENPHASE: Unauthorized connect attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userDisplay = await getUserDisplay(userId);
    console.log('ENPHASE: User initiating connection:', userDisplay);

    // Generate a secure state parameter
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state in a secure session or database
    // For now, we'll include userId in the state (in production, use a proper session store)
    const stateData = Buffer.from(JSON.stringify({
      userId,
      timestamp: Date.now(),
      nonce: state
    })).toString('base64');

    // Get the origin from the request
    const origin = request.headers.get('origin') || request.nextUrl.origin;
    
    // Get the Enphase client and generate authorization URL
    const client = getEnphaseClient();
    const authUrl = client.getAuthorizationUrl(stateData, origin);

    console.log('ENPHASE: Authorisation URL generated for user:', userDisplay);

    return NextResponse.json({ 
      authUrl,
      message: 'Redirect user to authorisation URL'
    });
  } catch (error) {
    console.error('ENPHASE: Error in connect endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to initialise Enphase connection' },
      { status: 500 }
    );
  }
}