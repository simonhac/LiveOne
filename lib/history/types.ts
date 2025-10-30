import { CalendarDate, ZonedDateTime } from "@internationalized/date";
import { SystemWithPolling } from "@/lib/systems-manager";

/**
 * Metadata for a measurement point/field
 */
export interface MeasurementPointMetadata {
  id: string; // Unique identifier for the point (e.g., "solar.power", "point_1")
  name: string; // Display name
  label?: string; // User-friendly label from point configuration
  type: string; // Metric type (e.g., "power", "energy", "percentage")
  unit: string; // Unit of measurement (e.g., "W", "kWh", "%")
}

/**
 * A single measurement value with statistics
 */
export interface MeasurementValue {
  avg: number | null;
  min?: number | null;
  max?: number | null;
  last?: number | null; // Last value in the interval (chronologically)
  count?: number; // Number of samples in this aggregation
}

/**
 * A single data point in a time series
 */
export interface TimeSeriesPoint {
  // Timestamp (end of interval)
  // CalendarDate for daily intervals, ZonedDateTime for minute intervals
  timestamp: CalendarDate | ZonedDateTime;

  // The measurement value (either a simple number or statistics)
  value: MeasurementValue;
}

/**
 * A complete measurement series for a single field
 */
export interface MeasurementSeries {
  // Field key (e.g., "solar", "load", "battery")
  field: string;

  // Metadata describing this measurement series
  metadata: MeasurementPointMetadata;

  // Array of time-series data points
  data: TimeSeriesPoint[];
}

/**
 * Common interface for all history data providers
 */
export interface HistoryDataProvider {
  /**
   * Fetch 5-minute interval data
   * Returns an array of MeasurementSeries, one per field
   */
  fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime,
  ): Promise<MeasurementSeries[]>;

  /**
   * Fetch daily interval data
   * Returns an array of MeasurementSeries, one per field
   */
  fetchDailyData(
    system: SystemWithPolling,
    startDate: CalendarDate,
    endDate: CalendarDate,
  ): Promise<MeasurementSeries[]>;
}
