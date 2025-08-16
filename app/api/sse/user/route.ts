import { NextRequest } from 'next/server';
import PollingManager from '@/lib/server/polling-manager';
import { SELECTLIVE_CONFIG } from '@/config';

const pollingManager = PollingManager.getInstance();

export async function GET(request: NextRequest) {
  // In production, verify user session here
  const userId = 'simon';
  const systemNumber = SELECTLIVE_CONFIG.systemNumber;
  
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
      const data = pollingManager.getLatestData(userId, systemNumber);
      const status = pollingManager.getDeviceStatus(userId, systemNumber);
      const systemInfo = pollingManager.getSystemInfo(userId, systemNumber);
      
      sendMessage({
        type: 'update',
        data: data,
        timestamp: new Date(),
        systemInfo: systemInfo,
        status: {
          isPolling: status.isPolling,
          isAuthenticated: status.isAuthenticated,
          lastFetchTime: status.lastFetchTime,
          lastError: status.lastError,
        }
      });

      // Set up polling manager listener
      const updateHandler = (event: any) => {
        // Check if this update is for our user/system
        if (event.key === `${userId}:${systemNumber}`) {
          const data = pollingManager.getLatestData(userId, systemNumber);
          const status = pollingManager.getDeviceStatus(userId, systemNumber);
          const systemInfo = pollingManager.getSystemInfo(userId, systemNumber);
          
          sendMessage({
            type: 'update',
            data: data,
            timestamp: new Date(),
            systemInfo: systemInfo,
            status: {
              isPolling: status.isPolling,
              isAuthenticated: status.isAuthenticated,
              lastFetchTime: status.lastFetchTime,
              lastError: status.lastError,
            }
          });
        }
      };

      // Listen for updates from polling manager
      pollingManager.on('data', updateHandler);

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        sendMessage({ type: 'heartbeat', timestamp: new Date() });
      }, 30000);

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        pollingManager.off('data', updateHandler);
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