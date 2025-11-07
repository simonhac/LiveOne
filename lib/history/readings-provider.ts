import { db } from "@/lib/db";
import { readingsAgg5m, readingsAgg1d } from "@/lib/db/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  CalendarDate,
  ZonedDateTime,
  parseDate,
} from "@internationalized/date";
import {
  toUnixTimestamp,
  fromUnixTimestamp,
  formatDateAEST,
} from "@/lib/date-utils";
import { SystemWithPolling } from "@/lib/systems-manager";
import {
  HistoryDataProvider,
  MeasurementSeries,
  MeasurementPointMetadata,
  MeasurementValue,
  TimeSeriesPoint,
} from "./types";

export class ReadingsProvider implements HistoryDataProvider {
  private readonly timezoneOffsetMin = 600; // Default to AEST (UTC+10)

  async fetch5MinuteData(
    system: SystemWithPolling,
    startTime: ZonedDateTime,
    endTime: ZonedDateTime,
  ): Promise<MeasurementSeries[]> {
    const startTimestamp = toUnixTimestamp(startTime);
    const endTimestamp = toUnixTimestamp(endTime);

    const data = await db
      .select()
      .from(readingsAgg5m)
      .where(
        and(
          eq(readingsAgg5m.systemId, system.id),
          gte(readingsAgg5m.intervalEnd, startTimestamp),
          lte(readingsAgg5m.intervalEnd, endTimestamp),
        ),
      )
      .orderBy(readingsAgg5m.intervalEnd);

    return this.transformToSeries5Min(data);
  }

  async fetchDailyData(
    system: SystemWithPolling,
    startDate: CalendarDate,
    endDate: CalendarDate,
  ): Promise<MeasurementSeries[]> {
    // Use the same approach as existing code - format dates as strings
    const startDateStr = formatDateAEST(startDate);
    const endDateStr = formatDateAEST(endDate);

    const data = await db
      .select()
      .from(readingsAgg1d)
      .where(
        and(
          eq(readingsAgg1d.systemId, system.id.toString()),
          gte(readingsAgg1d.day, startDateStr),
          lte(readingsAgg1d.day, endDateStr),
        ),
      )
      .orderBy(readingsAgg1d.day);

    return this.transformToSeriesDaily(data);
  }

  private transformToSeries5Min(
    rows: Array<typeof readingsAgg5m.$inferSelect>,
  ): MeasurementSeries[] {
    const series: MeasurementSeries[] = [];

    // Solar series
    const solarData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.solarWAvg !== null) {
        solarData.push({
          timestamp: fromUnixTimestamp(row.intervalEnd, 600),
          value: {
            avg: row.solarWAvg,
            min: row.solarWMin,
            max: row.solarWMax,
          },
        });
      }
    }
    // Always include series with metadata, even if no data
    series.push({
      field: "source.solar.total",
      metadata: {
        id: "source.solar.total.power.avg",
        label: "Solar (total)",
        type: "power",
        unit: "W",
        path: "source.solar.total",
      },
      data: solarData,
    });

    // Load series
    const loadData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.loadWAvg !== null) {
        loadData.push({
          timestamp: fromUnixTimestamp(row.intervalEnd, 600),
          value: {
            avg: row.loadWAvg,
            min: row.loadWMin,
            max: row.loadWMax,
          },
        });
      }
    }
    series.push({
      field: "load",
      metadata: {
        id: "load.power.avg",
        label: "Load",
        type: "power",
        unit: "W",
        path: "load",
      },
      data: loadData,
    });

    // Battery series
    const batteryData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.batteryWAvg !== null) {
        batteryData.push({
          timestamp: fromUnixTimestamp(row.intervalEnd, 600),
          value: {
            avg: row.batteryWAvg,
            min: row.batteryWMin,
            max: row.batteryWMax,
          },
        });
      }
    }
    series.push({
      field: "bidi.battery",
      metadata: {
        id: "bidi.battery.power.avg",
        label: "Battery",
        type: "power",
        unit: "W",
        path: "bidi.battery",
      },
      data: batteryData,
    });

    // Grid series
    const gridData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.gridWAvg !== null) {
        gridData.push({
          timestamp: fromUnixTimestamp(row.intervalEnd, 600),
          value: {
            avg: row.gridWAvg,
            min: row.gridWMin,
            max: row.gridWMax,
          },
        });
      }
    }
    series.push({
      field: "bidi.grid",
      metadata: {
        id: "bidi.grid.power.avg",
        label: "Grid",
        type: "power",
        unit: "W",
        path: "bidi.grid",
      },
      data: gridData,
    });

    // Battery SOC series
    const socData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.batterySOCLast !== null) {
        socData.push({
          timestamp: fromUnixTimestamp(row.intervalEnd, 600),
          value: {
            avg: row.batterySOCLast,
          },
        });
      }
    }
    series.push({
      field: "bidi.battery.soc",
      metadata: {
        id: "bidi.battery.soc.last",
        label: "Battery SOC",
        type: "percentage",
        unit: "%",
        path: "bidi.battery",
      },
      data: socData,
    });

    return series;
  }

  private transformToSeriesDaily(
    rows: Array<typeof readingsAgg1d.$inferSelect>,
  ): MeasurementSeries[] {
    const series: MeasurementSeries[] = [];

    // Solar energy series
    const solarEnergyData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.solarKwh !== null) {
        solarEnergyData.push({
          timestamp: parseDate(row.day),
          value: {
            avg: row.solarKwh,
          },
        });
      }
    }
    if (solarEnergyData.length > 0) {
      series.push({
        field: "solar_energy",
        metadata: {
          id: "solar.energy",
          label: "Total solar energy generated",
          type: "energy",
          unit: "kWh",
        },
        data: solarEnergyData,
      });
    }

    // Load energy series
    const loadEnergyData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.loadKwh !== null) {
        loadEnergyData.push({
          timestamp: parseDate(row.day),
          value: {
            avg: row.loadKwh,
          },
        });
      }
    }
    if (loadEnergyData.length > 0) {
      series.push({
        field: "load_energy",
        metadata: {
          id: "load.energy",
          label: "Total load energy consumed",
          type: "energy",
          unit: "kWh",
        },
        data: loadEnergyData,
      });
    }

    // Battery SOC average series
    const socAvgData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.batterySocAvg !== null) {
        socAvgData.push({
          timestamp: parseDate(row.day),
          value: {
            avg: row.batterySocAvg,
          },
        });
      }
    }
    if (socAvgData.length > 0) {
      series.push({
        field: "battery_soc_avg",
        metadata: {
          id: "battery.soc.avg",
          label: "Average battery state of charge",
          type: "percentage",
          unit: "%",
        },
        data: socAvgData,
      });
    }

    // Battery SOC min series
    const socMinData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.batterySocMin !== null) {
        socMinData.push({
          timestamp: parseDate(row.day),
          value: {
            avg: row.batterySocMin,
          },
        });
      }
    }
    if (socMinData.length > 0) {
      series.push({
        field: "battery_soc_min",
        metadata: {
          id: "battery.soc.min",
          label: "Minimum battery state of charge",
          type: "percentage",
          unit: "%",
        },
        data: socMinData,
      });
    }

    // Battery SOC max series
    const socMaxData: TimeSeriesPoint[] = [];
    for (const row of rows) {
      if (row.batterySocMax !== null) {
        socMaxData.push({
          timestamp: parseDate(row.day),
          value: {
            avg: row.batterySocMax,
          },
        });
      }
    }
    if (socMaxData.length > 0) {
      series.push({
        field: "battery_soc_max",
        metadata: {
          id: "battery.soc.max",
          label: "Maximum battery state of charge",
          type: "percentage",
          unit: "%",
        },
        data: socMaxData,
      });
    }

    return series;
  }
}
