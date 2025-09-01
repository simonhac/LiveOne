import { NextRequest, NextResponse } from 'next/server';
import { aggregateYesterdayForAllSystems } from '@/lib/db/aggregate-daily';
import { db } from '@/lib/db';
import { readingsAgg1d } from '@/lib/db/schema';
import { isUserAdmin } from '@/lib/auth-utils';

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

// This endpoint will be called daily at 00:05 (5 minutes after midnight)
export async function GET(request: NextRequest) {
  try {
    // Validate cron request
    if (!validateCronRequest(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
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

// Allow manual triggering with POST (admin only)
export async function POST(request: NextRequest) {
  try {
    // Check if user is admin (isUserAdmin checks authentication internally)
    const userIsAdmin = await isUserAdmin();
    if (!userIsAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const { action, systemId, date, catchup } = body;

    if (action === 'clear') {
      // Clear the entire table and regenerate all historical data
      console.log('[Daily] Clearing readings_agg_1d table and regenerating...');
      
      // Clear the table
      await db.delete(readingsAgg1d).execute();
      console.log('[Daily] Table cleared');
      
      // Regenerate all missing days for all systems
      const { aggregateAllMissingDaysForAllSystems } = await import('@/lib/db/aggregate-daily');
      const results = await aggregateAllMissingDaysForAllSystems();
      
      return NextResponse.json({
        success: true,
        action: 'clear_and_regenerate',
        message: `Cleared and regenerated daily aggregations`,
        systems: results,
        timestamp: new Date().toISOString()
      });
    } else if (systemId && date) {
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
    } else if (catchup || action === 'catchup') {
      // Aggregate ALL missing days for ALL systems
      const { aggregateAllMissingDaysForAllSystems } = await import('@/lib/db/aggregate-daily');
      const results = await aggregateAllMissingDaysForAllSystems();
      
      return NextResponse.json({
        success: true,
        action: 'catchup',
        message: `Caught up all missing days for all systems`,
        systems: results
      });
    } else {
      // Run the daily aggregation for yesterday only
      console.log('[DEBUG] Using groupBy version - deployed', new Date().toISOString());
      const results = await aggregateYesterdayForAllSystems();
      
      return NextResponse.json({
        success: true,
        message: `Aggregated yesterday's data for ${results.length} systems (v2-groupBy)`,
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