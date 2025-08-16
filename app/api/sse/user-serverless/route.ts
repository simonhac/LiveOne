import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { readings, systems, pollingStatus } from '@/lib/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { SELECTLIVE_CONFIG } from '@/config';

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

      // Function to fetch and send latest data
      const sendLatestData = async () => {
        try {
          // Get system from database
          const [system] = await db.select()
            .from(systems)
            .where(eq(systems.systemNumber, systemNumber))
            .limit(1);
          
          if (!system) {
            sendMessage({
              type: 'error',
              message: 'System not found',
              timestamp: new Date()
            });
            return;
          }

          // Get latest reading
          const [latestReading] = await db.select()
            .from(readings)
            .where(eq(readings.systemId, system.id))
            .orderBy(desc(readings.inverterTime))
            .limit(1);

          // Get polling status
          const [status] = await db.select()
            .from(pollingStatus)
            .where(eq(pollingStatus.systemId, system.id))
            .limit(1);

          if (latestReading) {
            // Convert reading to API format
            const data = {
              timestamp: latestReading.inverterTime.toISOString(),
              solarPower: latestReading.solarPower,
              solarInverterPower: latestReading.solarInverterPower,
              shuntPower: latestReading.shuntPower,
              loadPower: latestReading.loadPower,
              batteryPower: latestReading.batteryPower,
              batterySOC: latestReading.batterySOC,
              gridPower: latestReading.gridPower,
              faultCode: latestReading.faultCode,
              faultTimestamp: latestReading.faultTimestamp,
              generatorStatus: latestReading.generatorStatus,
              solarKwhTotal: latestReading.solarKwhTotal,
              loadKwhTotal: latestReading.loadKwhTotal,
              batteryInKwhTotal: latestReading.batteryInKwhTotal,
              batteryOutKwhTotal: latestReading.batteryOutKwhTotal,
              gridInKwhTotal: latestReading.gridInKwhTotal,
              gridOutKwhTotal: latestReading.gridOutKwhTotal,
              // Calculate today's values (would need to query for start of day)
              solarKwhToday: 0, // TODO: Calculate from database
              loadKwhToday: 0,
              batteryInKwhToday: 0,
              batteryOutKwhToday: 0,
              gridInKwhToday: 0,
              gridOutKwhToday: 0,
            };

            sendMessage({
              type: 'update',
              data: data,
              timestamp: new Date(),
              systemInfo: system.systemInfo,
              status: {
                isPolling: status?.isActive || false,
                isAuthenticated: status?.isAuthenticated || false,
                lastFetchTime: status?.lastPollTime?.toISOString() || null,
                lastError: status?.lastError || null,
              }
            });
          } else {
            sendMessage({
              type: 'update',
              data: null,
              timestamp: new Date(),
              systemInfo: system.systemInfo,
              status: {
                isPolling: status?.isActive || false,
                isAuthenticated: status?.isAuthenticated || false,
                lastFetchTime: status?.lastPollTime?.toISOString() || null,
                lastError: status?.lastError || 'No data available',
              }
            });
          }
        } catch (error) {
          console.error('[SSE] Error fetching data:', error);
          sendMessage({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date()
          });
        }
      };

      // Send initial data
      await sendLatestData();

      // Set up periodic updates (every 30 seconds)
      const interval = setInterval(async () => {
        await sendLatestData();
      }, 30000);

      // Set up heartbeat
      const heartbeat = setInterval(() => {
        sendMessage({ type: 'heartbeat', timestamp: new Date() });
      }, 15000);

      // Clean up on disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}