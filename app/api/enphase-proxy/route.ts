import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getValidEnphaseToken } from '@/lib/vendors/enphase/enphase-auth';

// WARNING: This endpoint has no access controls and is for debugging only
// TODO: Remove or secure before production use

export async function GET(request: NextRequest) {
  return handleRequest(request, 'GET');
}

export async function POST(request: NextRequest) {
  return handleRequest(request, 'POST');
}

async function handleRequest(request: NextRequest, defaultMethod: string) {
  try {
    // Get parameters from URL params or body
    const searchParams = request.nextUrl.searchParams;
    let systemId = searchParams.get('systemId');
    let method = searchParams.get('method');
    let url = searchParams.get('url');

    // Also check body for POST requests
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        systemId = systemId || body.systemId;
        method = method || body.method;
        url = url || body.url;
      } catch (e) {
        // Body might not be JSON
      }
    }

    // Default method if not specified
    method = method || defaultMethod;

    if (!systemId || !url) {
      return NextResponse.json({
        error: 'Missing required parameters',
        usage: 'Provide systemId and url as query params or in POST body',
        example: '/api/enphase-proxy?systemId=3&url=/api/v4/systems/{systemId}/summary'
      }, { status: 400 });
    }
    
    // Get system details
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, parseInt(systemId)))
      .limit(1);
    
    if (!system) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 });
    }
    
    if (system.vendorType !== 'enphase') {
      return NextResponse.json({ error: 'System is not an Enphase system' }, { status: 400 });
    }
    
    if (!system.ownerClerkUserId) {
      return NextResponse.json({ error: 'System has no owner' }, { status: 400 });
    }
    
    // Get valid access token (handles refresh if needed)
    let accessToken: string;
    try {
      const authResult = await getValidEnphaseToken(
        system.ownerClerkUserId,
        system.id,
        system.vendorSiteId
      );
      accessToken = authResult.accessToken;
    } catch (error) {
      return NextResponse.json({
        error: 'Authentication failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, { status: 401 });
    }
    
    // Replace {systemId} in URL with actual vendor site ID
    const finalUrl = url.replace('{systemId}', system.vendorSiteId);
    
    // Build full URL if it's a path
    const fullUrl = finalUrl.startsWith('http') 
      ? finalUrl 
      : `https://api.enphaseenergy.com${finalUrl.startsWith('/') ? '' : '/'}${finalUrl}`;
    
    console.log(`[ENPHASE-PROXY] ${method} ${fullUrl}`);
    
    // Make the request to Enphase
    const response = await fetch(fullUrl, {
      method: method.toUpperCase(),
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'key': process.env.ENPHASE_API_KEY || ''
      }
    });
    
    // Get response text first to preserve it
    const responseText = await response.text();
    
    // Try to parse as JSON
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      responseData = responseText;
    }
    
    // Return the response with metadata
    return NextResponse.json({
      request: {
        method: method.toUpperCase(),
        url: fullUrl,
        systemId: system.id,
        vendorSiteId: system.vendorSiteId
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[ENPHASE-PROXY] Error:', error);
    return NextResponse.json({
      error: 'Proxy request failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}