import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { pointInfo } from '@/lib/db/schema-monitoring-points'
import { eq } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pointId: string }> }
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

    const { pointId: pointIdStr } = await params
    const pointId = parseInt(pointIdStr)

    if (isNaN(pointId)) {
      return NextResponse.json({ error: 'Invalid point ID' }, { status: 400 })
    }

    const body = await request.json()
    const { subsystem, name } = body

    // Validate that at least one field is provided
    if (subsystem === undefined && name === undefined) {
      return NextResponse.json(
        { error: 'At least one field (subsystem or name) must be provided' },
        { status: 400 }
      )
    }

    // Build the update object
    const updates: any = {}
    if (subsystem !== undefined) {
      updates.subsystem = subsystem || null
    }
    if (name !== undefined) {
      updates.name = name || null
    }

    // Update the point info
    await db
      .update(pointInfo)
      .set(updates)
      .where(eq(pointInfo.id, pointId))

    // Fetch and return the updated point info
    const [updatedPoint] = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.id, pointId))

    if (!updatedPoint) {
      return NextResponse.json({ error: 'Point not found' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      point: {
        id: updatedPoint.id,
        pointId: updatedPoint.pointId,
        pointSubId: updatedPoint.pointSubId,
        subsystem: updatedPoint.subsystem,
        defaultName: updatedPoint.defaultName,
        name: updatedPoint.name,
        metricType: updatedPoint.metricType,
        metricUnit: updatedPoint.metricUnit
      }
    })

  } catch (error) {
    console.error('Error updating point info:', error)
    return NextResponse.json(
      { error: 'Failed to update point info' },
      { status: 500 }
    )
  }
}
