import { NextResponse } from 'next/server'
import { isUserAdmin } from '@/lib/auth-utils'

export async function GET() {
  try {
    const isAdmin = await isUserAdmin()
    
    return NextResponse.json({
      success: true,
      isAdmin
    })
  } catch (error) {
    console.error('Error checking admin status:', error)
    return NextResponse.json({
      success: false,
      isAdmin: false
    })
  }
}