import { NextRequest, NextResponse } from 'next/server';
import PollingManager from '@/lib/server/polling-manager';
import SessionManager from '@/lib/session-manager';
import { USER_TO_SYSTEM } from '@/config';

const pollingManager = PollingManager.getInstance();
const sessionManager = SessionManager.getInstance();

export async function GET(request: NextRequest) {
  try {
    // For MVP, we're not checking auth properly
    // In production, verify admin role from session/JWT
    
    // Get all registered systems
    const systems = [];
    
    // Get session summary
    const sessionSummary = sessionManager.getSessionSummary();
    
    // For each registered user system
    for (const [userEmail, systemConfig] of Object.entries(USER_TO_SYSTEM)) {
      const systemNumber = systemConfig.systemNumber;
      const userId = userEmail.split('@')[0]; // Simple user ID from email
      
      // Get latest data from polling manager
      const data = pollingManager.getLatestData(userId, systemNumber);
      const status = pollingManager.getDeviceStatus(userId, systemNumber);
      
      // Get session info for this user
      const userSession = sessionSummary.get(userEmail) || {
        email: userEmail,
        displayName: userId,
        lastLogin: null,
        isLoggedIn: false,
        activeSessions: 0,
      };
      
      systems.push({
        owner: userEmail,
        displayName: userSession.displayName,
        systemNumber: systemNumber,
        lastLogin: userSession.lastLogin,
        isLoggedIn: userSession.isLoggedIn,
        activeSessions: userSession.activeSessions,
        polling: {
          isActive: status.isPolling,
          isAuthenticated: status.isAuthenticated,
          lastPollTime: status.lastFetchTime,
          lastError: status.lastError,
        },
        data: data ? {
          solarPower: data.solarPower,
          loadPower: data.loadPower,
          batteryPower: data.batteryPower,
          batterySOC: data.batterySOC,
          gridPower: data.gridPower,
          timestamp: data.timestamp,
        } : null,
      });
    }
    
    return NextResponse.json({
      success: true,
      systems,
      totalSystems: systems.length,
      activeSessions: Array.from(sessionSummary.values()).reduce(
        (sum, u) => sum + u.activeSessions, 0
      ),
      timestamp: new Date(),
    });
    
  } catch (error) {
    console.error('Admin API Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal server error',
    }, { status: 500 });
  }
}