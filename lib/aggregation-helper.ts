import { db } from "./db";
import { readingsAgg5m, readings } from "./db/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { formatTimeAEST, fromUnixTimestamp } from "./date-utils";

/**
 * Updates the 5-minute aggregated data for a specific interval
 * Called after inserting a new reading
 */
export async function updateAggregatedData(
  systemId: number,
  readingTime: Date,
): Promise<void> {
  try {
    // Calculate the 5-minute interval end time
    const intervalMs = 5 * 60 * 1000;
    const intervalEnd = new Date(
      Math.ceil(readingTime.getTime() / intervalMs) * intervalMs,
    );
    const intervalStart = new Date(intervalEnd.getTime() - intervalMs);

    // Fetch all readings in this 5-minute interval
    const intervalReadings = await db
      .select()
      .from(readings)
      .where(
        and(
          eq(readings.systemId, systemId),
          gte(readings.inverterTime, intervalStart),
          lte(readings.inverterTime, intervalEnd),
        ),
      )
      .orderBy(readings.inverterTime);

    if (intervalReadings.length === 0) {
      return; // No readings to aggregate
    }

    // Get the last reading (for state values)
    const lastReading = intervalReadings[intervalReadings.length - 1];

    // Calculate aggregated values
    const solarWValues = intervalReadings
      .map((r) => r.solarW)
      .filter((v) => v !== null);
    const loadWValues = intervalReadings
      .map((r) => r.loadW)
      .filter((v) => v !== null);
    const batteryWValues = intervalReadings
      .map((r) => r.batteryW)
      .filter((v) => v !== null);
    const gridWValues = intervalReadings
      .map((r) => r.gridW)
      .filter((v) => v !== null);

    // Helper functions for rounding
    const roundToInteger = (val: number | null): number | null =>
      val !== null ? Math.round(val) : null;

    const roundToThree = (val: number | null): number | null =>
      val !== null ? Math.round(val * 1000) / 1000 : null;

    const roundToOne = (val: number | null): number | null =>
      val !== null ? Math.round(val * 10) / 10 : null;

    const aggregatedData = {
      systemId,
      intervalEnd: Math.floor(intervalEnd.getTime() / 1000), // Convert to Unix timestamp (seconds)

      // Power values (Watts) - round to integers
      solarWAvg: roundToInteger(
        solarWValues.length > 0
          ? solarWValues.reduce((a, b) => a + b, 0) / solarWValues.length
          : null,
      ),
      solarWMin: roundToInteger(
        solarWValues.length > 0 ? Math.min(...solarWValues) : null,
      ),
      solarWMax: roundToInteger(
        solarWValues.length > 0 ? Math.max(...solarWValues) : null,
      ),

      loadWAvg: roundToInteger(
        loadWValues.length > 0
          ? loadWValues.reduce((a, b) => a + b, 0) / loadWValues.length
          : null,
      ),
      loadWMin: roundToInteger(
        loadWValues.length > 0 ? Math.min(...loadWValues) : null,
      ),
      loadWMax: roundToInteger(
        loadWValues.length > 0 ? Math.max(...loadWValues) : null,
      ),

      batteryWAvg: roundToInteger(
        batteryWValues.length > 0
          ? batteryWValues.reduce((a, b) => a + b, 0) / batteryWValues.length
          : null,
      ),
      batteryWMin: roundToInteger(
        batteryWValues.length > 0 ? Math.min(...batteryWValues) : null,
      ),
      batteryWMax: roundToInteger(
        batteryWValues.length > 0 ? Math.max(...batteryWValues) : null,
      ),

      gridWAvg: roundToInteger(
        gridWValues.length > 0
          ? gridWValues.reduce((a, b) => a + b, 0) / gridWValues.length
          : null,
      ),
      gridWMin: roundToInteger(
        gridWValues.length > 0 ? Math.min(...gridWValues) : null,
      ),
      gridWMax: roundToInteger(
        gridWValues.length > 0 ? Math.max(...gridWValues) : null,
      ),

      // Battery SOC (percentage) - round to 1 decimal place
      batterySOCLast: roundToOne(lastReading.batterySOC),

      // Energy counters (kWh) - round to 3 decimal places
      solarKwhTotalLast: roundToThree(lastReading.solarKwhTotal),
      loadKwhTotalLast: roundToThree(lastReading.loadKwhTotal),
      batteryInKwhTotalLast: roundToThree(lastReading.batteryInKwhTotal),
      batteryOutKwhTotalLast: roundToThree(lastReading.batteryOutKwhTotal),
      gridInKwhTotalLast: roundToThree(lastReading.gridInKwhTotal),
      gridOutKwhTotalLast: roundToThree(lastReading.gridOutKwhTotal),

      sampleCount: intervalReadings.length,
    };

    // Upsert the aggregated data
    await db
      .insert(readingsAgg5m)
      .values(aggregatedData)
      .onConflictDoUpdate({
        target: [readingsAgg5m.systemId, readingsAgg5m.intervalEnd],
        set: aggregatedData,
      });

    // Use AEST timezone (600 min offset) for logging
    const intervalEndUnix = Math.floor(intervalEnd.getTime() / 1000);
    console.log(
      `[Aggregation] Updated 5m aggregate for interval ending ${formatTimeAEST(fromUnixTimestamp(intervalEndUnix, 600))}`,
    );
  } catch (error) {
    console.error("[Aggregation] Error updating aggregated data:", error);
    // Don't throw - we don't want aggregation failures to break the main polling
  }
}
