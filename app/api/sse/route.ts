import { NextRequest } from 'next/server';
import PollingManager from '@/lib/server/polling-manager';
import SessionManager from '@/lib/session-manager';
import { USER_TO_SYSTEM } from '@/config';

const pollingManager = PollingManager.getInstance();
const sessionManager = SessionManager.getInstance();

export async function GET(request: NextRequest) {
  // Create a ReadableStream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      
      // Send initial connection message
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date() })}\n\n`)
      );

      // Function to send SSE message
      const sendMessage = (data: any) => {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send initial data
      const systems = [];
      const sessionSummary = sessionManager.getSessionSummary();
      
      for (const [userEmail, systemConfig] of Object.entries(USER_TO_SYSTEM)) {
        const systemNumber = systemConfig.systemNumber;
        const userId = userEmail.split('@')[0];
        
        const data = pollingManager.getLatestData(userId, systemNumber);
        const status = pollingManager.getDeviceStatus(userId, systemNumber);
        const systemInfo = pollingManager.getSystemInfo(userId, systemNumber);
        
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
          systemInfo: systemInfo || null,
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

      sendMessage({
        type: 'update',
        systems,
        totalSystems: systems.length,
        activeSessions: Array.from(sessionSummary.values()).reduce(
          (sum, u) => sum + u.activeSessions, 0
        ),
        timestamp: new Date(),
      });

      // Set up polling manager listener
      const updateHandler = (deviceKey: string, data: any) => {
        // Rebuild systems data on each update
        const systems = [];
        const sessionSummary = sessionManager.getSessionSummary();
        
        for (const [userEmail, systemConfig] of Object.entries(USER_TO_SYSTEM)) {
          const systemNumber = systemConfig.systemNumber;
          const userId = userEmail.split('@')[0];
          
          const data = pollingManager.getLatestData(userId, systemNumber);
          const status = pollingManager.getDeviceStatus(userId, systemNumber);
          const systemInfo = pollingManager.getSystemInfo(userId, systemNumber);
          
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
            systemInfo: systemInfo || null,
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

        sendMessage({
          type: 'update',
          systems,
          totalSystems: systems.length,
          activeSessions: Array.from(sessionSummary.values()).reduce(
            (sum, u) => sum + u.activeSessions, 0
          ),
          timestamp: new Date(),
        });
      };

      // Listen for updates from polling manager
      pollingManager.on('dataUpdate', updateHandler);

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        sendMessage({ type: 'heartbeat', timestamp: new Date() });
      }, 30000);

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        pollingManager.off('dataUpdate', updateHandler);
        clearInterval(heartbeatInterval);
        controller.close();
      });
    },
  });

  // Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}