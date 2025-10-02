import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { pointReadings, pointInfo } from '@/lib/db/schema-monitoring-points'
import { systems } from '@/lib/db/schema'
import { eq, desc, sql } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'
import { formatTimeAEST } from '@/lib/date-utils'
import { fromDate } from '@internationalized/date'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ systemId: string }> }
) {
  try {
    const { userId } = await auth()

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if user is admin
    const isAdmin = await isUserAdmin(userId)

    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { systemId: systemIdStr } = await params
    const systemId = parseInt(systemIdStr)
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '200'), 1000)

    // Get system timezone offset
    const [system] = await db
      .select()
      .from(systems)
      .where(eq(systems.id, systemId))
      .limit(1)

    if (!system) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 })
    }

    // Get all point info for this system
    const points = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, systemId))
      .orderBy(pointInfo.id)

    if (points.length === 0) {
      return NextResponse.json({
        headers: [],
        data: [],
        metadata: {
          systemId,
          timezoneOffsetMin: system.timezoneOffsetMin,
          pointCount: 0,
          rowCount: 0
        }
      })
    }

    // Build headers with metadata for each column
    const headers = [
      {
        key: 'timestamp',
        label: 'Time',
        type: 'datetime',
        unit: null,
        subsystem: null
      },
      ...points.map(p => ({
        key: `point_${p.id}`,
        label: p.name || p.defaultName,
        type: p.metricType,
        unit: p.metricUnit,
        subsystem: p.subsystem,
        pointId: p.pointId,
        pointSubId: p.pointSubId
      }))
    ]

    // Build dynamic SQL for pivot query
    const pivotColumns = points.map(p =>
      `MAX(CASE WHEN point_id = ${p.id} THEN value END) as point_${p.id}`
    ).join(',\n  ')

    // Query to get pivoted data - last N readings by unique timestamp
    const pivotQuery = `
      WITH recent_timestamps AS (
        SELECT DISTINCT measurement_time
        FROM point_readings pr
        INNER JOIN point_info pi ON pr.point_id = pi.id
        WHERE pi.system_id = ${systemId}
        ORDER BY measurement_time DESC
        LIMIT ${limit}
      )
      SELECT
        measurement_time,
        ${pivotColumns}
      FROM point_readings
      WHERE measurement_time IN (SELECT measurement_time FROM recent_timestamps)
      GROUP BY measurement_time
      ORDER BY measurement_time DESC
    `

    const result = await db.all(sql.raw(pivotQuery))

    // Transform the data to include ISO timestamps with AEST formatting
    const data = result.map((row: any) => {
      // Convert Unix timestamp (ms) to ZonedDateTime and format with AEST
      const zonedDate = fromDate(new Date(row.measurement_time), 'Australia/Brisbane')
      const formattedTime = formatTimeAEST(zonedDate)

      const transformed: any = {
        timestamp: formattedTime
      }

      // Add point values
      points.forEach(p => {
        const value = row[`point_${p.id}`]
        transformed[`point_${p.id}`] = value !== null ? Number(value) : null
      })

      return transformed
    })

    return NextResponse.json({
      headers,
      data,
      metadata: {
        systemId,
        timezoneOffsetMin: system.timezoneOffsetMin,
        pointCount: points.length,
        rowCount: data.length
      }
    })

  } catch (error) {
    console.error('Error fetching point readings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch point readings' },
      { status: 500 }
    )
  }
}