import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { rawClient } from "@/lib/db";

interface GeneratorEvent {
  date: string;
  startTime: string;
  endTime: string;
  minPowerKw: number;
  maxPowerKw: number;
  energyKwh: number;
  startTimeUnix?: number; // Used internally for energy calculation
  endTimeUnix?: number; // Used internally for energy calculation
}

/**
 * GET /api/system/{systemId}/generator-events
 *
 * Returns all generator events (times when grid import > 50W)
 * Groups consecutive readings within 120 seconds into events
 *
 * @param systemId - Numeric system ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Parse and validate systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    // Find the grid power point ID for this system
    const pointResult = await rawClient.execute({
      sql: `
        SELECT id
        FROM point_info
        WHERE system_id = ?
          AND metric_type = 'power'
          AND display_name = 'Grid'
        LIMIT 1
      `,
      args: [systemId],
    });

    if (pointResult.rows.length === 0) {
      return NextResponse.json({
        events: [],
        totalEnergyKwh: 0,
      });
    }

    const gridPowerPointId = Number(pointResult.rows[0].id);

    // Query generator events from point_readings
    // Note: measurement_time is in milliseconds, value is grid power in W
    const result = await rawClient.execute({
      sql: `
        SELECT
          measurement_time,
          value
        FROM point_readings
        WHERE system_id = ?
          AND point_id = ?
          AND value < -50
        ORDER BY measurement_time
      `,
      args: [systemId, gridPowerPointId],
    });

    // Group readings into events
    const events: GeneratorEvent[] = [];
    let currentEvent: {
      startTime: number;
      endTime: number;
      readings: Array<{ time: number; powerW: number }>;
    } | null = null;

    for (const row of result.rows) {
      const timeMs = Number(row.measurement_time);
      const time = Math.floor(timeMs / 1000); // Convert to seconds
      const powerW = Math.abs(Number(row.value));

      if (!currentEvent) {
        currentEvent = {
          startTime: time,
          endTime: time,
          readings: [{ time, powerW }],
        };
      } else {
        const timeSinceLast = time - currentEvent.endTime;

        if (timeSinceLast <= 120) {
          currentEvent.endTime = time;
          currentEvent.readings.push({ time, powerW });
        } else {
          events.push(formatEvent(currentEvent));
          currentEvent = {
            startTime: time,
            endTime: time,
            readings: [{ time, powerW }],
          };
        }
      }
    }

    if (currentEvent) {
      events.push(formatEvent(currentEvent));
    }

    // Calculate energy for each event
    // Get Import energy point for energy calculations
    const importPointResult = await rawClient.execute({
      sql: `
        SELECT id
        FROM point_info
        WHERE system_id = ?
          AND metric_type = 'energy'
          AND display_name = 'Import'
        LIMIT 1
      `,
      args: [systemId],
    });

    if (importPointResult.rows.length > 0) {
      const importPointId = Number(importPointResult.rows[0].id);

      // For each event, get energy at start and end
      for (const event of events) {
        const energyResult = await rawClient.execute({
          sql: `
            SELECT measurement_time, value
            FROM point_readings
            WHERE system_id = ?
              AND point_id = ?
              AND measurement_time >= ?
              AND measurement_time <= ?
            ORDER BY measurement_time
          `,
          args: [
            systemId,
            importPointId,
            event.startTimeUnix! * 1000,
            event.endTimeUnix! * 1000,
          ],
        });

        if (energyResult.rows.length >= 2) {
          const startEnergy = Number(energyResult.rows[0].value);
          const endEnergy = Number(
            energyResult.rows[energyResult.rows.length - 1].value,
          );
          event.energyKwh = Math.round((endEnergy - startEnergy) / 10) / 100; // Convert Wh to kWh
        }
      }
    }

    // Calculate total energy
    const totalEnergyKwh = events.reduce(
      (sum, event) => sum + event.energyKwh,
      0,
    );

    return NextResponse.json({
      events,
      totalEnergyKwh,
    });
  } catch (error) {
    console.error("Error fetching generator events:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}

function formatEvent(event: {
  startTime: number;
  endTime: number;
  readings: Array<{ time: number; powerW: number }>;
}): GeneratorEvent {
  // Convert to local time (UTC+10)
  const startDate = new Date((event.startTime + 10 * 3600) * 1000);
  const endDate = new Date((event.endTime + 10 * 3600) * 1000);

  // Format date as "DD MMM YYYY"
  const date = startDate.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  // Format times as "h:mm am/pm"
  const formatTime = (d: Date) => {
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const ampm = hours >= 12 ? "pm" : "am";
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
  };

  const startTime = formatTime(startDate);
  const endTime =
    event.startTime === event.endTime ? startTime : formatTime(endDate);

  // Calculate power range
  const powers = event.readings.map((r) => r.powerW);
  const minPowerKw = Math.round(Math.min(...powers) / 100) / 10;
  const maxPowerKw = Math.round(Math.max(...powers) / 100) / 10;

  return {
    date,
    startTime,
    endTime,
    minPowerKw,
    maxPowerKw,
    energyKwh: 0, // Will be calculated later from Import energy point
    startTimeUnix: event.startTime,
    endTimeUnix: event.endTime,
  };
}
