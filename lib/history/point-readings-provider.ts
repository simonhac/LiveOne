import { db } from '@/lib/db';
import { pointReadings, pointInfo, pointReadingsAgg5m } from '@/lib/db/schema-monitoring-points';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { CalendarDate, ZonedDateTime, fromDate, parseDate } from '@internationalized/date';
import { toUnixTimestamp, fromUnixTimestamp } from '@/lib/date-utils';
import { SystemWithPolling } from '@/lib/systems-manager';
import { HistoryDataProvider, MeasurementSeries, MeasurementPointMetadata, MeasurementValue, TimeSeriesPoint } from './types';

/**
 * Generate a point ID in the format:
 * {pointId}.{pointSubId}.{metricType}
 * (omitting pointSubId if it's null)
 *
 * Note: The vendor prefix (liveone.{vendorType}.{vendorSiteId}) is added by OpenNEMConverter
 */
function generatePointId(
  pointId: string,
  pointSubId: string | null,
  metricType: string
): string {
  const parts = [pointId];
  if (pointSubId) {
    parts.push(pointSubId);
  }
  parts.push(metricType);
  return parts.join('.');
}

export class PointReadingsProvider implements HistoryDataProvider {
  async getAvailableFields(system: SystemWithPolling): Promise<MeasurementPointMetadata[]> {
    // Fetch actual points from the database for this system
    const points = await db
      .select()
      .from(pointInfo)
      .where(eq(pointInfo.systemId, system.id));

    return points.map(p => ({
      id: generatePointId(p.pointId, p.pointSubId, p.metricType),
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
      pointId: p.pointId,
      pointSubId: p.pointSubId,
      name: p.name || p.defaultName,
      subsystem: p.subsystem,
      metricType: p.metricType,
      metricUnit: p.metricUnit
    }]));

    // Fetch aggregated point readings within the time range
    const aggregates = await db
      .select()
      .from(pointReadingsAgg5m)
      .where(and(
        eq(pointReadingsAgg5m.systemId, system.id),
        gte(pointReadingsAgg5m.intervalEnd, startMs),
        lte(pointReadingsAgg5m.intervalEnd, endMs)
      ))
      .orderBy(pointReadingsAgg5m.intervalEnd);

    // Group aggregates by point
    const pointSeriesMap = new Map<number, typeof aggregates>();

    for (const agg of aggregates) {
      if (!pointSeriesMap.has(agg.pointId)) {
        pointSeriesMap.set(agg.pointId, []);
      }
      pointSeriesMap.get(agg.pointId)!.push(agg);
    }

    // Convert to MeasurementSeries format - one series per point
    // Include all points, even those with no data
    const result: MeasurementSeries[] = [];

    for (const [pointId, pointMeta] of pointMap) {
      const data: TimeSeriesPoint[] = [];

      // Get aggregates for this point if they exist
      const pointAggregates = pointSeriesMap.get(pointId) || [];

      for (const agg of pointAggregates) {
        // Only include if we have valid aggregate data
        if (agg.avg !== null || agg.min !== null || agg.max !== null) {
          data.push({
            timestamp: fromUnixTimestamp(agg.intervalEnd / 1000, 600), // Use AEST timezone
            value: {
              avg: agg.avg,
              min: agg.min,
              max: agg.max,
              last: agg.last,
              count: agg.sampleCount
            }
          });
        }
      }

      // Always include series with metadata, even if no data
      const fieldId = generatePointId(
        pointMeta.pointId,
        pointMeta.pointSubId,
        pointMeta.metricType
      );

      result.push({
        field: fieldId,
        metadata: {
          id: fieldId,
          name: pointMeta.name,
          type: pointMeta.metricType,
          unit: pointMeta.metricUnit,
          subsystem: pointMeta.subsystem || undefined
        },
        data
      });
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