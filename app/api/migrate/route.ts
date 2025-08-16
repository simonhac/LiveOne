import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export async function GET(request: Request) {
  try {
    // Check if last_response column exists
    const tableInfo = await db.all(sql`PRAGMA table_info(polling_status)`);
    const hasLastResponse = tableInfo.some((col: any) => col.name === 'last_response');
    
    if (!hasLastResponse) {
      // Add the column
      await db.run(sql`ALTER TABLE polling_status ADD COLUMN last_response TEXT`);
      
      return NextResponse.json({
        success: true,
        message: 'Added last_response column to polling_status table'
      });
    } else {
      return NextResponse.json({
        success: true,
        message: 'last_response column already exists'
      });
    }
  } catch (error) {
    console.error('Migration error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}