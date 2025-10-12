import { MeasurementSeries } from './types';
import { OpenNEMDataSeries } from '@/types/opennem';
import { formatTimeAEST, formatDateAEST } from '@/lib/date-utils';
import { formatDataArray } from './format-opennem';
import { CalendarDate, ZonedDateTime } from '@internationalized/date';
import { toUnixTimestamp } from '@/lib/date-utils';

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
    interval: '5m' | '30m' | '1d',
    vendorType: string,
    vendorSiteId: string,
    requestedStartTime?: CalendarDate | ZonedDateTime,
    requestedEndTime?: CalendarDate | ZonedDateTime
  ): OpenNEMDataSeries[] {
    const remoteSystemIdentifier = `${vendorType}.${vendorSiteId}`;
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
      const series = measurementSeries.find(s => s.field === field);

      // If field not found in data, skip it
      if (!series) {
        continue;
      }

      // Format timestamps based on interval type
      let startStr: string;
      let lastStr: string;

      if (interval === '1d') {
        // Daily data uses CalendarDate
        startStr = formatDateAEST(startInterval as CalendarDate);
        lastStr = formatDateAEST(endInterval as CalendarDate);
      } else {
        // Minute data uses ZonedDateTime
        startStr = formatTimeAEST(startInterval as ZonedDateTime);
        lastStr = formatTimeAEST(endInterval as ZonedDateTime);
      }

      // Build complete data array with nulls for missing timestamps
      const fieldData: (number | null)[] = [];
      let dataIndex = 0;

      if (interval === '1d') {
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
              fieldData.push(dataPoint.value.avg);
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
        const intervalMs = interval === '5m' ? 5 * 60 * 1000 : 30 * 60 * 1000;

        const startMs = toUnixTimestamp(startTime) * 1000;
        const endMs = toUnixTimestamp(endTime) * 1000;

        // Calculate first and last interval boundaries
        const firstIntervalEnd = Math.floor(startMs / intervalMs) * intervalMs + intervalMs;
        const lastIntervalEnd = endMs % intervalMs === 0
          ? endMs
          : Math.floor(endMs / intervalMs) * intervalMs + intervalMs;

        // Walk through all expected intervals
        for (let expectedIntervalEnd = firstIntervalEnd; expectedIntervalEnd <= lastIntervalEnd; expectedIntervalEnd += intervalMs) {
          // Check if we have data for this interval
          if (dataIndex < series.data.length) {
            const dataPoint = series.data[dataIndex];
            const dataTimestamp = toUnixTimestamp(dataPoint.timestamp as ZonedDateTime) * 1000;
            const dataIntervalEnd = Math.floor(dataTimestamp / intervalMs) * intervalMs + intervalMs;

            if (dataIntervalEnd === expectedIntervalEnd) {
              // We have data for this interval
              fieldData.push(dataPoint.value.avg);
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

      // Use metadata from the series (required, never defaults)
      const metadata = series.metadata;
      const fieldId = metadata.id;
      const type = metadata.type;
      const units = metadata.unit;
      const description = metadata.name;

      dataSeries.push({
        id: `liveone.${remoteSystemIdentifier}.${fieldId}`,
        type,
        units,
        history: {
          start: startStr,
          last: lastStr,
          interval,
          data: formatDataArray(fieldData)
        },
        network: 'liveone',
        source: vendorType,
        description
      });
    }

    return dataSeries;
  }
}