// OpenNEM data format types

interface OpenNEMHistoryData {
  firstInterval: string; // e.g., "2025-08-09T00:00:00"
  lastInterval: string; // e.g., "2025-08-16T12:00:00"
  interval: string; // e.g., "1m", "1d", "1w", "1M"
  numIntervals: number; // Number of intervals in the data array
  data: (number | string | null)[]; // Support strings for quality fields
}

export interface OpenNEMDataSeries {
  id: string;
  type: string;
  units: string;
  history: OpenNEMHistoryData;
  network?: string;
  source?: string;
  label?: string;
  note?: string;
  path?: string; // Point path in format type.subtype.extension (e.g., "source.solar", "bidi.battery", "load")
}
