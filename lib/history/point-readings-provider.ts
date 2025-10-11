import { db } from '@/lib/db';
import { pointReadings, pointInfo, pointReadingsAgg5m } from '@/lib/db/schema-monitoring-points';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { CalendarDate, ZonedDateTime, fromDate, parseDate } from '@internationalized/date';
import { toUnixTimestamp, fromUnixTimestamp } from '@/lib/date-utils';
import { SystemWithPolling } from '@/lib/systems-manager';
import { HistoryDataProvider, MeasurementSeries, MeasurementPointMetadata, MeasurementValue, TimeSeriesPoint } from './types';

export class PointReadingsProvider implements HistoryDataProvider {
  async getAvailableFields(system: SystemWithPolling): Promise<MeasurementPointMetadata[]> {
    // Fetch actual points from the database for this system
    const points = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, system.id));

    return points.map(p => ({
      id: `point_${p.id}`,
      name: p.name || p.defaultName,
      type: p.metricType,
      unit: p.metricUnit,
      subsystem: p.subsystem || undefined
    }));
  }

  async fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime
  ): Promise<MeasurementSeries[]> {
    const startMs = toUnixTimestamp(startTime) * 1000;
    const endMs = toUnixTimestamp(endTime) * 1000;

    // Get all points for this system
    const points = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, system.id));

    if (points.length === 0) {
      return [];
    }

    // Map point IDs to their metadata
    const pointMap = new Map(points.map(p => [p.id, {
      name: p.name || p.defaultName,
      subsystem: p.subsystem,
      metricType: p.metricType,
      metricUnit: p.metricUnit
    }]));

    // Fetch raw point readings within the time range
    const readings = await db
      .select()
      .from(pointReadings)
      .where(and(
        inArray(pointReadings.pointId, points.map(p => p.id)),
        gte(pointReadings.measurementTime, startMs),
        lte(pointReadings.measurementTime, endMs)
      ))
      .orderBy(pointReadings.measurementTime);

    // Group readings by point and then by 5-minute intervals
    const pointSeriesMap = new Map<number, Map<number, number[]>>();

    for (const reading of readings) {
      // Round down to nearest 5-minute interval, then add 5 minutes for interval end
      const intervalEnd = Math.floor(reading.measurementTime / (5 * 60 * 1000)) * (5 * 60 * 1000) + (5 * 60 * 1000);

      if (!pointSeriesMap.has(reading.pointId)) {
        pointSeriesMap.set(reading.pointId, new Map());
      }

      const intervalMap = pointSeriesMap.get(reading.pointId)!;
      if (!intervalMap.has(intervalEnd)) {
        intervalMap.set(intervalEnd, []);
      }

      if (reading.value !== null) {
        intervalMap.get(intervalEnd)!.push(reading.value);
      }
    }

    // Convert to MeasurementSeries format - one series per point
    const result: MeasurementSeries[] = [];

    for (const [pointId, intervalMap] of pointSeriesMap) {
      const pointMeta = pointMap.get(pointId);
      if (!pointMeta) continue;

      const data: TimeSeriesPoint[] = [];
      const sortedIntervals = Array.from(intervalMap.keys()).sort((a, b) => a - b);

      for (const intervalEndMs of sortedIntervals) {
        const values = intervalMap.get(intervalEndMs)!;
        if (values.length === 0) continue;

        // Calculate statistics for this interval
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);

        data.push({
          timestamp: fromUnixTimestamp(intervalEndMs / 1000, 600), // Use AEST timezone
          value: {
            avg,
            min,
            max,
            count: values.length
          }
        });
      }

      if (data.length > 0) {
        result.push({
          field: `point_${pointId}`,
          metadata: {
            id: `point_${pointId}`,
            name: pointMeta.name,
            type: pointMeta.metricType,
            unit: pointMeta.metricUnit,
            subsystem: pointMeta.subsystem || undefined
          },
          data
        });
      }
    }

    return result;
  }

  async fetchDailyData(
    system: SystemWithPolling,
    startDate: CalendarDate,
    endDate: CalendarDate
  ): Promise<MeasurementSeries[]> {
    // Convert dates to ZonedDateTime for the full day range
    const startTime = new ZonedDateTime(
      startDate.year,
      startDate.month,
      startDate.day,
      'Australia/Brisbane',
      0, 0, 0
    );
    const endTime = new ZonedDateTime(
      endDate.year,
      endDate.month,
      endDate.day,
      'Australia/Brisbane',
      23, 59, 59
    );

    // Get 5-minute data
    const fiveMinSeries = await this.fetch5MinuteData(system, startTime, endTime);

    // Aggregate each series to daily
    const result: MeasurementSeries[] = [];

    for (const series of fiveMinSeries) {
      // Group points by day
      const dayMap = new Map<string, TimeSeriesPoint[]>();

      for (const point of series.data) {
        // Get the date in YYYY-MM-DD format from ZonedDateTime
        const zdt = point.timestamp as ZonedDateTime;
        const dayKey = `${zdt.year.toString().padStart(4, '0')}-${zdt.month.toString().padStart(2, '0')}-${zdt.day.toString().padStart(2, '0')}`;

        if (!dayMap.has(dayKey)) {
          dayMap.set(dayKey, []);
        }
        dayMap.get(dayKey)!.push(point);
      }

      // Aggregate each day
      const dailyData: TimeSeriesPoint[] = [];
      const sortedDays = Array.from(dayMap.keys()).sort();

      for (const dayKey of sortedDays) {
        const dayPoints = dayMap.get(dayKey)!;
        if (dayPoints.length === 0) continue;

        // Extract values
        const values = dayPoints.map(p => p.value).filter(v => v !== undefined);

        if (values.length > 0) {
          const avgs = values.filter(v => v.avg !== null).map(v => v.avg!);
          const mins = values.filter(v => v.min !== null && v.min !== undefined).map(v => v.min!);
          const maxs = values.filter(v => v.max !== null && v.max !== undefined).map(v => v.max!);

          dailyData.push({
            timestamp: parseDate(dayKey),
            value: {
              avg: avgs.length > 0 ? avgs.reduce((sum, v) => sum + v, 0) / avgs.length : null,
              min: mins.length > 0 ? Math.min(...mins) : undefined,
              max: maxs.length > 0 ? Math.max(...maxs) : undefined
            }
          });
        }
      }

      if (dailyData.length > 0) {
        result.push({
          field: series.field,
          metadata: series.metadata,
          data: dailyData
        });
      }
    }

    return result;
  }

}