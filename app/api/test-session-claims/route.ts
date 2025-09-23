import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

export async function GET(request: NextRequest) {
  try {
    // Get the full auth object including session claims
    const authResult = await auth()
    
    if (!authResult.userId) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    
    // Check if session claims contain the admin flag
    const hasAdminClaim = authResult.sessionClaims && 'isPlatformAdmin' in authResult.sessionClaims
    const isAdminFromClaims = authResult.sessionClaims?.isPlatformAdmin === true
    
    // Also check using the isUserAdmin function to compare
    const { isUserAdmin } = await import('@/lib/auth-utils')
    const isAdminFromFunction = await isUserAdmin(authResult.userId)
    
    return NextResponse.json({
      userId: authResult.userId,
      sessionClaims: authResult.sessionClaims,
      hasAdminClaim,
      isAdminFromClaims,
      isAdminFromFunction,
      claimsMatch: isAdminFromClaims === isAdminFromFunction,
      timestamp: new Date().toISOString(),
      note: hasAdminClaim 
        ? '✅ Session claims are configured correctly!' 
        : '❌ Session claims not found - may need to sign out and back in for new token'
    })
    
  } catch (error) {
    console.error('Error testing session claims:', error)
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 })
  }
}