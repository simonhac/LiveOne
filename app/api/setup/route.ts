import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/db'
import { systems, userSystems } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export async function POST(request: Request) {
  try {
    // Get the authenticated user's Clerk ID
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({
        success: false,
        error: 'Unauthorized',
      }, { status: 401 })
    }

    const body = await request.json()
    const { systemNumber } = body

    if (!systemNumber) {
      return NextResponse.json({
        success: false,
        error: 'System number is required',
      }, { status: 400 })
    }

    // Check if this system exists (vendor type + site ID is the unique combination)
    const [existingSystem] = await db.select()
      .from(systems)
      .where(
        and(
          eq(systems.vendorType, 'select.live'),
          eq(systems.vendorSiteId, systemNumber)
        )
      )
      .limit(1)

    if (existingSystem) {
      // Check if user already has access to this system
      const [existingAccess] = await db.select()
        .from(userSystems)
        .where(
          and(
            eq(userSystems.clerkUserId, userId),
            eq(userSystems.systemId, existingSystem.id)
          )
        )
        .limit(1)

      if (existingAccess) {
        return NextResponse.json({
          success: true,
          message: 'You already have access to this system',
          systemId: existingSystem.id,
          role: existingAccess.role,
        })
      }

      // Add user to this existing system as a viewer
      await db.insert(userSystems)
        .values({
          clerkUserId: userId,
          systemId: existingSystem.id,
          role: 'viewer', // New users get viewer role by default
          createdAt: new Date(),
          updatedAt: new Date(),
        })

      return NextResponse.json({
        success: true,
        message: 'System linked to your account as viewer',
        systemId: existingSystem.id,
        role: 'viewer',
      })
    } else {
      // Create a new system entry
      const [newSystem] = await db.insert(systems)
        .values({
          ownerClerkUserId: userId, // Set the creator as the owner who will hold credentials
          vendorType: 'select.live',
          vendorSiteId: systemNumber,
          displayName: `System ${systemNumber}`,
          timezoneOffsetMin: 600, // Default to AEST (10 hours * 60)
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()

      // Add the user as owner of this new system
      await db.insert(userSystems)
        .values({
          clerkUserId: userId,
          systemId: newSystem.id,
          role: 'owner', // Creator gets owner role
          createdAt: new Date(),
          updatedAt: new Date(),
        })

      return NextResponse.json({
        success: true,
        message: 'System created and linked to your account as owner',
        systemId: newSystem.id,
        role: 'owner',
      })
    }
  } catch (error) {
    console.error('Setup error:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to setup system',
    }, { status: 500 })
  }
}

// GET endpoint to list all systems the user has access to
export async function GET(request: Request) {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({
        success: false,
        error: 'Unauthorized',
      }, { status: 401 })
    }

    // Get all systems this user has access to
    const userSystemRecords = await db.select()
      .from(userSystems)
      .innerJoin(systems, eq(systems.id, userSystems.systemId))
      .where(eq(userSystems.clerkUserId, userId))

    return NextResponse.json({
      success: true,
      systems: userSystemRecords.map(record => ({
        id: record.systems.id,
        vendorType: record.systems.vendorType,
        vendorSiteId: record.systems.vendorSiteId,
        displayName: record.systems.displayName,
        role: record.user_systems.role,
        joinedAt: record.user_systems.createdAt,
      })),
      count: userSystemRecords.length,
    })
  } catch (error) {
    console.error('Get systems error:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to get systems',
    }, { status: 500 })
  }
}