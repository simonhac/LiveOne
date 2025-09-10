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
    
    // Get the new display name from request body
    const body = await request.json()
    const { displayName } = body
    
    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json({ error: 'Display name is required' }, { status: 400 })
    }
    
    if (displayName.trim().length === 0) {
      return NextResponse.json({ error: 'Display name cannot be empty' }, { status: 400 })
    }
    
    if (displayName.length > 100) {
      return NextResponse.json({ error: 'Display name is too long (max 100 characters)' }, { status: 400 })
    }
    
    // Update the system display name
    const result = await db
      .update(systems)
      .set({ 
        displayName: displayName.trim(),
        updatedAt: new Date()
      })
      .where(eq(systems.id, systemId))
      .returning()
    
    if (result.length === 0) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 })
    }
    
    return NextResponse.json({
      success: true,
      message: 'System renamed successfully',
      system: {
        id: result[0].id,
        displayName: result[0].displayName
      }
    })
    
  } catch (error) {
    console.error('Error renaming system:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to rename system',
    }, { status: 500 })
  }
}