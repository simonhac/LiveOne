import { NextRequest, NextResponse } from 'next/server';
import { DATABASE_CONFIG } from '@/config';

// Verify the request is from Vercel Cron
function validateCronRequest(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  
  // In production, Vercel sets CRON_SECRET
  if (process.env.CRON_SECRET) {
    return authHeader === `Bearer ${process.env.CRON_SECRET}`;
  }
  
  // In development, allow all requests
  return process.env.NODE_ENV === 'development';
}

export async function GET(request: NextRequest) {
  try {
    // Validate cron request
    if (!validateCronRequest(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('[Cleanup] Cleanup called but doing nothing for now');
    
    // For now, just return success without doing anything
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Cleanup disabled - no action taken',
      cleanup: {
        rawDataRetentionDays: DATABASE_CONFIG.retention.rawDataDays,
        deletedReadings: 0,
        deletedAggregates: 0
      }
    });
    
  } catch (error) {
    console.error('[Cleanup] Error:', error);
    return NextResponse.json(
      { 
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}