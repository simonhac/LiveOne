import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { DATABASE_CONFIG } from '@/config';
import * as schema from './schema';

// Determine database type based on config
const isProduction = process.env.NODE_ENV === 'production';
const isTurso = DATABASE_CONFIG.url.startsWith('libsql://');

// Create database instance based on environment
export const db = (() => {
  if (isTurso || isProduction) {
    // Use Turso in production or if explicitly configured
    const client = createClient({
      url: DATABASE_CONFIG.turso.url || DATABASE_CONFIG.url,
      authToken: DATABASE_CONFIG.turso.authToken,
    });
    return drizzle(client, { schema });
  } else {
    // Use local SQLite in development
    const sqliteDb = new Database(DATABASE_CONFIG.url.replace('file:', ''));
    
    // Enable WAL mode for better concurrent access
    sqliteDb.pragma('journal_mode = WAL');
    
    return drizzleSqlite(sqliteDb, { schema });
  }
})();

// Export schema and types
export * from './schema';
export { schema };

// Database utility functions
export const dbUtils = {
  /**
   * Check if database is connected and working
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple query to test connection
      await db.select().from(schema.systems).limit(1);
      return true;
    } catch (error) {
      console.error('[DB] Health check failed:', error);
      return false;
    }
  },

  /**
   * Get database statistics
   */
  async getStats() {
    const systemCount = await db.select({ count: sql`count(*)` }).from(schema.systems);
    const readingCount = await db.select({ count: sql`count(*)` }).from(schema.readings);
    const latestReading = await db.select()
      .from(schema.readings)
      .orderBy(desc(schema.readings.inverterTime))
      .limit(1);
    
    return {
      systems: systemCount[0]?.count || 0,
      readings: readingCount[0]?.count || 0,
      latestReading: latestReading[0]?.inverterTime || null,
    };
  },

  /**
   * Clean up old data based on retention policy
   */
  async cleanupOldData(): Promise<void> {
    const retentionDays = DATABASE_CONFIG.retention.rawDataDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    try {
      // Delete old raw readings
      await db.delete(schema.readings)
        .where(lt(schema.readings.inverterTime, cutoffDate));
      
      // Delete old hourly aggregates (keep for 1 year)
      const aggregateCutoff = new Date();
      aggregateCutoff.setDate(aggregateCutoff.getDate() - DATABASE_CONFIG.retention.aggregatedDataDays);
      
      await db.delete(schema.hourlyAggregates)
        .where(lt(schema.hourlyAggregates.hourStart, aggregateCutoff));
      
      console.log(`[DB] Cleaned up data older than ${retentionDays} days`);
    } catch (error) {
      console.error('[DB] Cleanup failed:', error);
    }
  },
};

// Import required Drizzle functions
import { sql, desc, lt } from 'drizzle-orm';