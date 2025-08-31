import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getEnphaseClient } from '@/lib/enphase/enphase-client';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  console.log('ENPHASE: Connect endpoint called');
  
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      console.log('ENPHASE: Unauthorized connect attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('ENPHASE: User initiating connection:', userId);

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

    console.log('ENPHASE: Authorization URL generated for user:', userId);

    return NextResponse.json({ 
      authUrl,
      message: 'Redirect user to authorization URL'
    });
  } catch (error) {
    console.error('ENPHASE: Error in connect endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to initialize Enphase connection' },
      { status: 500 }
    );
  }
}