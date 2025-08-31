import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { isUserAdmin } from '@/lib/auth-utils'

export async function PATCH(
  request: NextRequest,
  { params }: { params: { systemId: string } }
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
    
    const systemId = parseInt(params.systemId)
    if (isNaN(systemId)) {
      return NextResponse.json({ error: 'Invalid system ID' }, { status: 400 })
    }
    
    const body = await request.json()
    const { status } = body
    
    // Validate status
    if (!status || !['active', 'disabled', 'removed'].includes(status)) {
      return NextResponse.json({ 
        error: 'Invalid status. Must be one of: active, disabled, removed' 
      }, { status: 400 })
    }
    
    // Update system status
    const updated = await db
      .update(systems)
      .set({ 
        status,
        updatedAt: new Date()
      })
      .where(eq(systems.id, systemId))
      .returning()
    
    if (updated.length === 0) {
      return NextResponse.json({ error: 'System not found' }, { status: 404 })
    }
    
    console.log(`System ${systemId} status changed to ${status} by admin ${userId}`)
    
    return NextResponse.json({
      success: true,
      system: updated[0],
      message: `System status updated to ${status}`
    })
    
  } catch (error) {
    console.error('Error updating system status:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to update system status'
    }, { status: 500 })
  }
}