import { MeasurementSeries } from './types';
import { OpenNEMDataSeries } from '@/types/opennem';
import { formatTimeAEST, formatDateAEST } from '@/lib/date-utils';
import { formatDataArray } from '@/lib/format-opennem';
import { CalendarDate, ZonedDateTime } from '@internationalized/date';

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
    if (measurementSeries.length === 0) {
      return [];
    }

    const remoteSystemIdentifier = `${vendorType}.${vendorSiteId}`;
    const dataSeries: OpenNEMDataSeries[] = [];

    // Process each requested field
    for (const field of fields) {
      // Find the series for this field
      const series = measurementSeries.find(s => s.field === field);

      if (!series || series.data.length === 0) {
        continue; // Skip if no data for this field
      }

      // Get start and end times
      const firstDataInterval = series.data[0].timestamp;
      const lastDataInterval = series.data[series.data.length - 1].timestamp;

      // Use requested times if provided, otherwise use data boundaries
      const startInterval = requestedStartTime || firstDataInterval;
      const endInterval = requestedEndTime || lastDataInterval;

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

      // Extract the data values
      const fieldData = series.data.map(point => point.value.avg);

      // Calculate how many nulls to pad if we have a requested end time
      let paddingCount = 0;
      if (requestedEndTime && series.data.length > 0) {
        if (interval === '1d') {
          // For daily intervals, count days
          // Simple day difference calculation - not critical for now
          paddingCount = 0;
        } else {
          // For minute intervals, count intervals
          const lastDataMs = (lastDataInterval as ZonedDateTime).toDate().getTime();
          const requestedMs = (requestedEndTime as ZonedDateTime).toDate().getTime();
          const intervalMs = interval === '5m' ? 5 * 60 * 1000 : 30 * 60 * 1000;
          paddingCount = Math.floor((requestedMs - lastDataMs) / intervalMs);
        }
      }

      // Add null padding to match requested time range
      for (let i = 0; i < paddingCount; i++) {
        fieldData.push(null);
      }

      // Only create series if we have some non-null data
      if (fieldData.some(v => v !== null)) {
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
    }

    return dataSeries;
  }
}