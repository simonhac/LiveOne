import { NextResponse } from 'next/server'
import PollingManager from '@/lib/server/polling-manager'
import { SELECTLIVE_CONFIG } from '@/config'

// Get the polling manager instance
const pollingManager = PollingManager.getInstance();

export async function GET(request: Request) {
  try {
    // In production, you'd verify the user's session here
    // For MVP, we're using hardcoded user
    const userId = 'simon';
    const systemNumber = SELECTLIVE_CONFIG.systemNumber;
    
    // Get latest data from polling manager
    const data = pollingManager.getLatestData(userId, systemNumber);
    const status = pollingManager.getDeviceStatus(userId, systemNumber);
    
    if (data) {
      return NextResponse.json({
        success: true,
        data: data,
        timestamp: status.lastFetchTime || new Date(),
        status: {
          isPolling: status.isPolling,
          isAuthenticated: status.isAuthenticated,
        }
      })
    } else if (status.lastError) {
      return NextResponse.json({
        success: false,
        error: status.lastError,
        timestamp: new Date(),
        status: {
          isPolling: status.isPolling,
          isAuthenticated: status.isAuthenticated,
        }
      }, { status: 503 })
    } else {
      // No data yet, might be first request
      return NextResponse.json({
        success: false,
        error: 'No data available yet. Polling service may be starting up.',
        timestamp: new Date(),
        status: {
          isPolling: status.isPolling,
          isAuthenticated: status.isAuthenticated,
        }
      }, { status: 503 })
    }
    
  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
      timestamp: new Date(),
    }, { status: 500 })
  }
}