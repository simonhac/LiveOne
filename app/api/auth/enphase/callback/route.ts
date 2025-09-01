import { NextRequest, NextResponse } from 'next/server';
import { getEnphaseClient } from '@/lib/enphase/enphase-client';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { clerkClient } from '@clerk/nextjs/server';

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

export async function GET(request: NextRequest) {
  console.log('ENPHASE: OAuth callback received');
  
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  
  // Log all received parameters (mask sensitive data)
  console.log('ENPHASE: Callback parameters:', {
    code: code ? `${code.substring(0, 10)}...XXXXXX` : null,
    state: state ? `${state.substring(0, 20)}...XXXXXX` : null,
    error: error,
    allParams: Array.from(searchParams.keys())
  });

  // Handle denial
  if (error) {
    console.log('ENPHASE: User denied authorization:', error);
    return NextResponse.redirect(
      new URL('/auth/enphase/result?error=access_denied', request.url)
    );
  }

  if (!code || !state) {
    console.error('ENPHASE: Missing code or state in callback');
    return NextResponse.redirect(
      new URL('/auth/enphase/result?error=invalid_callback', request.url)
    );
  }

  try {
    // Decode and validate state
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const { userId, timestamp } = stateData;
    
    console.log('ENPHASE: Decoded state:', {
      userId: userId ? `${userId.substring(0, 10)}...XXXXXX` : null,
      timestamp: timestamp,
      age: Date.now() - timestamp,
      ageMinutes: Math.round((Date.now() - timestamp) / 60000)
    });

    // Check if state is not too old (15 minutes)
    if (Date.now() - timestamp > 15 * 60 * 1000) {
      const userDisplay = await getUserDisplay(userId);
      console.error('ENPHASE: State expired for user:', userDisplay);
      return NextResponse.redirect(
        new URL('/auth/enphase/result?error=state_expired', request.url)
      );
    }

    const userDisplay = await getUserDisplay(userId);
    console.log('ENPHASE: Processing callback for user:', userDisplay);

    // Exchange code for tokens
    const client = getEnphaseClient();
    
    // In mock mode, accept any code starting with "mock_"
    if (process.env.ENPHASE_USE_MOCK === 'true' || 
        (process.env.NODE_ENV === 'development' && code.startsWith('mock_'))) {
      console.log('ENPHASE: Using mock mode for callback');
    }
    
    const tokens = await client.exchangeCodeForTokens(code);

    // Log token response (mask sensitive data)
    console.log('ENPHASE: Tokens obtained:', {
      access_token: tokens.access_token ? `${tokens.access_token.substring(0, 20)}...XXXXXX` : null,
      refresh_token: tokens.refresh_token ? `${tokens.refresh_token.substring(0, 20)}...XXXXXX` : null,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      hasEnlUid: !!tokens.enl_uid
    });
    
    console.log('ENPHASE: Fetching systems from Enphase API');

    // Get user's Enphase systems
    const enphaseSystems = await client.getSystems(tokens.access_token);
    
    if (!enphaseSystems || enphaseSystems.length === 0) {
      console.error('ENPHASE: No systems found for user:', userDisplay);
      return NextResponse.redirect(
        new URL('/auth/enphase/result?error=no_systems', request.url)
      );
    }

    // Log all available systems
    console.log('ENPHASE: Found systems for user:', userDisplay);
    enphaseSystems.forEach((sys, index) => {
      console.log(`ENPHASE: System ${index + 1}:`, JSON.stringify(sys, null, 2));
    });

    // Use the first system (in future, allow user to select)
    const enphaseSystem = enphaseSystems[0];
    
    // Ensure system_id is a clean string without decimals
    // Enphase may return it as a number or string with decimal
    const cleanSystemId = String(enphaseSystem.system_id).replace(/\.0$/, '').split('.')[0];
    console.log('ENPHASE: Using system:', cleanSystemId, enphaseSystem.name, 
                '(raw value:', enphaseSystem.system_id, 'type:', typeof enphaseSystem.system_id, ')');

    // Store tokens in Clerk metadata with clean system ID
    await client.storeTokens(userId, tokens, cleanSystemId);

    // Check if system already exists in database
    const existingSystem = await db.select()
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, 'enphase'),
          eq(systems.vendorSiteId, cleanSystemId)
        )
      )
      .limit(1);

    if (existingSystem.length === 0) {
      // Create new system in database
      console.log('ENPHASE: Creating new system in database');
      
      // Calculate timezone offset from timezone string
      let timezoneOffsetMin = 600; // Default to AEST (UTC+10)
      if (enphaseSystem.timezone) {
        // This is simplified - in production, use a proper timezone library
        if (enphaseSystem.timezone.includes('Melbourne') || 
            enphaseSystem.timezone.includes('Sydney')) {
          timezoneOffsetMin = 600; // UTC+10
        }
        // Add more timezone mappings as needed
      }

      await db.insert(systems).values({
        ownerClerkUserId: userId,
        vendorType: 'enphase',
        vendorSiteId: cleanSystemId,
        status: 'active',
        displayName: enphaseSystem.name || 'Enphase System',
        model: 'Enphase IQ',
        solarSize: enphaseSystem.system_size ? `${(enphaseSystem.system_size / 1000).toFixed(1)} kW` : null,
        location: enphaseSystem.address || null,  // Store the address object directly
        timezoneOffsetMin: timezoneOffsetMin,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log('ENPHASE: System created successfully');
    } else {
      // Update existing system (reactivate if it was removed)
      console.log('ENPHASE: Updating existing system');
      
      await db.update(systems)
        .set({
          ownerClerkUserId: userId,
          displayName: enphaseSystem.name || existingSystem[0].displayName,
          location: enphaseSystem.address || existingSystem[0].location,  // Update location if available
          status: 'active',  // Reactivate the system if it was removed
          updatedAt: new Date()
        })
        .where(eq(systems.id, existingSystem[0].id));
    }

    console.log('ENPHASE: Connection complete for user:', userDisplay);
    console.log('ENPHASE: System successfully connected:', cleanSystemId);

    // Redirect to result page with success message
    const successUrl = new URL('/auth/enphase/result', request.url);
    successUrl.searchParams.set('status', 'success');
    successUrl.searchParams.set('message', `Successfully connected ${enphaseSystem.name || 'Enphase System'}`);
    
    return NextResponse.redirect(successUrl);
  } catch (error) {
    console.error('ENPHASE: Error in callback - Full details:', error);
    console.error('ENPHASE: Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    
    // Determine error message
    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('Invalid state')) {
        errorMessage = 'Invalid authorization state. Please try connecting again.';
      } else if (error.message.includes('No code')) {
        errorMessage = 'Authorization was denied or cancelled.';
      } else if (error.message.includes('token')) {
        errorMessage = 'Failed to obtain access token. Please try again.';
      } else if (error.message.includes('system')) {
        errorMessage = 'Failed to retrieve Enphase system information.';
      } else {
        errorMessage = error.message;
      }
    }
    
    const errorUrl = new URL('/auth/enphase/result', request.url);
    errorUrl.searchParams.set('status', 'error');
    errorUrl.searchParams.set('message', errorMessage);
    
    return NextResponse.redirect(errorUrl);
  }
}