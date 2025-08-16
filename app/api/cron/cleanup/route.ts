import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readings, hourlyAggregates } from '@/lib/db/schema';
import { lt, sql } from 'drizzle-orm';
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

    console.log('[Cleanup] Starting database cleanup...');
    
    const retentionDays = DATABASE_CONFIG.retention.rawDataDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    // Delete old raw readings
    const deleteResult = await db.delete(readings)
      .where(lt(readings.inverterTime, cutoffDate));
    
    // Get count of deleted rows (if available)
    const deletedCount = (deleteResult as any).rowsAffected || 0;
    
    // Delete old hourly aggregates (keep for 1 year)
    const aggregateCutoff = new Date();
    aggregateCutoff.setDate(aggregateCutoff.getDate() - DATABASE_CONFIG.retention.aggregatedDataDays);
    
    const aggregateResult = await db.delete(hourlyAggregates)
      .where(lt(hourlyAggregates.hourStart, aggregateCutoff));
    
    const aggregateDeletedCount = (aggregateResult as any).rowsAffected || 0;
    
    // Get database stats
    const readingCount = await db.select({ 
      count: sql<number>`count(*)` 
    }).from(readings);
    
    const oldestReading = await db.select({
      date: readings.inverterTime
    })
    .from(readings)
    .orderBy(readings.inverterTime)
    .limit(1);
    
    console.log(`[Cleanup] Deleted ${deletedCount} old readings, ${aggregateDeletedCount} old aggregates`);
    console.log(`[Cleanup] Database now has ${readingCount[0].count} readings`);
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      cleanup: {
        rawDataRetentionDays: retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        deletedReadings: deletedCount,
        deletedAggregates: aggregateDeletedCount
      },
      stats: {
        totalReadings: readingCount[0].count,
        oldestReading: oldestReading[0]?.date?.toISOString() || null
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