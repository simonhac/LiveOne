import { NextResponse } from 'next/server'
import PollingManager from '@/lib/server/polling-manager'
import { SELECTLIVE_CONFIG } from '@/config'

const pollingManager = PollingManager.getInstance();

export async function GET(request: Request) {
  try {
    const userId = 'simon';
    const systemNumber = SELECTLIVE_CONFIG.systemNumber;
    
    const status = pollingManager.getDeviceStatus(userId, systemNumber);
    const data = pollingManager.getLatestData(userId, systemNumber);
    
    return NextResponse.json({
      success: true,
      polling: {
        isActive: status.isPolling,
        isAuthenticated: status.isAuthenticated,
        lastFetchTime: status.lastFetchTime,
        lastError: status.lastError,
      },
      data: data ? {
        batterySOC: data.batterySOC,
        solarW: data.solarW,
        loadW: data.loadW,
        timestamp: data.timestamp,
      } : null,
      server: {
        time: new Date(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
      }
    })
  } catch (error) {
    console.error('Status API Error:', error)
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 })
  }
}