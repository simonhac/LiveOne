import { SystemWithPolling } from "@/lib/systems-manager";
import { CalendarDate, ZonedDateTime } from "@internationalized/date";
import { OpenNEMDataSeries } from "@/types/opennem";
import { HistoryProviderFactory } from "./provider-factory";
import { OpenNEMConverter } from "./opennem-converter";
import { aggregateToInterval } from "./aggregation";
import { MeasurementSeries } from "./types";

/**
 * Service for fetching historical data using the new abstraction
 */
export class HistoryService {
  /**
   * Fetch history data in OpenNEM format
   */
  static async getHistoryInOpenNEMFormat(
    system: SystemWithPolling,
    startTime: ZonedDateTime | CalendarDate,
    endTime: ZonedDateTime | CalendarDate,
    interval: "5m" | "30m" | "1d",
  ): Promise<OpenNEMDataSeries[]> {
    // Get the appropriate provider for this system
    const provider = HistoryProviderFactory.getProvider(system);

    let measurementSeries: MeasurementSeries[];

    // Fetch data based on interval
    switch (interval) {
      case "1d": {
        // Daily data
        const startDate = startTime as CalendarDate;
        const endDate = endTime as CalendarDate;
        measurementSeries = await provider.fetchDailyData(
          system,
          startDate,
          endDate,
        );
        break;
      }

      case "5m": {
        // 5-minute data
        const start = startTime as ZonedDateTime;
        const end = endTime as ZonedDateTime;
        measurementSeries = await provider.fetch5MinuteData(system, start, end);
        break;
      }

      case "30m": {
        // 30-minute data - fetch 5-minute and aggregate
        const start = startTime as ZonedDateTime;
        const end = endTime as ZonedDateTime;
        const fiveMinData = await provider.fetch5MinuteData(system, start, end);
        measurementSeries = aggregateToInterval(
          fiveMinData,
          30 * 60 * 1000,
          start,
          end,
        );
        break;
      }

      default:
        throw new Error(`Unsupported interval: ${interval}`);
    }

    // Extract field names dynamically from the returned data
    const seriesFields = measurementSeries.map((s) => s.field);

    // Convert to OpenNEM format
    return OpenNEMConverter.convertToOpenNEM(
      measurementSeries,
      seriesFields,
      interval,
      system,
      startTime,
      endTime,
    );
  }
}
