import { SystemWithPolling } from "@/lib/systems-manager";
import { CalendarDate, ZonedDateTime } from "@internationalized/date";
import { OpenNEMDataSeries } from "@/types/opennem";
import { HistoryProviderFactory } from "./provider-factory";
import { OpenNEMConverter } from "./opennem-converter";
import { aggregateToInterval } from "./aggregation";
import { MeasurementSeries } from "./types";

/**
 * Series patterns that should be included when matchLegacy=true
 * These correspond to what the legacy ReadingsProvider returns
 */
const LEGACY_SERIES_PATTERNS = {
  "5m": [
    /^source\.solar\.power\.avg$/,
    /^load\.power\.avg$/,
    /^bidi\.battery\.power\.avg$/,
    /^bidi\.grid\.power\.avg$/,
    /^bidi\.battery\.soc\.last$/,
  ],
  "30m": [
    /^source\.solar\.power\.avg$/,
    /^load\.power\.avg$/,
    /^bidi\.battery\.power\.avg$/,
    /^bidi\.grid\.power\.avg$/,
    /^bidi\.battery\.soc\.last$/,
  ],
  "1d": [
    /^source\.solar\.energy\.delta$/,
    /^load\.energy\.delta$/,
    /^bidi\.battery\.soc\.avg$/,
    /^bidi\.battery\.soc\.min$/,
    /^bidi\.battery\.soc\.max$/,
  ],
};

/**
 * Service for fetching historical data using the new abstraction
 */
export class HistoryService {
  /**
   * Fetch history data in OpenNEM format
   * @param matchLegacy - If true, filters output to only include series that legacy provider would return
   */
  static async getHistoryInOpenNEMFormat(
    system: SystemWithPolling,
    startTime: ZonedDateTime | CalendarDate,
    endTime: ZonedDateTime | CalendarDate,
    interval: "5m" | "30m" | "1d",
    matchLegacy = false,
  ): Promise<{ series: OpenNEMDataSeries[]; dataSource: string }> {
    // Get the point readings provider (now the only provider)
    const provider = HistoryProviderFactory.getProvider();

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

    // Filter series if matchLegacy is enabled
    if (matchLegacy) {
      const patterns = LEGACY_SERIES_PATTERNS[interval];
      measurementSeries = measurementSeries.filter((series) => {
        // Check if the series metadata ID matches any legacy pattern
        const seriesId = series.metadata.id;
        return patterns.some((pattern) => pattern.test(seriesId));
      });
    }

    // Extract field names dynamically from the returned data
    const seriesFields = measurementSeries.map((s) => s.field);

    // Convert to OpenNEM format
    const series = OpenNEMConverter.convertToOpenNEM(
      measurementSeries,
      seriesFields,
      interval,
      system,
      startTime,
      endTime,
    );

    // Get the data source from the provider
    const dataSource = provider.getDataSource(interval);

    return { series, dataSource };
  }
}
