import { NextResponse } from 'next/server'
import PollingManager from '@/lib/server/polling-manager'

const pollingManager = PollingManager.getInstance();

export async function POST(request: Request) {
  try {
    // Start polling
    await pollingManager.start();
    
    return NextResponse.json({
      success: true,
      message: 'Polling started',
    })
  } catch (error) {
    console.error('Failed to start polling:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to start polling',
    }, { status: 500 })
  }
}