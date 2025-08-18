import { NextRequest, NextResponse } from 'next/server';
import { aggregateYesterdayForAllSystems } from '@/lib/db/aggregate-daily';
import { headers } from 'next/headers';

// This endpoint will be called daily at 00:05 (5 minutes after midnight)
export async function GET(request: NextRequest) {
  try {
    // Verify the request is from Vercel Cron (in production)
    if (process.env.NODE_ENV === 'production') {
      const headersList = await headers();
      const authHeader = headersList.get('authorization');
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    console.log('[Cron] Starting daily aggregation job');
    const startTime = Date.now();
    
    // Aggregate yesterday's data for all systems
    const results = await aggregateYesterdayForAllSystems();
    
    const duration = Date.now() - startTime;
    console.log(`[Cron] Daily aggregation completed in ${duration}ms`);
    
    return NextResponse.json({
      success: true,
      message: `Aggregated data for ${results.length} systems`,
      duration,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Cron] Daily aggregation failed:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}

// Allow manual triggering with POST (for testing)
export async function POST(request: NextRequest) {
  try {
    // Check for auth token in development/testing
    const authToken = request.cookies.get('auth-token')?.value;
    const validPassword = process.env.AUTH_PASSWORD;
    
    if (!validPassword || authToken !== validPassword) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { systemId, date, catchup } = body;

    if (systemId && date) {
      // Aggregate specific system and date
      const { aggregateDailyData } = await import('@/lib/db/aggregate-daily');
      const result = await aggregateDailyData(systemId, date);
      
      return NextResponse.json({
        success: true,
        message: `Aggregated data for system ${systemId} on ${date}`,
        data: result
      });
    } else if (systemId) {
      // Aggregate all missing days for a specific system
      const { aggregateAllDailyData } = await import('@/lib/db/aggregate-daily');
      const results = await aggregateAllDailyData(systemId);
      
      return NextResponse.json({
        success: true,
        message: `Aggregated ${results.length} days for system ${systemId}`,
        count: results.length
      });
    } else if (catchup) {
      // Aggregate ALL missing days for ALL systems
      const { aggregateAllMissingDaysForAllSystems } = await import('@/lib/db/aggregate-daily');
      const results = await aggregateAllMissingDaysForAllSystems();
      
      return NextResponse.json({
        success: true,
        message: `Caught up all missing days for all systems`,
        systems: results
      });
    } else {
      // Run the daily aggregation for yesterday only
      const results = await aggregateYesterdayForAllSystems();
      
      return NextResponse.json({
        success: true,
        message: `Aggregated yesterday's data for ${results.length} systems`,
        count: results.length
      });
    }
  } catch (error) {
    console.error('[Cron] Manual aggregation failed:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}