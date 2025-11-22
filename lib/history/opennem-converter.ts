import { MeasurementSeries } from "./types";
import { OpenNEMDataSeries } from "@/types/opennem";
import { formatTimeAEST, formatDateAEST } from "@/lib/date-utils";
import { formatDataArray } from "./format-opennem";
import { CalendarDate, ZonedDateTime } from "@internationalized/date";
import { toUnixTimestamp } from "@/lib/date-utils";
import { SystemWithPolling } from "@/lib/systems-manager";
import { buildSeriesId, buildSiteIdFromSystem } from "@/lib/series-path-utils";

/**
 * Converts MeasurementSeries data to OpenNEM format
 * This is a pure format converter - no data transformation
 */
export class OpenNEMConverter {
  /**
   * Convert measurement series to OpenNEM data series format
   */
  static convertToOpenNEM(
    measurementSeries: MeasurementSeries[],
    fields: string[],
    interval: "5m" | "30m" | "1d",
    system: SystemWithPolling,
    requestedStartTime?: CalendarDate | ZonedDateTime,
    requestedEndTime?: CalendarDate | ZonedDateTime,
  ): OpenNEMDataSeries[] {
    // Build siteId from system (uses shortname if available, otherwise system.{id})
    const siteId = buildSiteIdFromSystem(system);
    const dataSeries: OpenNEMDataSeries[] = [];

    // Determine the actual time range to use
    let startInterval: CalendarDate | ZonedDateTime | undefined;
    let endInterval: CalendarDate | ZonedDateTime | undefined;

    if (requestedStartTime && requestedEndTime) {
      startInterval = requestedStartTime;
      endInterval = requestedEndTime;
    } else if (measurementSeries.length > 0) {
      // Find the earliest and latest timestamps across all series
      let earliestTimestamp: CalendarDate | ZonedDateTime | undefined;
      let latestTimestamp: CalendarDate | ZonedDateTime | undefined;

      for (const series of measurementSeries) {
        if (series.data.length > 0) {
          const firstPoint = series.data[0].timestamp;
          const lastPoint = series.data[series.data.length - 1].timestamp;

          if (!earliestTimestamp) {
            earliestTimestamp = firstPoint;
            latestTimestamp = lastPoint;
          }
          // Since we're processing homogeneous data (all same type within a request),
          // we can just keep the earliest/latest we find
        }
      }

      startInterval = earliestTimestamp;
      endInterval = latestTimestamp;
    }

    if (!startInterval || !endInterval) {
      // No data and no requested times - return empty array
      return [];
    }

    // Process each requested field
    for (const field of fields) {
      // Find the series for this field
      const series = measurementSeries.find((s) => s.field === field);

      // If field not found in data, skip it
      if (!series) {
        continue;
      }

      // Format timestamps based on interval type
      let startStr: string;
      let lastStr: string;

      if (interval === "1d") {
        // Daily data uses CalendarDate
        startStr = formatDateAEST(startInterval as CalendarDate);
        lastStr = formatDateAEST(endInterval as CalendarDate);
      } else {
        // Minute data uses ZonedDateTime
        startStr = formatTimeAEST(startInterval as ZonedDateTime);
        lastStr = formatTimeAEST(endInterval as ZonedDateTime);
      }

      // Get metadata early to check for energy.delta series
      const metadata = series.metadata;

      // Build complete data array with nulls for missing timestamps
      const fieldData: (number | null)[] = [];
      let dataIndex = 0;

      if (interval === "1d") {
        // Daily intervals
        const startDate = startInterval as CalendarDate;
        const endDate = endInterval as CalendarDate;

        // Walk through all expected dates
        let currentDate = startDate;
        while (currentDate.compare(endDate) <= 0) {
          // Check if we have data for this date
          if (dataIndex < series.data.length) {
            const dataPoint = series.data[dataIndex];
            const dataDate = dataPoint.timestamp as CalendarDate;

            if (dataDate.compare(currentDate) === 0) {
              // We have data for this date
              // For energy.delta series, use delta value; otherwise use avg
              const value = metadata.id.endsWith("/energy.delta")
                ? dataPoint.value.delta
                : dataPoint.value.avg;
              fieldData.push(value ?? null);
              dataIndex++;
            } else {
              // No data for this date
              fieldData.push(null);
            }
          } else {
            // No more data points
            fieldData.push(null);
          }

          // Move to next day
          currentDate = currentDate.add({ days: 1 });
        }
      } else {
        // Minute intervals (5m or 30m)
        const startTime = startInterval as ZonedDateTime;
        const endTime = endInterval as ZonedDateTime;
        const intervalMs = interval === "5m" ? 5 * 60 * 1000 : 30 * 60 * 1000;

        const startMs = toUnixTimestamp(startTime) * 1000;
        const endMs = toUnixTimestamp(endTime) * 1000;

        // Calculate first and last interval boundaries
        // If startMs is already on a boundary, use it; otherwise round up to next boundary
        const firstIntervalEnd =
          startMs % intervalMs === 0
            ? startMs
            : Math.floor(startMs / intervalMs) * intervalMs + intervalMs;
        const lastIntervalEnd =
          endMs % intervalMs === 0
            ? endMs
            : Math.floor(endMs / intervalMs) * intervalMs + intervalMs;

        // Walk through all expected intervals
        for (
          let expectedIntervalEnd = firstIntervalEnd;
          expectedIntervalEnd <= lastIntervalEnd;
          expectedIntervalEnd += intervalMs
        ) {
          // Check if we have data for this interval
          if (dataIndex < series.data.length) {
            const dataPoint = series.data[dataIndex];
            const dataTimestamp =
              toUnixTimestamp(dataPoint.timestamp as ZonedDateTime) * 1000;

            // Data from aggregated tables is already aligned to interval boundaries,
            // so we just use it directly. Only round for raw data that might be off-boundary.
            const dataIntervalEnd = dataTimestamp;

            if (dataIntervalEnd === expectedIntervalEnd) {
              // We have data for this interval
              // For energy.delta series, use delta value; otherwise use avg
              const value = metadata.id.endsWith("/energy.delta")
                ? dataPoint.value.delta
                : dataPoint.value.avg;
              fieldData.push(value ?? null);
              dataIndex++;
            } else {
              // No data for this interval
              fieldData.push(null);
            }
          } else {
            // No more data points
            fieldData.push(null);
          }
        }
      }

      // Extract field details from metadata (already defined above)
      const fieldId = metadata.id;
      const type = metadata.type;
      const units = metadata.unit;
      const label = metadata.label;
      const path = metadata.path;

      // Build series ID: split fieldId into pointPath and pointFlavour
      // fieldId format is {pointPath}/{pointFlavour}
      const [pointPath, pointFlavour] = fieldId.split("/");
      const seriesId = buildSeriesId(siteId, pointPath, pointFlavour);

      dataSeries.push({
        id: seriesId,
        type,
        units,
        history: {
          firstInterval: startStr,
          lastInterval: lastStr,
          interval,
          numIntervals: fieldData.length,
          data: formatDataArray(fieldData),
        },
        network: "liveone",
        source: system.vendorType,
        label,
        ...(path && { path }),
      });
    }

    return dataSeries;
  }
}
