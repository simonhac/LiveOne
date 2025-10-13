import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> }
) {
  try {
    // Check if user is authenticated
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    // Check if user is admin
    const isAdmin = await isUserAdmin()
    
    if (!isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    
    const { systemId: systemIdStr } = await params
    const systemId = parseInt(systemIdStr)
    
    if (isNaN(systemId)) {
      return NextResponse.json({ error: 'Invalid system ID' }, { status: 400 })
    }
    
    // Get the updates from request body
    const body = await request.json()
    const { displayName, shortName } = body

    // Validate that at least one field is being updated
    if (displayName === undefined && shortName === undefined) {
      return NextResponse.json({ error: 'At least one field must be provided' }, { status: 400 })
    }

    // Validate displayName if provided
    if (displayName !== undefined) {
      if (typeof displayName !== 'string') {
        return NextResponse.json({ error: 'Display name must be a string' }, { status: 400 })
      }

      if (displayName.trim().length === 0) {
        return NextResponse.json({ error: 'Display name cannot be empty' }, { status: 400 })
      }

      if (displayName.length > 100) {
        return NextResponse.json({ error: 'Display name is too long (max 100 characters)' }, { status: 400 })
      }
    }

    // Validate shortName if provided
    if (shortName !== undefined && shortName !== null) {
      if (typeof shortName !== 'string') {
        return NextResponse.json({ error: 'Short name must be a string' }, { status: 400 })
      }

      // Empty string is treated as null (removing the short name)
      if (shortName.trim().length > 0) {
        if (!/^[a-zA-Z0-9_]+$/.test(shortName)) {
          return NextResponse.json({ error: 'Short name can only contain letters, digits, and underscores' }, { status: 400 })
        }

        if (shortName.length > 200) {
          return NextResponse.json({ error: 'Short name is too long (max 200 characters)' }, { status: 400 })
        }
      }
    }

    // Build the update object
    const updates: { displayName?: string; shortName?: string | null; updatedAt: Date } = {
      updatedAt: new Date()
    }

    if (displayName !== undefined) {
      updates.displayName = displayName.trim()
    }

    if (shortName !== undefined) {
      updates.shortName = shortName === null || shortName.trim().length === 0 ? null : shortName.trim()
    }

    // Update the system
    const result = await db
      .update(systems)
      .set(updates)
      .where(eq(systems.id, systemId))
      .returning()
    
    if (result.length === 0) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 })
    }
    
    return NextResponse.json({
      success: true,
      message: 'System updated successfully',
      system: {
        id: result[0].id,
        displayName: result[0].displayName,
        shortName: result[0].shortName
      }
    })

  } catch (error) {
    console.error('Error updating system:', error)

    // Check for unique constraint violation on shortName
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return NextResponse.json({
        success: false,
        error: 'UNIQUE constraint failed: short_name must be unique within vendor type',
      }, { status: 409 })
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to update system',
    }, { status: 500 })
  }
}